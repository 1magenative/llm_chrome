import { describe, expect, it, vi } from 'vitest';
import type { AgentAction } from '@/lib/agent/actions';
import { AgentRunner, type RunConfig, type RunDeps } from '@/lib/agent/runner';
import type { ActionResult, RunState } from '@/lib/agent/types';
import type { ChatResult } from '@/lib/llm/client';

const cfg: RunConfig = {
  task: 'Найди цену',
  systemTemplate: 'SYS',
  boundary: 'b',
  maxSteps: 10,
  maxActions: 4,
  loopThreshold: 2,
  stepTimeoutSec: 5,
  approveEachStep: false,
  contextTokens: 32768,
  maxOutputTokens: 1024,
  profileLabel: 'Быстрый',
  model: 'qwen3',
  siteNotes: [],
};

const reply = (actions: unknown[], reasoning = 'r'): ChatResult => ({
  content: JSON.stringify({ reasoning, expected_outcome: 'e', actions }),
  reasoning: '',
  format: 'json_schema',
  totalMs: 1,
  ttftMs: 1,
});

interface Harness {
  deps: RunDeps;
  executed: AgentAction[];
  states: RunState[];
  chats: number;
}

function harness(replies: (ChatResult | Error)[], opts: { pages?: string[]; exec?: (a: AgentAction) => ActionResult } = {}): Harness {
  const h: Harness = { executed: [], states: [], chats: 0, deps: undefined as unknown as RunDeps };
  let page = 0;
  h.deps = {
    observe: vi.fn(async () => {
      const text = opts.pages?.[Math.min(page++, opts.pages.length - 1)] ?? `[1] button "Купить"\n[2] input "Поиск"\npage ${page}`;
      return { observation: text, tabs: [], handle: { frames: [{ frameId: 0, snapshotId: page }], owner: {}, nodes: [] }, url: 'https://shop.example/' };
    }),
    chat: vi.fn(async () => {
      h.chats++;
      const r = replies.shift();
      if (!r) throw new Error('no more replies');
      if (r instanceof Error) throw r;
      return r;
    }),
    execute: vi.fn(async (a: AgentAction) => {
      h.executed.push(a);
      return opts.exec?.(a) ?? { ok: true, message: 'ok' };
    }),
    onState: (s) => h.states.push(structuredClone(s)),
    onProgress: () => {},
    persistRun: vi.fn(async () => {}),
    persistStep: vi.fn(async () => {}),
    now: () => 1000,
    sleep: async () => {},
    newId: () => 'run-1',
  };
  return h;
}

/** Ждём, пока runner перейдёт в нужный статус (для сценариев с ожиданием человека). */
async function until(runner: AgentRunner, status: RunState['status'], steps?: number): Promise<void> {
  const reached = () => runner.state.status === status && (steps === undefined || runner.state.steps.length === steps);
  for (let i = 0; i < 200 && !reached(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(runner.state.status).toBe(status);
}

describe('AgentRunner', () => {
  it('выполняет действия и завершается по done', async () => {
    const h = harness([reply([{ action: 'type', index: 2, text: 'ноутбук', submit: true }]), reply([{ action: 'extract', note: 'Цена 50 000' }, { action: 'done', result: 'Ноутбук стоит 50 000 ₽' }])]);
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.status).toBe('done');
    expect(state.result).toBe('Ноутбук стоит 50 000 ₽');
    expect(state.extracted).toEqual(['Цена 50 000']);
    expect(h.executed).toEqual([{ action: 'type', index: 2, text: 'ноутбук', submit: true }]);
    expect(state.steps).toHaveLength(2);
    expect(state.steps[0]!.actions[0]!.target).toBe('input "Поиск"');
    expect(h.deps.persistStep).toHaveBeenCalledTimes(2);
  });

  it('заметки для сайта попадают в промпт по URL страницы', async () => {
    const h = harness([reply([{ action: 'done', result: 'ok' }])]);
    await new AgentRunner({ ...cfg, siteNotes: [{ pattern: 'shop.example', notes: '«Купить» = положить в корзину', hide: '' }] }, h.deps).run();
    const prompt = vi.mocked(h.deps.chat).mock.calls[0]![0].at(-1)!.content;
    expect(prompt).toContain('«Купить» = положить в корзину\n\nReply with the JSON object');
    const detail = vi.mocked(h.deps.persistStep).mock.calls[0]![2];
    expect(detail.siteNotes).toBe('«Купить» = положить в корзину');
  });

  it('история предыдущих шагов уходит в следующий промпт', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }]), reply([{ action: 'done', result: 'ok' }])]);
    await new AgentRunner(cfg, h.deps).run();
    const secondPrompt = vi.mocked(h.deps.chat).mock.calls[1]![0].at(-1)!.content;
    expect(secondPrompt).toContain('HISTORY:\nStep 1 (https://shop.example/):');
    expect(secondPrompt).toContain('click [1] (button "Купить") → ok');
  });

  it('ошибка действия обрывает цепочку, остальное помечается пропущенным', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }, { action: 'click', index: 2 }]), reply([{ action: 'done', result: '' }])], {
      exec: (a) => (a.action === 'click' && a.index === 1 ? { ok: false, message: 'element [1] is gone' } : { ok: true, message: 'ok' }),
    });
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(h.executed).toHaveLength(1);
    expect(state.steps[0]!.actions[1]!.skipped).toBe('previous action failed');
  });

  it('после перехода на другую страницу остаток цепочки не выполняется', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }, { action: 'click', index: 2 }]), reply([{ action: 'done', result: '' }])], {
      exec: () => ({ ok: true, message: 'page changed', navigated: true }),
    });
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(h.executed).toHaveLength(1);
    expect(state.steps[0]!.actions[1]!.skipped).toMatch(/page changed/);
  });

  it('лимит шагов', async () => {
    const replies = Array.from({ length: 5 }, (_, i) => reply([{ action: 'scroll', direction: 'down', amount: 1 }], `шаг ${i}`));
    const h = harness(replies, { pages: ['p1', 'p2', 'p3', 'p4', 'p5'] });
    const state = await new AgentRunner({ ...cfg, maxSteps: 3 }, h.deps).run();
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/лимит шагов \(3\)/);
    expect(state.steps).toHaveLength(3);
  });

  it('детектор зацикливания: предупреждает модель, затем останавливает', async () => {
    const same = () => reply([{ action: 'click', index: 1 }]);
    const h = harness([same(), same(), same(), same(), same()], { pages: ['одна и та же страница'] });
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/Зацикливание/);
    expect(state.steps[1]!.warnings.join()).toMatch(/^LOOP/);
    expect(h.executed).toHaveLength(3);
    const third = vi.mocked(h.deps.chat).mock.calls[2]![0].at(-1)!.content;
    expect(third).toContain('warning: LOOP');
  });

  it('цикл ловится, даже если всплывающие элементы меняют список, а номер элемента сдвигается', async () => {
    const pages = [1, 2, 3, 4, 5, 6].map((i) => `URL: https://practicum/lesson\n${i % 2 ? '' : '[1] div "Скопировано"\n'}[${i % 2 ? 13 : 14}] div "<!-- ссылка -->"`);
    const replies = [1, 2, 3, 4, 5, 6].map((i) => reply([{ action: 'click', index: i % 2 ? 13 : 14 }]));
    const h = harness(replies, { pages });
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/Зацикливание/);
    expect(state.steps).toHaveLength(4);
  });

  it('три ошибки модели подряд — остановка', async () => {
    const h = harness([new Error('HTTP 500'), new Error('HTTP 500'), new Error('HTTP 500')]);
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/3 раза подряд/);
    expect(state.steps.every((s) => s.error)).toBe(true);
  });

  it('ошибка модели не фатальна, если следующий шаг удался', async () => {
    const h = harness([new Error('timeout'), reply([{ action: 'done', result: 'ok' }])]);
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.status).toBe('done');
  });

  it('пошаговый режим: одобрение выполняет, отказ — нет и сообщает модели', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }]), reply([{ action: 'click', index: 2 }]), reply([{ action: 'done', result: 'ok' }])]);
    const runner = new AgentRunner({ ...cfg, approveEachStep: true }, h.deps);
    const done = runner.run();
    await until(runner, 'awaiting_approval');
    expect(runner.state.pendingApproval?.actions[0]!.action).toEqual({ action: 'click', index: 1 });
    runner.approve(false);
    await until(runner, 'awaiting_approval', 2);
    runner.approve(true);
    const state = await done;
    expect(state.status).toBe('done');
    expect(h.executed).toEqual([{ action: 'click', index: 2 }]);
    expect(state.steps[0]!.notes[0]).toMatch(/rejected/);
    // done не требует одобрения
    expect(state.steps[2]!.actions[0]!.result?.ok).toBe(true);
  });

  it('ask_user: ждёт ответа и передаёт его модели', async () => {
    const h = harness([reply([{ action: 'ask_user', question: 'Какой город?' }]), reply([{ action: 'done', result: 'ok' }])]);
    const runner = new AgentRunner(cfg, h.deps);
    const done = runner.run();
    await until(runner, 'asking_user');
    expect(runner.state.question).toBe('Какой город?');
    runner.answer('Казань');
    const state = await done;
    expect(state.steps[0]!.notes).toEqual(['User answered: Казань']);
    expect(vi.mocked(h.deps.chat).mock.calls[1]![0].at(-1)!.content).toContain('note: User answered: Казань');
  });

  it('пауза вступает в силу перед действием, продолжить — выполняет', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }]), reply([{ action: 'done', result: 'ok' }])]);
    const runner = new AgentRunner(cfg, h.deps);
    runner.pause();
    const done = runner.run();
    await until(runner, 'paused');
    expect(h.executed).toHaveLength(0);
    runner.resume();
    expect((await done).status).toBe('done');
  });

  it('стоп во время ожидания одобрения', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }])]);
    const runner = new AgentRunner({ ...cfg, approveEachStep: true }, h.deps);
    const done = runner.run();
    await until(runner, 'awaiting_approval');
    runner.stop();
    const state = await done;
    expect(state.status).toBe('stopped');
    expect(h.executed).toHaveLength(0);
    expect(state.pendingApproval).toBeUndefined();
  });

  it('таймаут действия превращается в ошибку действия', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }]), reply([{ action: 'done', result: '' }])]);
    h.deps.execute = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const done = new AgentRunner({ ...cfg, stepTimeoutSec: 1 }, h.deps).run();
      await vi.advanceTimersByTimeAsync(1500);
      const state = await done;
      expect(state.steps[0]!.actions[0]!.result).toEqual({ ok: false, message: 'click timed out after 1s' });
    } finally {
      vi.useRealTimers();
    }
  });
});
