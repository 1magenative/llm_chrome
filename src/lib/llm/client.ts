import { parseExtraBody, type LlmProfile } from '../settings';
import { readSse } from './sse';
import { apiUrl, normalizeBaseUrl } from './url';

export type FetchFn = typeof fetch;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Как реально был запрошен структурированный ответ. */
export type StructuredFormat = 'json_schema' | 'json_object' | 'none';

export interface ChatDelta {
  content: string;
  reasoning: string;
}

export interface ChatOptions {
  profile: LlmProfile;
  messages: ChatMessage[];
  /** JSON Schema ответа; без неё structured output не запрашивается. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (delta: ChatDelta) => void;
  fetchImpl?: FetchFn;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  finishReason?: string;
  format: StructuredFormat;
  /** Время до первого токена, включая токены рассуждений. */
  ttftMs?: number;
  totalMs: number;
  usage?: { promptTokens?: number; completionTokens?: number };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

export function authHeaders(profile: Pick<LlmProfile, 'apiKey'>): Record<string, string> {
  return profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {};
}

/** Человекочитаемое описание ошибки сети/HTTP с подсказкой, что проверить. */
export function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body.trim().slice(0, 300);
    const tail = body ? ` Ответ сервера: ${body}` : '';
    switch (err.status) {
      case 401:
        return `401: неверный или отсутствующий API-ключ.${tail}`;
      case 403:
        return `403: доступ запрещён. Для Ollama проверьте OLLAMA_ORIGINS=chrome-extension://*, для llama-server — API-ключ.${tail}`;
      case 404:
        return `404: путь ${err.url} не найден. Проверьте адрес сервера и имя модели.${tail}`;
      default:
        return `HTTP ${err.status}.${tail}`;
    }
  }
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return err.name === 'TimeoutError' ? 'Таймаут: сервер не ответил вовремя.' : 'Запрос отменён.';
  }
  if (err instanceof TypeError) {
    return `Сервер недоступен (${err.message}). Проверьте адрес, что сервер слушает 0.0.0.0, и файрвол.`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Извлекает текст и рассуждения из одного chunk'а chat.completion.chunk. */
export function parseChunkDelta(json: unknown): ChatDelta {
  if (!isRecord(json) || !Array.isArray(json.choices)) return { content: '', reasoning: '' };
  const choice: unknown = json.choices[0];
  const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : {};
  const content = typeof delta.content === 'string' ? delta.content : '';
  // llama.cpp: reasoning_content; Ollama / vLLM: reasoning.
  const reasoning =
    typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string'
        ? delta.reasoning
        : '';
  return { content, reasoning };
}

/** Тело запроса /v1/chat/completions для заданного способа structured output. */
export function buildRequestBody(
  profile: LlmProfile,
  messages: ChatMessage[],
  format: StructuredFormat,
  schema?: Record<string, unknown>,
  maxTokens?: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: profile.temperature,
    max_tokens: maxTokens ?? profile.maxOutputTokens,
  };
  if (format === 'json_schema' && schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'agent_step', strict: true, schema } };
  } else if (format === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  if (!profile.thinking) {
    // Разные серверы понимают разные ключи; лишние они игнорируют.
    body.chat_template_kwargs = { enable_thinking: false };
    body.think = false;
  }
  return { ...body, ...parseExtraBody(profile.extraBody) };
}

/** Похоже ли, что сервер отверг именно response_format (а не что-то другое). */
export function isFormatRejection(err: unknown): boolean {
  return (
    err instanceof HttpError &&
    [400, 422, 500, 501].includes(err.status) &&
    /response_format|json_schema|schema|grammar|json/i.test(err.body)
  );
}

/** Какой формат сработал у сервера+модели — чтобы не наступать на отказ каждый шаг. */
const workingFormat = new Map<string, StructuredFormat>();

export function resetFormatCache(): void {
  workingFormat.clear();
}

function formatsToTry(profile: LlmProfile, hasSchema: boolean): StructuredFormat[] {
  if (!hasSchema) return ['none'];
  switch (profile.structuredOutput) {
    case 'json_schema':
      return ['json_schema'];
    case 'json_object':
      return ['json_object'];
    case 'off':
      return ['none'];
    case 'auto': {
      const all: StructuredFormat[] = ['json_schema', 'json_object', 'none'];
      const cached = workingFormat.get(`${profile.baseUrl}|${profile.model}`);
      return cached ? all.slice(all.indexOf(cached)) : all;
    }
  }
}

async function streamOnce(opts: ChatOptions, format: StructuredFormat, signal: AbortSignal): Promise<ChatResult> {
  const { profile } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  if (!baseUrl) throw new Error('Некорректный адрес сервера.');
  const url = apiUrl(baseUrl, '/chat/completions');
  const started = performance.now();

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(profile) },
    body: JSON.stringify(buildRequestBody(profile, opts.messages, format, opts.schema, opts.maxTokens)),
    signal,
  });
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''), url);
  if (!res.body) throw new Error('Пустое тело ответа.');

  const result: ChatResult = { content: '', reasoning: '', format, totalMs: 0 };
  for await (const ev of readSse(res.body)) {
    if (ev.data === '[DONE]') break;
    let json: unknown;
    try {
      json = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (!isRecord(json)) continue;
    if (isRecord(json.error)) {
      throw new Error(typeof json.error.message === 'string' ? json.error.message : 'Ошибка сервера в потоке.');
    }
    if (isRecord(json.usage)) {
      const u = json.usage;
      result.usage = {
        promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
        completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
      };
    }
    const choice: unknown = Array.isArray(json.choices) ? json.choices[0] : undefined;
    if (isRecord(choice) && typeof choice.finish_reason === 'string') result.finishReason = choice.finish_reason;
    const delta = parseChunkDelta(json);
    if (!delta.content && !delta.reasoning) continue;
    result.ttftMs ??= Math.round(performance.now() - started);
    result.content += delta.content;
    result.reasoning += delta.reasoning;
    opts.onDelta?.(delta);
  }
  result.totalMs = Math.round(performance.now() - started);
  return result;
}

/**
 * Стриминговый запрос к /v1/chat/completions. В режиме auto пробует json_schema →
 * json_object → без формата, если сервер отвергает response_format, и запоминает рабочий.
 */
export async function chatStream(opts: ChatOptions): Promise<ChatResult> {
  const { profile } = opts;
  const timeout = AbortSignal.timeout(profile.requestTimeoutSec * 1000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const formats = formatsToTry(profile, !!opts.schema);

  for (const [i, format] of formats.entries()) {
    try {
      const result = await streamOnce(opts, format, signal);
      if (opts.schema && profile.structuredOutput === 'auto') workingFormat.set(`${profile.baseUrl}|${profile.model}`, format);
      return result;
    } catch (err) {
      if (i < formats.length - 1 && isFormatRejection(err)) continue;
      throw err;
    }
  }
  throw new Error('unreachable');
}
