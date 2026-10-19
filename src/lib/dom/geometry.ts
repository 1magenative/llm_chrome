import type { Rect } from './types';

export interface Viewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  scrollHeight: number;
}

export interface ElementStyle {
  display: string;
  cursor: string;
  overflowY: string;
  /** fixed/sticky — элемент приклеен к экрану (панели, плавающие кнопки), а не часть содержимого. */
  position?: string;
}

export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
}

/**
 * Всё, что сборщику нужно от движка вёрстки. Вынесено в интерфейс, чтобы
 * сборщик можно было тестировать в jsdom, где вёрстки нет.
 */
export interface Geometry {
  style(el: Element): ElementStyle;
  /** Элемент отрисован с учётом display/visibility/opacity предков. */
  isVisible(el: Element): boolean;
  /** Прямоугольник в координатах вьюпорта собственного документа элемента. */
  rect(el: Element): Rect;
  /** Область содержимого iframe (без рамки и отступов) в координатах его документа. */
  frameContentBox(frame: Element): Rect;
  /** Самый верхний элемент в точке (координаты документа root). */
  hitTest(root: Document | ShadowRoot, x: number, y: number): Element | null;
  /** Вьюпорт верхнего документа. */
  viewport(): Viewport;
  /** Метрики прокрутки элемента (для поиска внутреннего контейнера прокрутки SPA). */
  scrollBox(el: Element): ScrollBox;
}

function computed(el: Element): CSSStyleDeclaration | null {
  return el.ownerDocument.defaultView?.getComputedStyle(el) ?? null;
}

export function browserGeometry(win: Window): Geometry {
  return {
    style(el) {
      const cs = computed(el);
      return { display: cs?.display ?? 'block', cursor: cs?.cursor ?? 'auto', overflowY: cs?.overflowY ?? 'visible', position: cs?.position ?? 'static' };
    },
    isVisible(el) {
      if (typeof el.checkVisibility === 'function') {
        // Старые и новые имена опций: Chrome < 121 понимает только checkOpacity/checkVisibilityCSS.
        return el.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
          opacityProperty: true,
          visibilityProperty: true,
        } as CheckVisibilityOptions);
      }
      const cs = computed(el);
      return !!cs && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    },
    rect(el) {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    frameContentBox(frame) {
      const r = frame.getBoundingClientRect();
      const cs = computed(frame);
      const padL = cs ? parseFloat(cs.paddingLeft) || 0 : 0;
      const padT = cs ? parseFloat(cs.paddingTop) || 0 : 0;
      const padR = cs ? parseFloat(cs.paddingRight) || 0 : 0;
      const padB = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
      return {
        x: r.left + frame.clientLeft + padL,
        y: r.top + frame.clientTop + padT,
        width: Math.max(0, frame.clientWidth - padL - padR),
        height: Math.max(0, frame.clientHeight - padT - padB),
      };
    },
    hitTest(root, x, y) {
      return root.elementFromPoint(x, y);
    },
    scrollBox(el) {
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, clientWidth: el.clientWidth };
    },
    viewport() {
      const doc = win.document;
      const scroller = doc.scrollingElement ?? doc.documentElement;
      return {
        width: win.innerWidth,
        height: win.innerHeight,
        scrollX: win.scrollX,
        scrollY: win.scrollY,
        scrollHeight: scroller.scrollHeight,
      };
    },
  };
}
