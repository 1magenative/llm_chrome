import type { FrameNode } from '../frames';
import type { StructuredFormat } from '../llm/client';
import type { AgentAction } from './actions';

export type RunStatus =
  | 'running'
  | 'paused'
  /** Ждёт «Выполнить/Отклонить» по запланированным действиям. */
  | 'awaiting_approval'
  /** Модель задала вопрос через ask_user. */
  | 'asking_user'
  | 'done'
  | 'failed'
  | 'stopped';

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'stopped']);

/** Как найти элемент по номеру из наблюдения: в каком фрейме и в каком снимке он живёт. */
export interface ObservationHandle {
  frames: { frameId: number; snapshotId: number }[];
  /** Номер элемента → frameId. */
  owner: Record<number, number>;
  /** Дерево фреймов — для пересчёта координат iframe перед кликом. */
  nodes: FrameNode[];
}

export interface ActionResult {
  ok: boolean;
  /** Коротко для истории и ленты: «ok», «page navigated to …», «element [12] is gone». */
  message: string;
  /** Страница ушла на другой URL / перезагрузилась — номера элементов недействительны. */
  navigated?: boolean;
}

export interface ExecutedAction {
  action: AgentAction;
  /** Строка элемента из наблюдения: `button "Войти"` — для ленты и истории. */
  target?: string;
  result?: ActionResult;
  skipped?: string;
}

export interface StepLlmInfo {
  attempts: number;
  format: StructuredFormat;
  ttftMs?: number;
  totalMs: number;
  promptTokens?: number;
  completionTokens?: number;
  promptTokensEstimate: number;
}

/** Шаг в ленте (лёгкий — без наблюдения и сырых ответов). */
export interface StepRecord {
  n: number;
  startedAt: number;
  durationMs?: number;
  url: string;
  reasoning: string;
  expectedOutcome: string;
  actions: ExecutedAction[];
  llm?: StepLlmInfo;
  /** Предупреждения парсера, детектора зацикливания, бюджета контекста. */
  warnings: string[];
  /** Ответ пользователя, отказ в одобрении и т.п. — попадает в историю для модели. */
  notes: string[];
  error?: string;
}

/** Тяжёлые данные шага — только в журнале, подгружаются по запросу. */
export interface StepDetail {
  runId: string;
  n: number;
  observation: string;
  history: string;
  /** Заметки для сайта, попавшие в промпт этого шага. */
  siteNotes?: string;
  responses: { content: string; reasoning: string; parseError?: string }[];
}

export interface PendingApproval {
  actions: ExecutedAction[];
  reasoning: string;
}

export interface RunState {
  id: string;
  task: string;
  profileLabel: string;
  model: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  maxSteps: number;
  steps: StepRecord[];
  /** Сохранённое через extract — всегда целиком попадает в промпт. */
  extracted: string[];
  pendingApproval?: PendingApproval;
  question?: string;
  result?: string;
  error?: string;
  /** Пауза запрошена, но вступит в силу после текущей операции. */
  pauseRequested?: boolean;
}

/** Строка журнала запусков. */
export interface RunSummary {
  id: string;
  task: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  steps: number;
  result?: string;
  error?: string;
}
