import { describe, expect, it } from 'vitest';
import { LoopDetector } from '@/lib/agent/loop';
import { describeForResume, resumeTask, sameUrl } from '@/lib/agent/queue';
import type { DeferredItem } from '@/lib/agent/types';
import { DEFAULT_SETTINGS, sanitizeSettings } from '@/lib/settings';

const item: DeferredItem = {
  id: 'q1',
  runId: 'r1',
  task: 'Ответь на все непрочитанные письма',
  createdAt: 1,
  step: 4,
  url: 'https://mail.example/inbox/42',
  title: 'Письмо от Ани',
  actions: [
    { action: { action: 'type', index: 9, text: 'Спасибо, получил!', submit: true }, target: 'textarea placeholder="Ответ"', risk: [{ kind: 'send', why: 'Enter' }] },
    { action: { action: 'click', index: 3 }, target: 'button "Архив"' },
  ],
  reasoning: 'Отвечаю Ане',
  expectedOutcome: 'письмо отправлено',
  extracted: ['У Ани вопрос про встречу'],
  status: 'pending',
};

describe('очередь на утро', () => {
  it('действие описывается по элементу, а не по устаревшему номеру', () => {
    expect(describeForResume(item.actions[0]!)).toBe('type "Спасибо, получил!" into textarea placeholder="Ответ" and press Enter');
    expect(describeForResume(item.actions[1]!)).toBe('click button "Архив"');
    expect(describeForResume({ action: { action: 'click', index: 5 } })).toBe('click element [5]');
    expect(describeForResume({ action: { action: 'navigate', url: 'https://x.example' } })).toBe('navigate https://x.example');
  });

  it('утренняя задача: исходная задача первой, затем контекст ночного запуска', () => {
    const task = resumeTask(item);
    expect(task.startsWith('Ответь на все непрочитанные письма\n\nContext:')).toBe(true);
    expect(task).toContain('On https://mail.example/inbox/42 ("Письмо от Ани")');
    expect(task).toContain('- type "Спасибо, получил!" into textarea');
    expect(task).toContain('- У Ани вопрос про встречу');
    expect(task).toContain('Risky actions will be confirmed by the user.');
  });

  it('sameUrl не учитывает якорь', () => {
    expect(sameUrl('https://a.example/p#x', 'https://a.example/p')).toBe(true);
    expect(sameUrl('https://a.example/p?1', 'https://a.example/p')).toBe(false);
    expect(sameUrl(undefined, 'https://a.example/p')).toBe(false);
  });
});

describe('детектор зацикливания в чекпоинте', () => {
  it('состояние переживает перезапуск', () => {
    const a = new LoopDetector(2);
    a.record('click X', 'page');
    const b = new LoopDetector(2, structuredClone(a.snapshot()));
    expect(b.record('click X', 'page')).toBe('warn');
    expect(b.repeats).toBe(2);
  });
});

describe('настройки этапа 6', () => {
  it('по умолчанию: пошаговый режим выключен, звук и окно 120 с', () => {
    expect(DEFAULT_SETTINGS.agent.approveEachStep).toBe(false);
    expect(DEFAULT_SETTINGS.safety).toMatchObject({ sound: true, approvalWindowSec: 120 });
  });

  it('старые настройки без safety и полей заметок дополняются', () => {
    const s = sanitizeSettings({ siteNotes: [{ pattern: 'hh.ru', notes: 'x', hide: '' }], safety: { approvalWindowSec: 99999, rules: { send: 'сдать' } } });
    expect(s.siteNotes[0]).toEqual({ pattern: 'hh.ru', notes: 'x', hide: '', risk: 'ask', safe: '', next: '' });
    expect(s.safety.approvalWindowSec).toBe(3600);
    expect(s.safety.rules.send).toBe('сдать');
    expect(s.safety.rules.payment).toBe(DEFAULT_SETTINGS.safety.rules.payment);
    expect(sanitizeSettings({ siteNotes: [{ pattern: 'a', risk: 'nonsense' }, { pattern: 'b', risk: 'block', safe: 'Ок' }] }).siteNotes.map((n) => [n.risk, n.safe])).toEqual([
      ['ask', ''],
      ['block', 'Ок'],
    ]);
  });
});
