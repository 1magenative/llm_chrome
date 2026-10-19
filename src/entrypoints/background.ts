import { browser, defineBackground } from '#imports';
import systemTemplate from '@/prompts/system.md?raw';
import { newBoundary, type TabInfo } from '@/lib/agent/prompt';
import { resumeTask, sameUrl, type RunCheckpoint } from '@/lib/agent/queue';
import { hiddenNamesFor, type SiteNote } from '@/lib/agent/site-notes';
import { AgentRunner, type Observation, type RunConfig } from '@/lib/agent/runner';
import type { StepEvent } from '@/lib/agent/step';
import { TERMINAL_STATUSES, type RunState } from '@/lib/agent/types';
import { ALERT_NOTIFICATION_ID, alertHuman } from '@/lib/alert';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from '@/lib/checkpoint';
import { startKeepAlive } from '@/lib/keepalive';
import { chatStream, describeError } from '@/lib/llm/client';
import {
  addDeferred,
  exportRun,
  getDeferred,
  getStepDetail,
  listDeferred,
  listRuns,
  loadRun,
  pruneDeferred,
  pruneRuns,
  saveRun,
  saveStep,
  setDeferredStatus,
} from '@/lib/log/db';
import { postLog } from '@/lib/log/remote';
import { isBackgroundRequest, type BackgroundRequest, type Result, type RunInfo, type UiEvent } from '@/lib/messages';
import { DebuggerSessions } from '@/lib/exec/debugger';
import { activeTab, isRestrictedUrl, observePage, setHighlight } from '@/lib/perception';
import { activeProfile, loadSettings, type ProfileId, type Settings } from '@/lib/settings';
import { executeAction, normalizeNavigateUrl, waitForTabLoad, type AgentTab, type ExecContext } from '@/lib/tab-actions';

let current: { runner: AgentRunner; tab: AgentTab } | null = null;
/** Запуск, прерванный перезапуском браузера/воркера, ждёт «Продолжить» в панели. */
let interrupted: { checkpoint: RunCheckpoint; state: RunState } | null = null;

function broadcast(msg: UiEvent): void {
  // Если панель закрыта, получателя нет — это не ошибка.
  browser.runtime.sendMessage(msg).catch(() => {});
}

function runInfo(): RunInfo | null {
  if (current) return { state: current.runner.state, interrupted: false };
  if (interrupted) return { state: interrupted.state, interrupted: true };
  return null;
}

const broadcastRun = () => {
  const info = runInfo();
  if (info) broadcast({ type: 'ui:run-state', info });
};

/** Токены приходят десятками в секунду — склеиваем дельты и шлём в UI не чаще 10 раз в секунду. */
function throttledProgress(): (e: StepEvent) => void {
  let pending: Extract<StepEvent, { phase: 'delta' }> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending) broadcast({ type: 'ui:step-progress', event: pending });
    pending = null;
  };
  return (e) => {
    if (e.phase !== 'delta') {
      flush();
      broadcast({ type: 'ui:step-progress', event: e });
      return;
    }
    if (pending && pending.attempt === e.attempt) {
      pending = { ...pending, content: pending.content + e.content, reasoning: pending.reasoning + e.reasoning };
    } else {
      flush();
      pending = e;
    }
    timer ??= setTimeout(flush, 100);
  };
}

async function observeAgentTab(tab: AgentTab, maxChars: number, highlight: boolean, siteNotes: SiteNote[]): Promise<Observation> {
  const t = await browser.tabs.get(tab.tabId).catch(() => null);
  if (!t) throw new Error('Вкладка, в которой работал агент, закрыта.');
  const tabs: TabInfo[] = (await browser.tabs.query({ windowId: tab.windowId }))
    .filter((x) => x.id !== undefined)
    .map((x) => ({ id: x.id!, title: x.title ?? '', url: x.url ?? '', active: x.id === tab.tabId }));
  const url = t.url ?? '';
  if (!url || isRestrictedUrl(url)) {
    // Новая вкладка, chrome:// — читать нельзя, но модель должна понять, что надо перейти на сайт.
    return {
      observation: `URL: ${url || 'about:blank'}\nTitle: ${t.title ?? ''}\n\nThis page cannot be read or controlled by the extension. Use navigate to open a website.`,
      tabs,
      handle: { frames: [], owner: {}, nodes: [] },
      url,
    };
  }
  const obs = await observePage(tab.tabId, url, { maxChars, highlight, hide: hiddenNamesFor(url, siteNotes) });
  return { observation: obs.text, tabs, handle: obs.handle, url };
}

function runConfig(settings: Settings, task: string, overrides: Partial<RunConfig> = {}): RunConfig {
  const profile = activeProfile(settings);
  return {
    task: task.trim(),
    systemTemplate,
    boundary: newBoundary(),
    maxSteps: settings.agent.maxSteps,
    maxActions: settings.agent.maxActionsPerStep,
    loopThreshold: settings.agent.loopThreshold,
    autoScrollAfter: settings.agent.autoScrollAfter,
    stepTimeoutSec: settings.agent.stepTimeoutSec,
    approveEachStep: settings.agent.approveEachStep,
    contextTokens: profile.contextTokens,
    maxOutputTokens: profile.maxOutputTokens,
    profileLabel: profile.label,
    model: profile.model,
    siteNotes: settings.siteNotes,
    autonomous: settings.agent.autonomous,
    riskRules: settings.safety.rules,
    approvalWindowSec: settings.safety.approvalWindowSec,
    ...overrides,
  };
}

/**
 * Запускает цикл агента во вкладке. restore — состояние прерванного запуска из журнала:
 * тогда конфиг берётся из чекпоинта, а адрес сервера и модель — из текущего профиля.
 */
async function launch(settings: Settings, profileId: ProfileId, cfg: RunConfig, tab: AgentTab, restore?: RunState): Promise<RunState> {
  const profile = settings.profiles[profileId];
  const progress = throttledProgress();
  const remote = settings.logging.remoteEnabled && settings.logging.remoteUrl ? settings.logging.remoteUrl : null;
  await pruneRuns().catch(() => {});
  await pruneDeferred(Date.now()).catch(() => {});
  // CDP подключается при первом клике/вводе; при отказе — DOM-события.
  const debuggers = settings.agent.useDebugger ? new DebuggerSessions() : null;
  const exec: ExecContext = {
    tab,
    cdp: debuggers ? (tabId) => debuggers.driverFor(tabId) : undefined,
    cdpUnavailable: () => debuggers?.unavailableReason ?? '',
    showCursor: settings.agent.showCursor,
  };

  const { systemTemplate: _sys, ...cfgToSave } = cfg;
  const writeCheckpoint = async (state: RunState) => {
    if (TERMINAL_STATUSES.has(state.status)) return clearCheckpoint();
    const url = (await browser.tabs.get(tab.tabId).catch(() => null))?.url ?? '';
    await saveCheckpoint({ runId: state.id, cfg: cfgToSave, profileId, tab: { ...tab, url }, savedAt: Date.now() });
  };

  const runner: AgentRunner = new AgentRunner(
    cfg,
    {
      observe: () => observeAgentTab(tab, settings.agent.maxObservationChars, settings.agent.debugOverlay, cfg.siteNotes),
      chat: (messages, schema, onDelta, onRetry, signal) => chatStream({ profile, messages, schema, onDelta, onRetry, signal }),
      execute: (action, handle) => executeAction(action, handle, exec),
      onState: (state) => broadcast({ type: 'ui:run-state', info: { state, interrupted: false } }),
      onProgress: progress,
      persistRun: async (state) => {
        await saveRun(state);
        await writeCheckpoint(state);
        if (remote && TERMINAL_STATUSES.has(state.status)) {
          void postLog(remote, { type: 'run', runId: state.id, task: state.task, status: state.status, result: state.result, error: state.error, at: new Date().toISOString() });
        }
      },
      persistStep: async (state, step, detail) => {
        await saveStep(state.id, step, detail);
        if (remote) {
          void postLog(remote, {
            type: 'step',
            runId: state.id,
            task: state.task,
            status: state.status,
            step: { ...step, observation: detail.observation, responses: detail.responses },
            at: new Date().toISOString(),
          });
        }
      },
      checkpoint: async (state, step) => {
        await saveStep(state.id, step);
        await saveRun(state);
        await writeCheckpoint(state);
      },
      defer: async (item) => {
        await addDeferred(item);
        broadcast({ type: 'ui:queue-changed' });
      },
      alert: (message) => {
        void alertHuman('Агенту нужно подтверждение', message, settings.safety.sound);
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      newId: () => crypto.randomUUID(),
    },
    restore,
  );

  current = { runner, tab };
  interrupted = null;
  // Весь запуск (включая ожидание ответа человека) держим service worker живым.
  const stopKeepAlive = startKeepAlive();
  void runner.run().finally(() => {
    stopKeepAlive();
    void debuggers?.detachAll();
    void clearCheckpoint();
  });
  return runner.state;
}

function ensureIdle(): void {
  if (current && !TERMINAL_STATUSES.has(current.runner.state.status)) throw new Error('Агент уже работает — остановите текущую задачу.');
  if (interrupted) throw new Error('Есть прерванная задача — продолжите или отмените её в панели.');
}

async function startRun(windowId: number, task: string, overrides: Partial<RunConfig> = {}): Promise<RunState> {
  ensureIdle();
  if (!task.trim()) throw new Error('Введите задачу.');
  const settings = await loadSettings();
  const active = await activeTab(windowId);
  return launch(settings, settings.activeProfile, runConfig(settings, task, overrides), { tabId: active.id, windowId });
}

// ——— продолжение после перезапуска ———

/** Вкладка прерванного запуска: по id (если там та же страница), по адресу, иначе открываем заново. */
async function findAgentTab(saved: RunCheckpoint['tab']): Promise<AgentTab> {
  const byId = await browser.tabs.get(saved.tabId).catch(() => null);
  if (byId?.id !== undefined && sameUrl(byId.url, saved.url)) return { tabId: byId.id, windowId: byId.windowId };
  const all = await browser.tabs.query({});
  const byUrl = all.find((t) => t.id !== undefined && sameUrl(t.url, saved.url));
  if (byUrl?.id !== undefined) return { tabId: byUrl.id, windowId: byUrl.windowId };

  const url = normalizeNavigateUrl(saved.url) ?? undefined;
  const win = await browser.windows.getLastFocused().catch(() => null);
  if (win?.id !== undefined) {
    const created = await browser.tabs.create({ windowId: win.id, url, active: true });
    if (created.id !== undefined) {
      await waitForTabLoad(created.id);
      return { tabId: created.id, windowId: win.id };
    }
  }
  const w = await browser.windows.create({ url, focused: true });
  const t = w?.tabs?.[0];
  if (w?.id === undefined || t?.id === undefined) throw new Error('Не удалось открыть вкладку для продолжения задачи.');
  await waitForTabLoad(t.id);
  return { tabId: t.id, windowId: w.id };
}

async function resumeInterrupted(): Promise<RunState> {
  if (!interrupted) throw new Error('Нет прерванной задачи.');
  if (current && !TERMINAL_STATUSES.has(current.runner.state.status)) throw new Error('Агент уже работает.');
  const { checkpoint, state } = interrupted;
  const settings = await loadSettings();
  const profileId: ProfileId = checkpoint.profileId in settings.profiles ? (checkpoint.profileId as ProfileId) : settings.activeProfile;
  const tab = await findAgentTab(checkpoint.tab);
  await browser.tabs.update(tab.tabId, { active: true }).catch(() => {});
  return launch(settings, profileId, { ...checkpoint.cfg, systemTemplate }, tab, state);
}

async function discardInterrupted(): Promise<void> {
  if (!interrupted) return;
  const { state } = interrupted;
  interrupted = null;
  Object.assign(state, { status: 'stopped', finishedAt: Date.now(), error: 'Прервано перезапуском; продолжение отменено.' });
  delete state.pendingApproval;
  delete state.question;
  delete state.inFlight;
  await saveRun(state).catch(() => {});
  await clearCheckpoint();
  broadcast({ type: 'ui:run-state', info: { state, interrupted: false } });
}

let recovering: Promise<void> | null = null;

/** Проверка один раз на запуск воркера, сколько бы событий его ни разбудило. */
function recoverOnce(): Promise<void> {
  recovering ??= recoverOnStartup().catch((err: unknown) => console.error('recover failed', err));
  return recovering;
}

/** После старта воркера: нашёлся незавершённый запуск — ночью продолжаем сами, днём ждём кнопку. */
async function recoverOnStartup(): Promise<void> {
  if (current) return;
  const checkpoint = await loadCheckpoint();
  if (!checkpoint) return;
  const state = await loadRun(checkpoint.runId).catch(() => null);
  if (!state || TERMINAL_STATUSES.has(state.status)) {
    await clearCheckpoint();
    return;
  }
  interrupted = { checkpoint, state };
  broadcastRun();
  if (!checkpoint.cfg.autonomous) return;
  // Браузер мог только что запуститься — даём ему восстановить вкладки.
  await new Promise((r) => setTimeout(r, 5000));
  if (!interrupted || current) return;
  await resumeInterrupted().catch((err: unknown) => console.error('auto-resume failed', err));
}

// ——— очередь на утро ———

async function resumeFromQueue(id: string, windowId: number): Promise<RunState> {
  ensureIdle();
  const item = await getDeferred(id);
  if (!item) throw new Error('Этого элемента очереди уже нет.');
  const url = normalizeNavigateUrl(item.url);
  const active = await activeTab(windowId);
  if (url) {
    await browser.tabs.update(active.id, { url });
    await waitForTabLoad(active.id);
  }
  const settings = await loadSettings();
  // Утром человек рядом: обычный режим, рискованное подтверждается в панели.
  const state = await launch(settings, settings.activeProfile, runConfig(settings, resumeTask(item), { autonomous: false }), { tabId: active.id, windowId });
  await setDeferredStatus(id, 'resumed');
  broadcast({ type: 'ui:queue-changed' });
  return state;
}

function requireRun(): AgentRunner {
  if (!current) throw new Error('Нет активной задачи.');
  return current.runner;
}

async function handle(msg: BackgroundRequest): Promise<Result<unknown>> {
  switch (msg.type) {
    case 'bg:observe': {
      const tab = await activeTab(msg.windowId);
      const settings = await loadSettings();
      const hide = tab.url ? hiddenNamesFor(tab.url, settings.siteNotes) : [];
      const page = await observePage(tab.id, tab.url, { maxChars: settings.agent.maxObservationChars, highlight: msg.highlight, hide });
      return { ok: true, value: { text: page.text, stats: page.stats } };
    }
    case 'bg:highlight': {
      const tab = await activeTab(msg.windowId);
      await setHighlight(tab.id, tab.url, msg.enabled);
      return { ok: true, value: null };
    }
    case 'bg:run-start':
      return { ok: true, value: await startRun(msg.windowId, msg.task) };
    case 'bg:run-control': {
      const runner = requireRun();
      if (msg.command === 'pause') runner.pause();
      else if (msg.command === 'resume') runner.resume();
      else runner.stop();
      return { ok: true, value: null };
    }
    case 'bg:run-approve':
      requireRun().approve(msg.approved);
      return { ok: true, value: null };
    case 'bg:run-answer':
      requireRun().answer(msg.text);
      return { ok: true, value: null };
    case 'bg:run-get':
      return { ok: true, value: runInfo() };
    case 'bg:run-detail':
      return { ok: true, value: (await getStepDetail(msg.runId, msg.n)) ?? null };
    case 'bg:runs-list':
      return { ok: true, value: await listRuns() };
    case 'bg:run-export':
      return { ok: true, value: await exportRun(msg.runId) };
    case 'bg:run-recover':
      if (msg.command === 'resume') await resumeInterrupted();
      else await discardInterrupted();
      return { ok: true, value: null };
    case 'bg:queue-list':
      return { ok: true, value: await listDeferred() };
    case 'bg:queue-resume':
      return { ok: true, value: await resumeFromQueue(msg.id, msg.windowId) };
    case 'bg:queue-dismiss':
      await setDeferredStatus(msg.id, 'dismissed');
      broadcast({ type: 'ui:queue-changed' });
      return { ok: true, value: null };
    case 'bg:alert-test': {
      const settings = await loadSettings();
      await alertHuman('Проверка сигнала', 'Так агент позовёт вас, когда ночью упрётся в рискованное действие.', settings.safety.sound);
      return { ok: true, value: null };
    }
  }
}

export default defineBackground(() => {
  // Клик по иконке расширения открывает side panel.
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.error('sidePanel.setPanelBehavior failed', err));

  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') {
      void browser.runtime.openOptionsPage();
    }
    void recoverOnce(); // обновление/перезагрузка расширения посреди задачи
  });
  // Без этой подписки Chrome не будит воркер при запуске браузера, и ночная задача
  // не продолжилась бы сама, пока кто-нибудь не откроет панель.
  browser.runtime.onStartup.addListener(() => void recoverOnce());

  // Клик по уведомлению — показать вкладку, где агент ждёт подтверждения.
  browser.notifications.onClicked.addListener((id) => {
    if (id !== ALERT_NOTIFICATION_ID) return;
    void browser.notifications.clear(id);
    if (!current) return;
    const { tabId, windowId } = current.tab;
    void browser.windows.update(windowId, { focused: true }).catch(() => {});
    void browser.tabs.update(tabId, { active: true }).catch(() => {});
    void browser.sidePanel.open({ windowId }).catch(() => {});
  });

  browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isBackgroundRequest(msg)) return;
    handle(msg).then(sendResponse, (err: unknown) => sendResponse({ ok: false, error: describeError(err) }));
    return true; // ответ асинхронный
  });

  // Воркер мог быть выгружен и разбужен чем угодно (панель, уведомление) — тоже проверяем.
  void recoverOnce();
});
