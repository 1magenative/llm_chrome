import { describe, expect, it, vi } from 'vitest';
import { runStep, type StepDeps, type StepEvent, type StepInput } from '@/lib/agent/step';
import type { ChatMessage, ChatResult } from '@/lib/llm/client';

const input: StepInput = {
  task: 'Нажми «Войти»',
  systemTemplate: 'SYS {{MAX_ACTIONS}}',
  boundary: 'b1',
  maxActions: 3,
  maxRetries: 2,
  contextTokens: 16384,
  maxOutputTokens: 1024,
};

const reply = (content: string, finishReason = 'stop'): ChatResult => ({ content, reasoning: '', format: 'json_schema', finishReason, totalMs: 10, ttftMs: 5 });

function deps(replies: ChatResult[]): StepDeps & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    observe: vi.fn(async () => ({ observation: '[1] button "Войти"', tabs: [] })),
    chat: vi.fn(async (messages: ChatMessage[], _schema, onDelta) => {
      calls.push(structuredClone(messages));
      const r = replies.shift()!;
      onDelta({ content: r.content, reasoning: '' });
      return r;
    }),
  };
}

describe('runStep', () => {
  it('удачный шаг с первой попытки', async () => {
    const d = deps([reply('{"reasoning":"r","expected_outcome":"e","actions":[{"action":"click","index":1}]}')]);
    const events: StepEvent[] = [];
    const out = await runStep(input, d, (e) => events.push(e));
    expect(out.step?.actions).toEqual([{ action: 'click', index: 1 }]);
    expect(out.error).toBeUndefined();
    expect(out.attempts).toHaveLength(1);
    expect(out.observation).toBe('[1] button "Войти"');
    expect(events.map((e) => e.phase)).toEqual(['observe', 'llm', 'delta']);
    expect(d.calls[0]![0]).toEqual({ role: 'system', content: 'SYS 3' });
  });

  it('переспрашивает с текстом ошибки и принимает исправленный ответ', async () => {
    const d = deps([reply('Нажму кнопку войти'), reply('{"actions":[{"action":"click","index":1}]}')]);
    const events: StepEvent[] = [];
    const out = await runStep(input, d, (e) => events.push(e));
    expect(out.step?.actions).toEqual([{ action: 'click', index: 1 }]);
    expect(out.attempts.map((a) => a.parseError)).toEqual(['no valid JSON object found in the reply', undefined]);
    const second = d.calls[1]!;
    expect(second.at(-2)).toEqual({ role: 'assistant', content: 'Нажму кнопку войти' });
    expect(second.at(-1)!.content).toContain('no valid JSON object');
    expect(events.some((e) => e.phase === 'parse-error')).toBe(true);
  });

  it('обрыв по лимиту токенов подсказывает сократить рассуждения', async () => {
    const d = deps([reply('{"reasoning":"очень длинно', 'length'), reply('{"actions":[{"action":"go_back"}]}')]);
    await runStep(input, d);
    expect(d.calls[1]!.at(-1)!.content).toContain('cut off by the token limit');
  });

  it('сдаётся после maxRetries+1 попыток', async () => {
    const d = deps([reply('нет'), reply('нет'), reply('нет')]);
    const out = await runStep(input, d);
    expect(out.step).toBeUndefined();
    expect(out.attempts).toHaveLength(3);
    expect(out.error).toMatch(/за 3 попыток/);
  });

  it('предупреждает о переполнении контекста', async () => {
    const d = deps([reply('{"actions":[{"action":"go_back"}]}')]);
    const out = await runStep({ ...input, contextTokens: 1024, maxOutputTokens: 1000 }, d);
    expect(out.warnings.join()).toMatch(/больше бюджета контекста/);
  });

  it('предупреждения парсера попадают в результат', async () => {
    const d = deps([reply('{"actions":[{"action":"done","result":"ok"},{"action":"click","index":1}]}')]);
    const out = await runStep(input, d);
    expect(out.warnings.join()).toMatch(/dropped 1 action/);
  });
});
