import { browser, defineBackground } from '#imports';
import systemTemplate from '@/prompts/system.md?raw';
import { newBoundary, type TabInfo } from '@/lib/agent/prompt';
import { hiddenNamesFor, type SiteNote } from '@/lib/agent/site-notes';
import { AgentRunner, type Observation } from '@/lib/agent/runner';
import type { StepEvent } from '@/lib/agent/step';
import { TERMINAL_STATUSES, type RunState } from '@/lib/agent/types';
import { startKeepAlive } from '@/lib/keepalive';
import { chatStream, describeError } from '@/lib/llm/client';
import { exportRun, getStepDetail, listRuns, pruneRuns, saveRun, saveStep } from '@/lib/log/db';
import { postLog } from '@/lib/log/remote';
import { isBackgroundRequest, type BackgroundRequest, type Result, type UiEvent } from '@/lib/messages';
import { DebuggerSessions } from '@/lib/exec/debugger';
import { activeTab, isRestrictedUrl, observePage, setHighlight } from '@/lib/perception';
import { activeProfile, loadSettings } from '@/lib/settings';
import { executeAction, type AgentTab, type ExecContext } from '@/lib/tab-actions';

let current: { runner: AgentRunner; tab: AgentTab } | null = null;

function broadcast(msg: UiEvent): void {
  // Если панель закрыта, получателя нет — это не ошибка.
  browser.runtime.sendMessage(msg).catch(() => {});
}

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

async function startRun(windowId: number, task: string): Promise<RunState> {
  if (current && !TERMINAL_STATUSES.has(current.runner.state.status)) throw new Error('Агент уже работает — остановите текущую задачу.');
  if (!task.trim()) throw new Error('Введите задачу.');

  const settings = await loadSettings();
  const profile = activeProfile(settings);
  const active = await activeTab(windowId);
  const tab: AgentTab = { tabId: active.id, windowId };
  const progress = throttledProgress();
  const remote = settings.logging.remoteEnabled && settings.logging.remoteUrl ? settings.logging.remoteUrl : null;
  await pruneRuns().catch(() => {});
  // CDP подключается при первом клике/вводе; при отказе — DOM-события.
  const debuggers = settings.agent.useDebugger ? new DebuggerSessions() : null;
  const exec: ExecContext = {
    tab,
    cdp: debuggers ? (tabId) => debuggers.driverFor(tabId) : undefined,
    cdpUnavailable: () => debuggers?.unavailableReason ?? '',
    showCursor: settings.agent.showCursor,
  };

  const runner: AgentRunner = new AgentRunner(
    {
      task: task.trim(),
      systemTemplate,
      boundary: newBoundary(),
      maxSteps: settings.agent.maxSteps,
      maxActions: settings.agent.maxActionsPerStep,
      loopThreshold: settings.agent.loopThreshold,
      stepTimeoutSec: settings.agent.stepTimeoutSec,
      approveEachStep: settings.agent.approveEachStep,
      contextTokens: profile.contextTokens,
      maxOutputTokens: profile.maxOutputTokens,
      profileLabel: profile.label,
      model: profile.model,
      siteNotes: settings.siteNotes,
    },
    {
      observe: () => observeAgentTab(tab, settings.agent.maxObservationChars, settings.agent.debugOverlay, settings.siteNotes),
      chat: (messages, schema, onDelta, signal) => chatStream({ profile, messages, schema, onDelta, signal }),
      execute: (action, handle) => executeAction(action, handle, exec),
      onState: (state) => broadcast({ type: 'ui:run-state', state }),
      onProgress: progress,
      persistRun: async (state) => {
        await saveRun(state);
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
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      newId: () => crypto.randomUUID(),
    },
  );

  current = { runner, tab };
  // Весь запуск (включая ожидание ответа человека) держим service worker живым.
  const stopKeepAlive = startKeepAlive();
  void runner.run().finally(() => {
    stopKeepAlive();
    void debuggers?.detachAll();
  });
  return runner.state;
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
      return { ok: true, value: current?.runner.state ?? null };
    case 'bg:run-detail':
      return { ok: true, value: (await getStepDetail(msg.runId, msg.n)) ?? null };
    case 'bg:runs-list':
      return { ok: true, value: await listRuns() };
    case 'bg:run-export':
      return { ok: true, value: await exportRun(msg.runId) };
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
  });

  browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isBackgroundRequest(msg)) return;
    handle(msg).then(sendResponse, (err: unknown) => sendResponse({ ok: false, error: describeError(err) }));
    return true; // ответ асинхронный
  });
});
