// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { collectSnapshot, type TraceVerdict } from '@/lib/dom/collect';
import { describeElement, diagnose } from '@/lib/dom/diagnose';
import type { Geometry } from '@/lib/dom/geometry';
import { serializePage } from '@/lib/dom/serialize';
import type { Rect } from '@/lib/dom/types';

// Та же упрощённая геометрия, что в collect.test.ts: data-rect, hidden, inline cursor.
function fakeGeometry(): Geometry {
  const parseRect = (el: Element): Rect => {
    const raw = el.getAttribute('data-rect');
    if (!raw) return { x: 0, y: 0, width: 100, height: 20 };
    const [x = 0, y = 0, width = 0, height = 0] = raw.split(/\s+/).map(Number);
    return { x, y, width, height };
  };
  const up = (n: Element): Element | null => n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null);
  const isVisible = (el: Element) => {
    for (let n: Element | null = el; n; n = up(n)) {
      if (n.hasAttribute('hidden') || n.hasAttribute('data-invisible') || (n as HTMLElement).style?.display === 'none') return false;
    }
    return true;
  };
  return {
    style: (el) => {
      let cursor = 'auto';
      for (let n: Element | null = el; n; n = up(n)) {
        const c = (n as HTMLElement).style?.cursor;
        if (c) {
          cursor = c;
          break;
        }
      }
      return { display: (el as HTMLElement).style?.display || 'block', cursor, overflowY: 'visible' };
    },
    scrollBox: () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0 }),
    isVisible,
    rect: parseRect,
    frameContentBox: parseRect,
    hitTest(root, x, y) {
      const all = Array.from(root.querySelectorAll('[data-rect]')).reverse();
      return (
        all.find((el) => {
          const r = parseRect(el);
          return isVisible(el) && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
        }) ?? null
      );
    },
    viewport: () => ({ width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 3000 }),
  };
}

function run(html: string, maxChars = 10000, hideNames: string[] = []) {
  document.body.innerHTML = html;
  const trace = new Map<Element, TraceVerdict>();
  const { snapshot } = collectSnapshot(document, fakeGeometry(), { trace, hideNames });
  const page = serializePage(snapshot, { maxChars });
  const input = { trace, shown: new Set(page.shownIndices), totalElements: snapshot.elements.length, walkTruncated: false };
  return (selector: string) => diagnose(document.querySelector(selector)!, input);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('diagnose', () => {
  it('видимый элемент — ok и номер', () => {
    const d = run('<button id="b" data-rect="0 0 100 30">Войти</button>')('#b');
    expect(d).toMatchObject({ ok: true, index: 1 });
    expect(d.verdict).toContain('[1]');
  });

  it('клик по span внутри кнопки засчитывается кнопке', () => {
    const d = run('<button data-rect="0 0 100 30"><span id="s" data-rect="10 5 50 20">Войти</span></button>')('#s');
    expect(d.ok).toBe(true);
    expect(d.verdict).toContain('клик по button');
  });

  it('перекрытый элемент — называет перекрывающий', () => {
    const d = run(`
      <button id="b" data-rect="10 10 50 20">Под модалкой</button>
      <div class="backdrop" data-rect="0 0 1000 800"></div>
    `)('#b');
    expect(d.ok).toBe(false);
    expect(d.verdict).toContain('перекрыт');
    expect(d.details[0]).toContain('div.backdrop');
  });

  it('скрытый предок', () => {
    const d = run('<div style="display:none"><button id="b">Скрыта</button></div>')('#b');
    expect(d.verdict).toContain('display: none');
  });

  it('не влез в лимит', () => {
    const buttons = Array.from({ length: 200 }, (_, i) => `<button data-rect="0 ${i * 30} 100 20">Кнопка ${i}</button>`).join('');
    const d = run(`${buttons}<button id="last" data-rect="0 5000 100 20">Последняя</button>`, 1500)('#last');
    expect(d.ok).toBe(false);
    expect(d.verdict).toContain('не влез в лимит');
  });

  it('клик по tooltip-обёртке объясняет, что показан вложенный элемент', () => {
    const d = run('<span id="w" class="tip" style="cursor:pointer" data-rect="0 0 40 40"><button aria-label="Поиск" data-rect="0 0 40 40"></button></span>')('#w');
    expect(d.ok).toBe(false);
    expect(d.details.join()).toMatch(/обёртка/);
  });

  it('скрытый заметкой элемент объясняется', () => {
    const d = run('<button id="b" aria-label="Оценить" data-rect="0 0 30 30"></button>', 10000, ['оценить'])('#b');
    expect(d.verdict).toMatch(/Скрыть от модели/);
  });

  it('обычный текст — не интерактивен', () => {
    const d = run('<p id="p" data-rect="0 0 100 20">Просто текст</p>')('#p');
    expect(d.ok).toBe(false);
    expect(d.verdict).toContain('Не распознан');
    expect(d.details[0]).toContain('<p>');
  });
});

describe('describeElement', () => {
  it('тег, id, классы и текст', () => {
    document.body.innerHTML = '<button id="go" class="btn primary big">  Пора   поверстать </button>';
    expect(describeElement(document.querySelector('button')!)).toBe('button#go.btn.primary "Пора поверстать"');
  });
});
