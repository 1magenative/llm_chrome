import { storage } from '#imports';
import type { SiteNote } from './agent/site-notes';

export type ProfileId = 'fast' | 'slow';

/** Как просить у сервера структурированный ответ. */
export type StructuredOutputMode = 'auto' | 'json_schema' | 'json_object' | 'off';

export interface LlmProfile {
  /** Отображаемое имя профиля. */
  label: string;
  /** Адрес сервера без суффикса /v1, например http://192.168.1.10:11434 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /**
   * Бюджет контекста в токенах, под который собирается промпт.
   * Ollama через /v1 не принимает num_ctx в запросе — реальный контекст
   * задаётся на сервере (OLLAMA_CONTEXT_LENGTH), проверка связи его показывает.
   */
  contextTokens: number;
  maxOutputTokens: number;
  /** Таймаут одного запроса к LLM, секунды. Для ночного режима — минуты. */
  requestTimeoutSec: number;
  structuredOutput: StructuredOutputMode;
  /**
   * Рассуждения thinking-моделей. Выключение отправляет chat_template_kwargs.enable_thinking=false
   * (llama.cpp, vLLM) и think=false (Ollama); gpt-oss рассуждения не отключает.
   */
  thinking: boolean;
  /** JSON-объект, вмешиваемый в тело запроса (top_k, min_p, свои флаги сервера…). */
  extraBody: string;
}

export interface AgentSettings {
  maxSteps: number;
  /** Сколько действий модель может вернуть за один шаг. */
  maxActionsPerStep: number;
  stepTimeoutSec: number;
  /** Сколько одинаковых действий подряд без изменения страницы считать зацикливанием. */
  loopThreshold: number;
  /** Жёсткий лимит символов на наблюдение (сериализованную страницу). */
  maxObservationChars: number;
  /** Пошаговый режим: перед выполнением действий агент ждёт «Выполнить» от человека. */
  approveEachStep: boolean;
  /** Автономный режим: рискованные действия откладываются в очередь «на утро». */
  autonomous: boolean;
  useDebugger: boolean;
  showCursor: boolean;
  debugOverlay: boolean;
}

export interface LoggingSettings {
  remoteEnabled: boolean;
  remoteUrl: string;
}

export interface Settings {
  activeProfile: ProfileId;
  profiles: Record<ProfileId, LlmProfile>;
  agent: AgentSettings;
  logging: LoggingSettings;
  /** Подсказки для конкретных сайтов («Узнать ответ» = проверить и т.п.). */
  siteNotes: SiteNote[];
}

export const DEFAULT_SETTINGS: Settings = {
  activeProfile: 'fast',
  profiles: {
    fast: {
      label: 'Быстрый',
      baseUrl: 'http://192.168.1.10:11434',
      apiKey: '',
      model: 'qwen3:14b',
      temperature: 0.2,
      contextTokens: 16384,
      maxOutputTokens: 2048,
      requestTimeoutSec: 120,
      structuredOutput: 'auto',
      thinking: false,
      extraBody: '',
    },
    slow: {
      label: 'Ночной',
      baseUrl: 'http://192.168.1.10:11434',
      apiKey: '',
      model: 'qwen3:32b',
      temperature: 0.2,
      contextTokens: 16384,
      maxOutputTokens: 4096,
      requestTimeoutSec: 1800,
      structuredOutput: 'auto',
      thinking: true,
      extraBody: '',
    },
  },
  agent: {
    maxSteps: 40,
    maxActionsPerStep: 4,
    stepTimeoutSec: 60,
    loopThreshold: 3,
    approveEachStep: true,
    maxObservationChars: 12000,
    autonomous: false,
    useDebugger: true,
    showCursor: true,
    debugOverlay: false,
  },
  logging: {
    remoteEnabled: false,
    remoteUrl: '',
  },
  siteNotes: [],
};

const MAX_SITE_NOTES = 50;
const MAX_NOTE_CHARS = 4000;

const STRUCTURED_MODES: readonly StructuredOutputMode[] = ['auto', 'json_schema', 'json_object', 'off'];
const PROFILE_IDS: readonly ProfileId[] = ['fast', 'slow'];

type Unknown<T> = { [K in keyof T]?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function num(v: unknown, fallback: number, min: number, max: number, integer = false): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : clamped;
}

function sanitizeProfile(raw: unknown, def: LlmProfile): LlmProfile {
  const r: Unknown<LlmProfile> = isRecord(raw) ? raw : {};
  const mode = r.structuredOutput;
  return {
    label: str(r.label, def.label),
    baseUrl: str(r.baseUrl, def.baseUrl).trim(),
    apiKey: str(r.apiKey, def.apiKey).trim(),
    model: str(r.model, def.model).trim(),
    temperature: num(r.temperature, def.temperature, 0, 2),
    contextTokens: num(r.contextTokens, def.contextTokens, 1024, 1_048_576, true),
    maxOutputTokens: num(r.maxOutputTokens, def.maxOutputTokens, 64, 131_072, true),
    requestTimeoutSec: num(r.requestTimeoutSec, def.requestTimeoutSec, 5, 7200, true),
    structuredOutput: STRUCTURED_MODES.includes(mode as StructuredOutputMode)
      ? (mode as StructuredOutputMode)
      : def.structuredOutput,
    thinking: bool(r.thinking, def.thinking),
    extraBody: str(r.extraBody, def.extraBody).trim(),
  };
}

/** Разбирает extraBody; пустая строка — пустой объект. Бросает понятную ошибку. */
export function parseExtraBody(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Доп. параметры запроса — не JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(v)) throw new Error('Доп. параметры запроса должны быть JSON-объектом: {"top_k": 20}');
  return v;
}

function sanitizeAgent(raw: unknown, def: AgentSettings): AgentSettings {
  const r: Unknown<AgentSettings> = isRecord(raw) ? raw : {};
  return {
    maxSteps: num(r.maxSteps, def.maxSteps, 1, 1000, true),
    maxActionsPerStep: num(r.maxActionsPerStep, def.maxActionsPerStep, 1, 10, true),
    stepTimeoutSec: num(r.stepTimeoutSec, def.stepTimeoutSec, 5, 3600, true),
    loopThreshold: num(r.loopThreshold, def.loopThreshold, 2, 20, true),
    maxObservationChars: num(r.maxObservationChars, def.maxObservationChars, 1000, 500_000, true),
    approveEachStep: bool(r.approveEachStep, def.approveEachStep),
    autonomous: bool(r.autonomous, def.autonomous),
    useDebugger: bool(r.useDebugger, def.useDebugger),
    showCursor: bool(r.showCursor, def.showCursor),
    debugOverlay: bool(r.debugOverlay, def.debugOverlay),
  };
}

/**
 * Приводит произвольные данные (старая версия настроек, ручная правка, мусор)
 * к валидным Settings: недостающие поля берутся из дефолтов, числа зажимаются в диапазоны.
 */
export function sanitizeSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const r: Unknown<Settings> = isRecord(raw) ? raw : {};
  const rawProfiles = isRecord(r.profiles) ? r.profiles : {};
  const logging: Unknown<LoggingSettings> = isRecord(r.logging) ? r.logging : {};
  return {
    activeProfile: PROFILE_IDS.includes(r.activeProfile as ProfileId)
      ? (r.activeProfile as ProfileId)
      : defaults.activeProfile,
    profiles: {
      fast: sanitizeProfile(rawProfiles.fast, defaults.profiles.fast),
      slow: sanitizeProfile(rawProfiles.slow, defaults.profiles.slow),
    },
    agent: sanitizeAgent(r.agent, defaults.agent),
    logging: {
      remoteEnabled: bool(logging.remoteEnabled, defaults.logging.remoteEnabled),
      remoteUrl: str(logging.remoteUrl, defaults.logging.remoteUrl).trim(),
    },
    siteNotes: Array.isArray(r.siteNotes)
      ? r.siteNotes
          .filter(isRecord)
          .map((n) => ({
            pattern: str(n.pattern, '').trim(),
            notes: str(n.notes, '').slice(0, MAX_NOTE_CHARS),
            hide: str(n.hide, '').slice(0, MAX_NOTE_CHARS),
          }))
          .slice(0, MAX_SITE_NOTES)
      : defaults.siteNotes,
  };
}

export function activeProfile(s: Settings): LlmProfile {
  return s.profiles[s.activeProfile];
}

// storage.local, а не sync: API-ключ не должен уезжать в облако Google.
const settingsItem = storage.defineItem<unknown>('local:settings', { fallback: null });

export async function loadSettings(): Promise<Settings> {
  return sanitizeSettings(await settingsItem.getValue());
}

export async function saveSettings(s: Settings): Promise<Settings> {
  const clean = sanitizeSettings(s);
  await settingsItem.setValue(clean);
  return clean;
}

export function watchSettings(cb: (s: Settings) => void): () => void {
  return settingsItem.watch((v) => cb(sanitizeSettings(v)));
}
