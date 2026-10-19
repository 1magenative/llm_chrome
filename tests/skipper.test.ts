import { describe, expect, it } from 'vitest';
import { Skipper, type SkipDeps, type SkipObservation } from '@/lib/agent/skipper';
import type { ElementBrief } from '@/lib/agent/types';

/** Игрушечная страница курса: элементы, реакции на клик, переходы. */
interface FakeEl {
  line: string;
  y: number;
  disabled?: boolean;
  next?: boolean;
  clickable?: boolean;
  pinned?: boolean;
  inFrame?: boolean;
  /** Что делает клик. */
  onClick?: (page: FakePage) => void;
}
interface FakePage {
  url: string;
  els: FakeEl[];
  clicks: string[];
  scrolls: number;
}

function deps(page: FakePage): SkipDeps {
  const observe = async (): Promise<SkipObservation> => ({
    url: page.url,
    elements: page.els.map((e, i): ElementBrief => ({ index: i + 1, line: e.line, y: e.y, disabled: !!e.disabled, next: !!e.next, clickable: e.clickable ?? true, pinned: !!e.pinned, inFrame: !!e.inFrame })),
    handle: { frames: [], owner: {}, nodes: [] },
  });
  return {
    observe,
    click: async (index) => {
      const el = page.els[index - 1]!;
      page.clicks.push(el.line);
      const url = page.url;
      el.onClick?.(page);
      return { ok: true, message: 'clicked', navigated: page.url !== url };
    },
    scrollToBottom: async () => void page.scrolls++,
    isRisky: (line) => /Оплатить/.test(line),
    sleep: async () => {},
    onState: () => {},
  };
}

const cfg = { bottomRepeats: 3, settleMs: 0, maxClicks: 100, maxSameClicks: 8 };

describe('Skipper — пролистывание курса без модели', () => {
  it('жмёт нижнюю кнопку, пока она открывает новые блоки, и уходит на следующий урок', async () => {
    const page: FakePage = { url: 'https://p.example/lesson/1', els: [], clicks: [], scrolls: 0 };
    const reveal = (n: number) => (p: FakePage) => {
      p.els = p.els.filter((e) => !e.line.startsWith('button "Блок'));
      if (n < 3) p.els.push({ line: `button "Блок ${n + 1}: Ура!"`, y: 1000 * (n + 1), onClick: reveal(n + 1) });
      else p.els.push({ line: 'button "🔬🧪"', y: 5000, onClick: (q) => void ((q.url = 'https://other.example/x'), (q.els = [])) });
    };
    page.els = [
      { line: 'code-editor lines="14"', y: 300, clickable: false },
      { line: 'button "Сбросить"', y: 900 },
      { line: 'button "Блок 1: Ура! Появился квадрат!"', y: 1000, onClick: reveal(1) },
    ];
    const s = await new Skipper(deps(page), cfg).run();
    expect(page.clicks).toEqual(['button "Блок 1: Ура! Появился квадрат!"', 'button "Блок 2: Ура!"', 'button "Блок 3: Ура!"', 'button "🔬🧪"']);
    expect(page.clicks).not.toContain('button "Сбросить"'); // запрещённое не жмётся никогда
    expect(s.status).toBe('done'); // ушли на другой сайт — остановка
    expect(page.scrolls).toBeGreaterThan(0);
  });

  it('нижняя не реагирует → повтор, затем кнопки снизу вверх с возвратом вниз', async () => {
    let chosen = false;
    const page: FakePage = {
      url: 'https://p.example/quiz',
      clicks: [],
      scrolls: 0,
      els: [
        { line: 'input[type=radio] "Вариант А"', y: 100, onClick: () => void (chosen = true) },
        { line: 'input[type=radio] "Вариант Б"', y: 200 },
        { line: 'button "Дальше"', y: 900, onClick: (p) => void (chosen && (p.url = 'https://p.example/next', (p.els = []))) },
      ],
    };
    await new Skipper(deps(page), cfg).run();
    expect(page.clicks).toEqual([
      'button "Дальше"', 'button "Дальше"', 'button "Дальше"', // три попытки нижней
      'input[type=radio] "Вариант Б"', 'button "Дальше"',       // снизу вверх, после каждой — нижняя
      'input[type=radio] "Вариант А"', 'button "Дальше"',
    ]);
    expect(page.url).toBe('https://p.example/next');
  });

  it('кнопка «Далее» из заметки сайта жмётся первой, неактивные и рискованные пропускаются', async () => {
    const page: FakePage = {
      url: 'https://p.example/a',
      clicks: [],
      scrolls: 0,
      els: [
        { line: 'button "🔬🧪" ← NEXT', y: 400, next: true, onClick: (p) => void ((p.url = 'https://x.example'), (p.els = [])) },
        { line: 'button "Проверить" disabled', y: 800, disabled: true },
        { line: 'button "Оплатить"', y: 900 },
        { line: 'a "Яндекс" href="ya.ru/"', y: 950 },
      ],
    };
    await new Skipper(deps(page), cfg).run();
    expect(page.clicks).toEqual(['button "🔬🧪" ← NEXT']);
  });

  it('если ничего не помогает — честно останавливается, а не крутится вечно', async () => {
    const page: FakePage = { url: 'https://p.example/dead', clicks: [], scrolls: 0, els: [{ line: 'button "А"', y: 1 }, { line: 'button "Б"', y: 2 }] };
    const s = await new Skipper(deps(page), cfg).run();
    expect(s.status).toBe('stuck');
    expect(page.clicks.length).toBeLessThan(10);
  });

  it('кнопка, которая всё время что-то меняет, не жмётся бесконечно', async () => {
    let n = 0;
    const page: FakePage = { url: 'https://p.example/toggle', clicks: [], scrolls: 0, els: [] };
    page.els = [{ line: 'button "Свернуть"', y: 10, onClick: (p) => void p.els.push({ line: `p${n++}`, y: 0, clickable: false }) }];
    const s = await new Skipper(deps(page), cfg).run();
    expect(page.clicks.length).toBe(8);
    expect(s.status).toBe('stuck');
  });

  it('кнопка урока важнее иконок боковой панели и тренажёра, хоть они и ниже на экране', async () => {
    const page: FakePage = { url: 'https://p.example/lesson/1', els: [], clicks: [], scrolls: 0 };
    page.els = [
      { line: 'button "Расскажи анекдот"', y: 2400, onClick: (p) => void (p.url = 'https://p.example/lesson/2') },
      { line: 'button', y: 2900, pinned: true }, // иконка боковой панели (8 на скриншоте)
      { line: 'button', y: 2950, inFrame: true }, // иконка в тренажёре (60)
      { line: 'button "Чат с наставником"', y: 2980, pinned: true },
    ];
    await new Skipper(deps(page), { ...cfg, maxClicks: 1 }).run();
    expect(page.clicks[0]).toBe('button "Расскажи анекдот"');
  });

  it('«Дальше» в приклеенной нижней панели урока всё же жмётся', async () => {
    const page: FakePage = { url: 'https://p.example/lesson/1', els: [], clicks: [], scrolls: 0 };
    page.els = [
      { line: 'button', y: 2000 },
      { line: 'button "Дальше"', y: 2950, pinned: true },
    ];
    await new Skipper(deps(page), { ...cfg, maxClicks: 1 }).run();
    expect(page.clicks[0]).toBe('button "Дальше"');
  });
});
