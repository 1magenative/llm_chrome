import type { ChatDelta, ChatMessage, ChatResult } from '../llm/client';
import { describeError } from '../llm/client';
import type { AgentAction } from './actions';
import { buildHistory } from './history';
import { actionSignature, fingerprint, LoopDetector, pageSignature } from './loop';
import { elementLine, type TabInfo } from './prompt';
import { siteNotesFor, type SiteNote } from './site-notes';
import { runStep, type StepEvent, type StepOutcome } from './step';
import {
  TERMINAL_STATUSES,
  type ActionResult,
  type ObservationHandle,
  type RunState,
  type RunStatus,
  type StepDetail,
  type StepRecord,
} from './types';

export interface RunConfig {
  task: string;
  systemTemplate: string;
  boundary: string;
  maxSteps: number;
  maxActions: number;
  loopThreshold: number;
  stepTimeoutSec: number;
  approveEachStep: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  profileLabel: string;
  model: string;
  siteNotes: SiteNote[];
}

export interface Observation {
  observation: string;
  tabs: TabInfo[];
  /** Где искать элементы по номерам (фреймы и снимки) — чтобы исполнитель не перепутал номера. */
  handle: ObservationHandle;
  url: string;
}

export interface RunDeps {
  observe(): Promise<Observation>;
  chat(messages: ChatMessage[], schema: Record<string, unknown>, onDelta: (d: ChatDelta) => void, signal: AbortSignal): Promise<ChatResult>;
  /** Действия, меняющие страницу/вкладку (кроме done/ask_user/extract — их ведёт сам цикл). */
  execute(action: AgentAction, handle: ObservationHandle): Promise<ActionResult>;
  onState(state: RunState): void;
  onProgress(e: StepEvent): void;
  persistRun(state: RunState): Promise<void>;
  persistStep(state: RunState, step: StepRecord, detail: StepDetail): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  newId(): string;
}

/** После стольких подряд неудачных обращений к модели запуск останавливается. */
export const MAX_CONSECUTIVE_ERRORS = 3;
const ERROR_BACKOFF_MS = 3000;

/** Безопасные действия, которые не требуют одобрения даже в пошаговом режиме. */
const NO_APPROVAL: ReadonlySet<AgentAction['action']> = new Set(['done', 'ask_user', 'extract', 'wait', 'scroll']);

class StoppedError extends Error {
  constructor() {
    super('stopped');
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

/**
 * Цикл агента: наблюдение → модель → (одобрение) → выполнение → следующий шаг.
 * Зависимости внедряются, поэтому цикл тестируется без браузера и сервера.
 */
export class AgentRunner {
  readonly state: RunState;
  private readonly abort = new AbortController();
  private readonly loop: LoopDetector;
  private resumeWaiter: (() => void) | null = null;
  private approvalWaiter: ((approved: boolean) => void) | null = null;
  private answerWaiter: ((text: string) => void) | null = null;

  constructor(
    private readonly cfg: RunConfig,
    private readonly deps: RunDeps,
  ) {
    this.loop = new LoopDetector(cfg.loopThreshold);
    this.state = {
      id: deps.newId(),
      task: cfg.task,
      profileLabel: cfg.profileLabel,
      model: cfg.model,
      status: 'running',
      startedAt: deps.now(),
      maxSteps: cfg.maxSteps,
      steps: [],
      extracted: [],
    };
  }

  private get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  private emit(): void {
    this.deps.onState(this.state);
  }

  private async finish(status: RunStatus, fields: Partial<Pick<RunState, 'result' | 'error'>> = {}): Promise<void> {
    if (TERMINAL_STATUSES.has(this.state.status)) return;
    Object.assign(this.state, fields, { status, finishedAt: this.deps.now(), pauseRequested: false });
    delete this.state.pendingApproval;
    delete this.state.question;
    this.emit();
    await this.deps.persistRun(this.state).catch(() => {});
  }

  // ——— управление извне ———

  pause(): void {
    if (this.state.status === 'running') {
      this.state.pauseRequested = true;
      this.emit();
    }
  }

  resume(): void {
    this.state.pauseRequested = false;
    if (this.state.status === 'paused') {
      this.state.status = 'running';
      this.emit();
    }
    this.resumeWaiter?.();
    this.resumeWaiter = null;
  }

  stop(): void {
    if (TERMINAL_STATUSES.has(this.state.status)) return;
    this.abort.abort();
    this.resumeWaiter?.();
    this.approvalWaiter?.(false);
    this.answerWaiter?.('');
    void this.finish('stopped');
  }

  approve(approved: boolean): void {
    this.approvalWaiter?.(approved);
    this.approvalWaiter = null;
  }

  answer(text: string): void {
    this.answerWaiter?.(text);
    this.answerWaiter = null;
  }

  /** Точка, где вступает в силу пауза или стоп. */
  private async checkpoint(): Promise<void> {
    if (this.state.pauseRequested && !this.stopped) {
      this.state.status = 'paused';
      this.state.pauseRequested = false;
      this.emit();
      await new Promise<void>((resolve) => (this.resumeWaiter = resolve));
    }
    if (this.stopped) throw new StoppedError();
  }

  // ——— основной цикл ———

  async run(): Promise<RunState> {
    this.emit();
    await this.deps.persistRun(this.state).catch(() => {});
    let consecutiveErrors = 0;
    try {
      while (!TERMINAL_STATUSES.has(this.state.status)) {
        await this.checkpoint();
        if (this.state.steps.length >= this.cfg.maxSteps) {
          await this.finish('failed', { error: `Достигнут лимит шагов (${this.cfg.maxSteps}).` });
          break;
        }
        const ok = await this.step();
        if (ok) {
          consecutiveErrors = 0;
        } else if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          await this.finish('failed', { error: `Модель ${MAX_CONSECUTIVE_ERRORS} раза подряд не дала годного ответа: ${this.state.steps.at(-1)?.error ?? ''}` });
        } else {
          await this.deps.sleep(ERROR_BACKOFF_MS);
        }
      }
    } catch (err) {
      if (err instanceof StoppedError || this.stopped) await this.finish('stopped');
      else await this.finish('failed', { error: describeError(err) });
    }
    return this.state;
  }

  /** Один шаг. false — шаг не удался (ошибка модели/сети), true — иначе. */
  private async step(): Promise<boolean> {
    const n = this.state.steps.length + 1;
    const record: StepRecord = { n, startedAt: this.deps.now(), url: '', reasoning: '', expectedOutcome: '', actions: [], warnings: [], notes: [] };
    const history = buildHistory(this.state.steps, this.state.extracted);
    let obs: Observation | null = null;
    let outcome: StepOutcome;

    try {
      outcome = await runStep(
        {
          task: this.cfg.task,
          systemTemplate: this.cfg.systemTemplate,
          boundary: this.cfg.boundary,
          maxActions: this.cfg.maxActions,
          maxRetries: 2,
          contextTokens: this.cfg.contextTokens,
          maxOutputTokens: this.cfg.maxOutputTokens,
          history,
          siteNotesFor: (url) => siteNotesFor(url, this.cfg.siteNotes),
        },
        {
          observe: async () => {
            obs = await this.deps.observe();
            return { observation: obs.observation, tabs: obs.tabs, url: obs.url };
          },
          chat: (messages, schema, onDelta) => this.deps.chat(messages, schema, onDelta, this.abort.signal),
        },
        (e) => this.deps.onProgress(e),
      );
    } catch (err) {
      if (this.stopped) throw new StoppedError();
      record.error = describeError(err);
      record.url = (obs as Observation | null)?.url ?? '';
      await this.saveStep(record, obs, history, null);
      return false;
    }

    const seen = obs as unknown as Observation;
    record.url = seen.url;
    record.warnings.push(...outcome.warnings);
    const last = outcome.attempts.at(-1);
    if (last) {
      record.llm = {
        attempts: outcome.attempts.length,
        format: last.format,
        ttftMs: last.ttftMs,
        totalMs: outcome.attempts.reduce((s, a) => s + a.totalMs, 0),
        promptTokens: last.promptTokens,
        completionTokens: last.completionTokens,
        promptTokensEstimate: outcome.promptTokensEstimate,
      };
    }
    if (!outcome.step) {
      record.error = outcome.error;
      await this.saveStep(record, seen, history, outcome);
      return false;
    }

    record.reasoning = outcome.step.reasoning;
    record.expectedOutcome = outcome.step.expected_outcome;
    record.actions = outcome.step.actions.map((action) => ({
      action,
      target: 'index' in action ? elementLine(seen.observation, action.index) : undefined,
    }));

    const verdict = this.loop.record(actionSignature(record.actions), fingerprint(pageSignature(seen.observation)));
    if (verdict === 'warn') {
      record.warnings.push(
        `LOOP: these exact actions were already chosen ${this.loop.repeats} times on the same page and did not get you closer to the goal. Do something different (another element, scroll, navigate) or ask_user.`,
      );
    }
    this.state.steps.push(record);
    this.emit();

    if (verdict === 'stop') {
      for (const a of record.actions) a.skipped = 'loop detected';
      await this.saveStep(record, seen, history, outcome);
      await this.finish('failed', { error: `Зацикливание: одно и то же действие ${this.loop.repeats} раз подряд без изменения страницы.` });
      return true;
    }

    if (this.cfg.approveEachStep && record.actions.some((a) => !NO_APPROVAL.has(a.action.action))) {
      const approved = await this.requestApproval(record);
      if (!approved) {
        for (const a of record.actions) a.skipped = 'rejected by the user';
        record.notes.push('The user rejected these actions. Choose a different approach or use ask_user.');
        await this.saveStep(record, seen, history, outcome);
        return true;
      }
    }

    await this.executeAll(record, seen.handle);
    await this.saveStep(record, seen, history, outcome);
    return true;
  }

  private async requestApproval(record: StepRecord): Promise<boolean> {
    this.state.status = 'awaiting_approval';
    this.state.pendingApproval = { actions: record.actions, reasoning: record.reasoning };
    this.emit();
    const approved = await new Promise<boolean>((resolve) => (this.approvalWaiter = resolve));
    if (this.stopped) throw new StoppedError();
    delete this.state.pendingApproval;
    this.state.status = 'running';
    this.emit();
    return approved;
  }

  private async askUser(question: string): Promise<string> {
    this.state.status = 'asking_user';
    this.state.question = question;
    this.emit();
    await this.deps.persistRun(this.state).catch(() => {});
    const answer = await new Promise<string>((resolve) => (this.answerWaiter = resolve));
    if (this.stopped) throw new StoppedError();
    delete this.state.question;
    this.state.status = 'running';
    this.emit();
    return answer;
  }

  private async executeAll(record: StepRecord, handle: ObservationHandle): Promise<void> {
    const skipRest = (from: number, why: string) => {
      for (const a of record.actions.slice(from)) a.skipped = why;
    };

    for (const [i, ex] of record.actions.entries()) {
      await this.checkpoint();
      const a = ex.action;

      if (a.action === 'done') {
        ex.result = { ok: true, message: 'task finished' };
        await this.finish('done', { result: a.result });
        return;
      }
      if (a.action === 'ask_user') {
        ex.result = { ok: true, message: 'question shown to the user' };
        const answer = await this.askUser(a.question);
        record.notes.push(`User answered: ${answer || '(no answer)'}`);
        return;
      }
      if (a.action === 'extract') {
        this.state.extracted.push(a.note);
        ex.result = { ok: true, message: 'saved' };
        this.emit();
        continue;
      }

      try {
        ex.result = await withTimeout(this.deps.execute(a, handle), this.cfg.stepTimeoutSec * 1000, a.action);
      } catch (err) {
        if (this.stopped) throw new StoppedError();
        ex.result = { ok: false, message: describeError(err) };
      }
      this.emit();

      if (!ex.result.ok) {
        skipRest(i + 1, 'previous action failed');
        return;
      }
      if (ex.result.navigated && i < record.actions.length - 1) {
        skipRest(i + 1, 'page changed — element numbers are no longer valid');
        return;
      }
    }
  }

  private async saveStep(record: StepRecord, obs: Observation | null, history: string, outcome: StepOutcome | null): Promise<void> {
    record.durationMs = this.deps.now() - record.startedAt;
    if (!this.state.steps.includes(record)) this.state.steps.push(record);
    this.emit();
    const detail: StepDetail = {
      runId: this.state.id,
      n: record.n,
      observation: obs?.observation ?? '',
      history,
      siteNotes: outcome?.siteNotes || undefined,
      responses: outcome?.attempts.map((a) => ({ content: a.content, reasoning: a.reasoning, parseError: a.parseError })) ?? [],
    };
    await this.deps.persistStep(this.state, record, detail).catch(() => {});
    await this.deps.persistRun(this.state).catch(() => {});
  }
}
