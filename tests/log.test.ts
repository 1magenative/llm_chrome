import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { exportRun, getStepDetail, listRuns, pruneRuns, resetLogDb, saveRun, saveStep } from '@/lib/log/db';
import { postLog } from '@/lib/log/remote';
import { normalizeNavigateUrl } from '@/lib/tab-actions';
import type { RunState, StepRecord } from '@/lib/agent/types';

const run = (id: string, startedAt: number, patch: Partial<RunState> = {}): RunState => ({
  id,
  task: `Задача ${id}`,
  profileLabel: 'Быстрый',
  model: 'qwen3',
  status: 'running',
  startedAt,
  maxSteps: 10,
  steps: [],
  extracted: [],
  ...patch,
});
const step = (n: number): StepRecord => ({ n, startedAt: n, url: 'https://e.com', reasoning: 'r', expectedOutcome: '', actions: [], warnings: [], notes: [] });

afterEach(async () => {
  await resetLogDb();
  indexedDB.deleteDatabase('agent-log');
});

describe('журнал IndexedDB', () => {
  it('сохраняет запуск, шаги и детали; экспорт собирает всё вместе', async () => {
    const r = run('a', 100, { steps: [step(1), step(2)] });
    await saveRun(r);
    await saveStep('a', step(1), { runId: 'a', n: 1, observation: 'obs1', history: '', responses: [{ content: '{}', reasoning: 'думаю' }] });
    await saveStep('a', step(2));
    expect(await getStepDetail('a', 1)).toMatchObject({ observation: 'obs1' });
    expect(await getStepDetail('a', 2)).toBeUndefined();

    const exported = await exportRun('a');
    expect(exported?.run).toMatchObject({ id: 'a', task: 'Задача a', stepCount: 2 });
    expect(exported?.run).not.toHaveProperty('steps');
    expect(exported?.steps.map((s) => s.n)).toEqual([1, 2]);
    expect(exported?.steps[0]).toMatchObject({ observation: 'obs1', responses: [{ content: '{}', reasoning: 'думаю' }] });
    expect(await exportRun('нет')).toBeNull();
  });

  it('список — свежие сверху; обновление статуса перезаписывает запись', async () => {
    await saveRun(run('old', 1));
    await saveRun(run('new', 2));
    await saveRun(run('old', 1, { status: 'done', result: 'ok' }));
    const list = await listRuns();
    expect(list.map((r) => [r.id, r.status])).toEqual([
      ['new', 'running'],
      ['old', 'done'],
    ]);
  });

  it('pruneRuns удаляет старые запуски вместе с шагами', async () => {
    for (let i = 1; i <= 4; i++) {
      await saveRun(run(`r${i}`, i));
      await saveStep(`r${i}`, step(1), { runId: `r${i}`, n: 1, observation: 'o', history: '', responses: [] });
    }
    expect(await pruneRuns(2)).toBe(2);
    expect((await listRuns()).map((r) => r.id)).toEqual(['r4', 'r3']);
    expect(await getStepDetail('r1', 1)).toBeUndefined();
    expect(await exportRun('r2')).toBeNull();
  });
});

describe('postLog', () => {
  const event = { type: 'run' as const, runId: 'a', task: 't', status: 'done' as const, at: 'now' };
  it('POST JSON; ошибки не бросает, а возвращает', async () => {
    let body = '';
    const ok = await postLog('http://log.lan/x', event, async (_u, init) => {
      body = String(init?.body);
      return new Response(null, { status: 204 });
    });
    expect(ok).toBeNull();
    expect(JSON.parse(body)).toMatchObject({ runId: 'a', status: 'done' });
    expect(await postLog('http://log.lan/x', event, async () => new Response('', { status: 500 }))).toBe('HTTP 500');
    expect(
      await postLog('http://log.lan/x', event, async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toBe('Failed to fetch');
  });
});

describe('normalizeNavigateUrl', () => {
  it.each([
    ['ya.ru', 'https://ya.ru/'],
    ['https://hh.ru/search?q=python', 'https://hh.ru/search?q=python'],
    ['http://192.168.0.3:8080', 'http://192.168.0.3:8080/'],
    ['  example.com/path ', 'https://example.com/path'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeNavigateUrl(input)).toBe(expected);
  });
  it.each(['', 'javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,hi'])('отклоняет %j', (input) => {
    expect(normalizeNavigateUrl(input)).toBeNull();
  });
});
