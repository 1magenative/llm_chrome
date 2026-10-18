import { describe, expect, it } from 'vitest';
import { buildHistory } from '@/lib/agent/history';
import { actionSignature, fingerprint, LoopDetector, pageSignature } from '@/lib/agent/loop';
import type { StepRecord } from '@/lib/agent/types';

function step(n: number, patch: Partial<StepRecord> = {}): StepRecord {
  return {
    n,
    startedAt: 0,
    url: `https://example.com/page${n}`,
    reasoning: `Причина шага ${n}`,
    expectedOutcome: `Ожидание ${n}`,
    actions: [{ action: { action: 'click', index: n }, target: `button "Кнопка ${n}"`, result: { ok: true, message: 'clicked' } }],
    warnings: [],
    notes: [],
    ...patch,
  };
}

describe('buildHistory', () => {
  it('пустая история', () => {
    expect(buildHistory([], [])).toBe('');
  });

  it('заметки extract всегда в начале', () => {
    const h = buildHistory([step(1)], ['Цена: 100 ₽', 'Адрес: Казань']);
    expect(h.startsWith('Saved notes (from extract):\n1. Цена: 100 ₽\n2. Адрес: Казань')).toBe(true);
  });

  it('последние шаги подробно, старые — одной строкой', () => {
    const h = buildHistory([1, 2, 3, 4, 5].map((n) => step(n)), [], { detailed: 2, maxChars: 10000 });
    expect(h).toContain('Step 1: click [1] → clicked');
    expect(h).toContain('Step 3: click [3] → clicked');
    expect(h).not.toContain('Причина шага 3');
    expect(h).toContain('Step 5 (https://example.com/page5):\n  reasoning: Причина шага 5\n  expected: Ожидание 5\n  - click [5] (button "Кнопка 5") → clicked');
    expect(h.indexOf('Step 1:')).toBeLessThan(h.indexOf('Step 4 ('));
  });

  it('ошибки, пропуски, заметки и предупреждения о цикле', () => {
    const h = buildHistory(
      [
        step(1, {
          actions: [
            { action: { action: 'click', index: 1 }, result: { ok: false, message: 'element [1] is gone' } },
            { action: { action: 'click', index: 2 }, skipped: 'previous action failed' },
          ],
          notes: ['User answered: Казань'],
          warnings: ['LOOP: repeated', 'другое предупреждение'],
        }),
      ],
      [],
    );
    expect(h).toContain('click [1] → FAILED: element [1] is gone');
    expect(h).toContain('click [2] → skipped: previous action failed');
    expect(h).toContain('note: User answered: Казань');
    expect(h).toContain('warning: LOOP: repeated');
    expect(h).not.toContain('другое предупреждение');
  });

  it('не превышает лимит и выбрасывает самые старые шаги', () => {
    const steps = Array.from({ length: 200 }, (_, i) => step(i + 1));
    const h = buildHistory(steps, ['заметка'], { detailed: 3, maxChars: 2000 });
    expect(h.length).toBeLessThanOrEqual(2000);
    expect(h).toMatch(/\(\d+ earlier steps omitted\)/);
    expect(h).toContain('Step 200 (');
    expect(h).toContain('заметка');
    expect(h).not.toContain('Step 1:');
  });
});

describe('LoopDetector', () => {
  it('одно и то же на неизменной странице: warn на N, stop на 2N', () => {
    const d = new LoopDetector(2);
    expect(d.record('click 3', 'p1')).toBe('ok');
    expect(d.record('click 3', 'p1')).toBe('warn');
    expect(d.record('click 3', 'p1')).toBe('warn');
    expect(d.record('click 3', 'p1')).toBe('stop');
  });

  it('изменение страницы или действия сбрасывает счётчик', () => {
    const d = new LoopDetector(2);
    d.record('click 3', 'p1');
    expect(d.record('click 3', 'p2')).toBe('ok');
    expect(d.record('click 4', 'p2')).toBe('ok');
    expect(d.repeats).toBe(1);
  });

  it('fingerprint стабилен и различает тексты', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
    expect(fingerprint('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('pageSignature и actionSignature', () => {
  const obs = (time: string, scroll = 'y=0 of 900', extra = '') =>
    `URL: https://e.com/quiz\nTitle: Тест\nScroll: ${scroll}\n\nInteractive elements in the viewport:\n[1] input[type=radio] "A"\n[2] button "Оценить"${extra}\n\nVisible page text:\nОсталось ${time}`;

  it('не реагирует на таймеры и всплывающие элементы, но видит прокрутку и адрес', () => {
    expect(pageSignature(obs('10:00'))).toBe(pageSignature(obs('09:59', 'y=0 of 900', '\n[3] div "Скопировано"')));
    expect(pageSignature(obs('10:00'))).not.toBe(pageSignature(obs('10:00', 'y=400 of 900')));
    expect(pageSignature(obs('10:00'))).not.toBe(pageSignature(obs('10:00').replace('/quiz', '/next')));
  });

  it('действие узнаётся по элементу, даже если номер сменился', () => {
    const a = actionSignature([{ action: { action: 'click', index: 13 }, target: 'div "<!-- ссылка -->"' }]);
    const b = actionSignature([{ action: { action: 'click', index: 15 }, target: 'div "<!-- ссылка -->"' }]);
    const c = actionSignature([{ action: { action: 'click', index: 13 }, target: 'button "Далее"' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(actionSignature([{ action: { action: 'scroll', direction: 'down', amount: 1 } }])).toContain('scroll');
  });
});
