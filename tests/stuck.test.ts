import { describe, expect, it } from 'vitest';
import { atBottom, updateStuck } from '@/lib/agent/stuck';
import type { ExecutedAction } from '@/lib/agent/types';

const ex = (index: number, ok = true, message = 'ok', navigated = false): ExecutedAction => ({
  action: { action: 'click', index },
  target: `button "${index}"`,
  result: { ok, message, ...(navigated ? { navigated } : {}) },
});

describe('updateStuck', () => {
  it('неудача и повтор копят счётчик, новое полезное действие сбрасывает', () => {
    let r = updateStuck(undefined, 'p', [ex(1, false, 'element [1] is disabled')]);
    expect([r.unproductive, r.state.streak]).toEqual([true, 1]);
    r = updateStuck(r.state, 'p', [ex(1, false, 'element [1] is disabled')]);
    expect(r.state.streak).toBe(2);
    r = updateStuck(r.state, 'p', [ex(2)]);
    expect([r.unproductive, r.state.streak]).toEqual([false, 0]);
    r = updateStuck(r.state, 'p', [ex(2)]); // повтор уже сделанного здесь
    expect([r.unproductive, r.state.streak]).toEqual([true, 1]);
  });

  it('«ничего не изменилось» — тоже без пользы; другое место или переход — сброс', () => {
    let r = updateStuck(undefined, 'p', [ex(1, true, 'clicked, but nothing on the page changed — …')]);
    expect(r.state.streak).toBe(1);
    r = updateStuck(r.state, 'q', [ex(1)]);
    expect(r.state).toEqual({ page: 'q', streak: 0, done: ['[{"action":"click","index":"button \\"1\\""}]'] });
    r = updateStuck({ page: 'p', streak: 5, done: [] }, 'p', [ex(3, true, 'ok', true)]);
    expect(r.state.streak).toBe(0);
    expect(updateStuck({ page: 'p', streak: 1, done: [] }, 'p', [{ action: { action: 'click', index: 1 }, skipped: 'x' }]).state.streak).toBe(0);
  });
});

describe('atBottom', () => {
  it('по строке Scroll', () => {
    expect(atBottom('URL: x\nScroll: y=1999 of 2000 (100%), viewport 1x1')).toBe(true);
    expect(atBottom('Scroll: y=0 of 2000 (0%)')).toBe(false);
    expect(atBottom('Scroll: none (page fits in viewport 1x1)')).toBe(true);
    expect(atBottom('нет строки')).toBe(false);
  });
});
