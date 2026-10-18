import { describe, expect, it, vi } from 'vitest';
import {
  checkConnection,
  describeError,
  HttpError,
  parseChunkDelta,
  probeGeneration,
  resolveModel,
  type FetchFn,
} from '@/lib/llm/connection';
import { DEFAULT_SETTINGS, type LlmProfile } from '@/lib/settings';

const profile = (patch: Partial<LlmProfile> = {}): LlmProfile => ({
  ...DEFAULT_SETTINGS.profiles.fast,
  baseUrl: 'http://llm.lan:11434/',
  model: 'qwen3:14b',
  ...patch,
});

type Route = (init: RequestInit | undefined) => Response;

function mockFetch(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return route(init);
  });
  return { fetch: fn as unknown as FetchFn, calls };
}

const json = (body: unknown, status = 200): Route => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const models = (...ids: string[]) => json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });

describe('resolveModel', () => {
  it('точное совпадение, :latest и регистр', () => {
    expect(resolveModel('qwen3:14b', ['qwen3:14b'])).toBe('qwen3:14b');
    expect(resolveModel('qwen3', ['qwen3:latest'])).toBe('qwen3:latest');
    expect(resolveModel('Qwen3:14B', ['qwen3:14b'])).toBe('qwen3:14b');
    expect(resolveModel('qwen3:32b', ['qwen3:14b'])).toBeUndefined();
  });
});

describe('checkConnection', () => {
  it('Ollama: модели, версия и контекст загруженной модели', async () => {
    const { fetch, calls } = mockFetch({
      'http://llm.lan:11434/v1/models': models('qwen3:14b', 'gpt-oss:20b'),
      'http://llm.lan:11434/api/version': json({ version: '0.12.3' }),
      'http://llm.lan:11434/api/ps': json({ models: [{ name: 'qwen3:14b', model: 'qwen3:14b', context_length: 32768 }] }),
    });
    const r = await checkConnection(profile({ apiKey: 'secret' }), fetch);
    expect(r.ok).toBe(true);
    expect(r.baseUrl).toBe('http://llm.lan:11434');
    expect(r.models).toEqual(['qwen3:14b', 'gpt-oss:20b']);
    expect(r.resolvedModel).toBe('qwen3:14b');
    expect(r.server).toEqual({ kind: 'ollama', version: '0.12.3', contextTokens: 32768 });
    expect(r.warnings).toEqual([]);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
  });

  it('предупреждает, если контекст сервера меньше бюджета', async () => {
    const { fetch } = mockFetch({
      'http://llm.lan:11434/v1/models': models('qwen3:14b'),
      'http://llm.lan:11434/api/version': json({ version: '0.12.3' }),
      'http://llm.lan:11434/api/ps': json({ models: [{ name: 'qwen3:14b', context_length: 4096 }] }),
    });
    const r = await checkConnection(profile({ contextTokens: 16384 }), fetch);
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/OLLAMA_CONTEXT_LENGTH/);
  });

  it('llama.cpp: n_ctx из /props, отсутствующая модель — только предупреждение', async () => {
    const { fetch } = mockFetch({
      'http://llm.lan:11434/v1/models': models('/models/Qwen3-32B-Q4_K_M.gguf'),
      'http://llm.lan:11434/props': json({
        default_generation_settings: { n_ctx: 32768 },
        model_path: '/models/Qwen3-32B-Q4_K_M.gguf',
        build_info: 'b6000',
      }),
    });
    const r = await checkConnection(profile({ model: 'qwen3-32b' }), fetch);
    expect(r.ok).toBe(true);
    expect(r.server).toEqual({ kind: 'llama.cpp', version: 'b6000', contextTokens: 32768 });
    expect(r.warnings).toHaveLength(1);
  });

  it('Ollama без нужной модели — ошибка', async () => {
    const { fetch } = mockFetch({
      'http://llm.lan:11434/v1/models': models('llama3:8b'),
      'http://llm.lan:11434/api/version': json({ version: '0.12.3' }),
      'http://llm.lan:11434/api/ps': json({ models: [] }),
    });
    const r = await checkConnection(profile(), fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/не найдена/);
  });

  it('401 даёт подсказку про ключ', async () => {
    const { fetch } = mockFetch({ 'http://llm.lan:11434/v1/models': json({ error: 'unauthorized' }, 401) });
    const r = await checkConnection(profile(), fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/API-ключ/);
  });

  it('сетевая ошибка даёт подсказку про адрес и файрвол', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as FetchFn;
    const r = await checkConnection(profile(), fetch);
    expect(r.error).toMatch(/недоступен/);
  });

  it('некорректный адрес не делает запросов', async () => {
    const { fetch, calls } = mockFetch({});
    const r = await checkConnection(profile({ baseUrl: 'ftp://x' }), fetch);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('describeError', () => {
  it('403 упоминает OLLAMA_ORIGINS', () => {
    expect(describeError(new HttpError(403, '', 'u'))).toMatch(/OLLAMA_ORIGINS/);
  });
  it('таймаут', () => {
    expect(describeError(new DOMException('t', 'TimeoutError'))).toMatch(/Таймаут/);
  });
});

describe('parseChunkDelta', () => {
  it('content, reasoning_content (llama.cpp) и reasoning (Ollama)', () => {
    expect(parseChunkDelta({ choices: [{ delta: { content: 'OK' } }] })).toEqual({ content: 'OK', reasoning: '' });
    expect(parseChunkDelta({ choices: [{ delta: { reasoning_content: 'hmm' } }] })).toEqual({ content: '', reasoning: 'hmm' });
    expect(parseChunkDelta({ choices: [{ delta: { reasoning: 'hmm' } }] })).toEqual({ content: '', reasoning: 'hmm' });
    expect(parseChunkDelta({ choices: [] })).toEqual({ content: '', reasoning: '' });
    expect(parseChunkDelta('garbage')).toEqual({ content: '', reasoning: '' });
  });
});

describe('probeGeneration', () => {
  const sse = (lines: string[]): Route => () =>
    new Response(lines.map((l) => `data: ${l}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  const chunk = (delta: Record<string, string>) => JSON.stringify({ choices: [{ index: 0, delta }] });

  it('собирает стрим, считает рассуждения и TTFT', async () => {
    const { fetch, calls } = mockFetch({
      'http://llm.lan:11434/v1/chat/completions': sse([
        chunk({ reasoning: 'думаю' }),
        chunk({ content: 'O' }),
        chunk({ content: 'K' }),
        '[DONE]',
      ]),
    });
    const deltas: string[] = [];
    const r = await probeGeneration(profile(), { fetchImpl: fetch, onDelta: (d) => deltas.push(d.content || d.reasoning) });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('OK');
    expect(r.reasoningChars).toBe(5);
    expect(r.ttftMs).toBeTypeOf('number');
    expect(deltas).toEqual(['думаю', 'O', 'K']);
    const body = JSON.parse(String(calls[0]?.init?.body)) as { stream: boolean; model: string };
    expect(body).toMatchObject({ stream: true, model: 'qwen3:14b' });
  });

  it('ошибка внутри потока', async () => {
    const { fetch } = mockFetch({
      'http://llm.lan:11434/v1/chat/completions': sse([JSON.stringify({ error: { message: 'model crashed' } })]),
    });
    const r = await probeGeneration(profile(), { fetchImpl: fetch });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('model crashed');
  });

  it('пустой стрим — не ok', async () => {
    const { fetch } = mockFetch({ 'http://llm.lan:11434/v1/chat/completions': sse(['[DONE]']) });
    const r = await probeGeneration(profile(), { fetchImpl: fetch });
    expect(r.ok).toBe(false);
  });
});
