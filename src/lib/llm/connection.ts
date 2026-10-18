import type { LlmProfile } from '../settings';
import { authHeaders, chatStream, describeError, HttpError, type FetchFn } from './client';
import { apiUrl, normalizeBaseUrl } from './url';

export { describeError, HttpError, parseChunkDelta, type FetchFn } from './client';

export type ServerKind = 'ollama' | 'llama.cpp' | 'unknown';

export interface ServerInfo {
  kind: ServerKind;
  version?: string;
  /** Реальный размер контекста на сервере, если удалось узнать. */
  contextTokens?: number;
}

export interface ConnectionReport {
  ok: boolean;
  baseUrl: string;
  latencyMs?: number;
  models: string[];
  /** Идентификатор модели на сервере, сопоставленный с настройкой (например qwen3 → qwen3:latest). */
  resolvedModel?: string;
  server: ServerInfo;
  warnings: string[];
  error?: string;
}

const PROBE_TIMEOUT_MS = 4000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function getJson(
  url: string,
  profile: Pick<LlmProfile, 'apiKey'>,
  timeoutMs: number,
  fetchImpl: FetchFn,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', ...authHeaders(profile) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''), url);
  return res.json();
}

export function parseModelList(json: unknown): string[] {
  if (!isRecord(json) || !Array.isArray(json.data)) return [];
  return json.data
    .map((m) => (isRecord(m) && typeof m.id === 'string' ? m.id : null))
    .filter((id): id is string => id !== null);
}

/** Ищет модель среди доступных; для Ollama имя без тега означает `:latest`. */
export function resolveModel(wanted: string, models: readonly string[]): string | undefined {
  if (models.includes(wanted)) return wanted;
  if (!wanted.includes(':') && models.includes(`${wanted}:latest`)) return `${wanted}:latest`;
  const lower = wanted.toLowerCase();
  return models.find((m) => m.toLowerCase() === lower);
}

async function detectOllama(
  baseUrl: string,
  profile: LlmProfile,
  model: string | undefined,
  fetchImpl: FetchFn,
): Promise<ServerInfo | null> {
  let version: string;
  try {
    const json = await getJson(`${baseUrl}/api/version`, profile, PROBE_TIMEOUT_MS, fetchImpl);
    if (!isRecord(json) || typeof json.version !== 'string') return null;
    version = json.version;
  } catch {
    return null;
  }

  const info: ServerInfo = { kind: 'ollama', version };
  try {
    // /api/ps показывает загруженные модели и (в новых версиях) их фактический context_length.
    const ps = await getJson(`${baseUrl}/api/ps`, profile, PROBE_TIMEOUT_MS, fetchImpl);
    if (isRecord(ps) && Array.isArray(ps.models)) {
      const loaded = ps.models.find(
        (m): m is Record<string, unknown> => isRecord(m) && (m.name === model || m.model === model),
      );
      if (loaded && typeof loaded.context_length === 'number') info.contextTokens = loaded.context_length;
    }
  } catch {
    // не критично
  }
  return info;
}

async function detectLlamaCpp(baseUrl: string, profile: LlmProfile, fetchImpl: FetchFn): Promise<ServerInfo | null> {
  try {
    const json = await getJson(`${baseUrl}/props`, profile, PROBE_TIMEOUT_MS, fetchImpl);
    if (!isRecord(json)) return null;
    const gen = isRecord(json.default_generation_settings) ? json.default_generation_settings : {};
    const nCtx = typeof gen.n_ctx === 'number' ? gen.n_ctx : typeof json.n_ctx === 'number' ? json.n_ctx : undefined;
    if (nCtx === undefined && !('model_path' in json) && !('build_info' in json)) return null;
    const info: ServerInfo = { kind: 'llama.cpp' };
    if (typeof json.build_info === 'string') info.version = json.build_info;
    if (nCtx !== undefined) info.contextTokens = nCtx;
    return info;
  } catch {
    return null;
  }
}

/**
 * Проверка связи: список моделей через /v1/models, затем определение типа сервера
 * и его реального контекста. Не генерирует токены — это делает probeGeneration.
 */
export async function checkConnection(profile: LlmProfile, fetchImpl: FetchFn = fetch): Promise<ConnectionReport> {
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  const report: ConnectionReport = {
    ok: false,
    baseUrl: baseUrl ?? profile.baseUrl,
    models: [],
    server: { kind: 'unknown' },
    warnings: [],
  };
  if (!baseUrl) {
    report.error = 'Некорректный адрес сервера. Пример: http://192.168.1.10:11434';
    return report;
  }

  const started = performance.now();
  try {
    const json = await getJson(apiUrl(baseUrl, '/models'), profile, 10_000, fetchImpl);
    report.latencyMs = Math.round(performance.now() - started);
    report.models = parseModelList(json);
  } catch (err) {
    report.error = describeError(err);
    return report;
  }

  report.resolvedModel = resolveModel(profile.model, report.models);
  report.server =
    (await detectOllama(baseUrl, profile, report.resolvedModel, fetchImpl)) ??
    (await detectLlamaCpp(baseUrl, profile, fetchImpl)) ??
    { kind: 'unknown' };

  if (!report.resolvedModel) {
    if (report.server.kind === 'llama.cpp') {
      // llama-server обслуживает загруженную модель независимо от поля model.
      report.warnings.push(`Модель «${profile.model}» не найдена в /v1/models; llama-server всё равно ответит загруженной моделью.`);
    } else {
      report.error = `Модель «${profile.model}» не найдена на сервере.`;
      return report;
    }
  }

  const ctx = report.server.contextTokens;
  if (ctx !== undefined && ctx < profile.contextTokens) {
    report.warnings.push(
      `Контекст на сервере ${ctx} токенов меньше бюджета в настройках (${profile.contextTokens}). ` +
        (report.server.kind === 'ollama'
          ? 'Увеличьте OLLAMA_CONTEXT_LENGTH или уменьшите бюджет — иначе промпт будет молча обрезан.'
          : 'Увеличьте -c у llama-server или уменьшите бюджет.'),
    );
  } else if (ctx === undefined && report.server.kind === 'ollama') {
    report.warnings.push('Ollama: фактический контекст будет виден после загрузки модели (повторите проверку после пробной генерации).');
  }

  report.ok = true;
  return report;
}

export interface ProbeOptions {
  fetchImpl?: FetchFn;
  signal?: AbortSignal;
  onDelta?: (delta: { content: string; reasoning: string }) => void;
}

export interface ProbeResult {
  ok: boolean;
  /** Время до первого токена (включая токены рассуждений). */
  ttftMs?: number;
  totalMs?: number;
  content: string;
  reasoningChars: number;
  error?: string;
}

/**
 * Пробная генерация со стримингом тем же клиентом, что и у агента:
 * проверяет модель, ключ, стрим и переключатель рассуждений.
 */
export async function probeGeneration(profile: LlmProfile, opts: ProbeOptions = {}): Promise<ProbeResult> {
  if (!normalizeBaseUrl(profile.baseUrl)) return { ok: false, content: '', reasoningChars: 0, error: 'Некорректный адрес сервера.' };
  try {
    const res = await chatStream({
      profile,
      messages: [{ role: 'user', content: 'Ответь одним словом: OK' }],
      maxTokens: Math.min(profile.maxOutputTokens, 1024),
      signal: opts.signal,
      onDelta: opts.onDelta,
      fetchImpl: opts.fetchImpl,
    });
    const ok = res.ttftMs !== undefined;
    return {
      ok,
      ttftMs: res.ttftMs,
      totalMs: res.totalMs,
      content: res.content,
      reasoningChars: res.reasoning.length,
      ...(ok ? {} : { error: 'Сервер не вернул ни одного токена.' }),
    };
  } catch (err) {
    return { ok: false, content: '', reasoningChars: 0, error: describeError(err) };
  }
}
