import type { OverlayItem } from './overlay';

export interface PickerOptions {
  /** Показать рамку вокруг элемента под курсором (null — убрать). */
  onHover: (item: OverlayItem | null, el: Element | null) => void;
  /** Свои служебные элементы — их выбирать нельзя. */
  ignore: (el: Element) => boolean;
}

const BLOCKED_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick'] as const;

/** Все документы, куда можно повесить обработчики: верхний и same-origin iframe. */
function reachableDocuments(root: Document): Document[] {
  const docs = [root];
  for (let i = 0; i < docs.length; i++) {
    for (const frame of Array.from(docs[i]!.querySelectorAll('iframe, frame'))) {
      try {
        const d = (frame as HTMLIFrameElement).contentDocument;
        if (d) docs.push(d);
      } catch {
        // чужой origin
      }
    }
  }
  return docs;
}

/**
 * Режим «выбери элемент мышью», как инспектор в DevTools. Клик не доходит до страницы.
 * Возвращает выбранный элемент или null (Esc / cancel).
 */
export class ElementPicker {
  private cleanup: (() => void) | null = null;
  private resolve: ((el: Element | null) => void) | null = null;

  constructor(
    private readonly doc: Document,
    private readonly opts: PickerOptions,
  ) {}

  get active(): boolean {
    return this.cleanup !== null;
  }

  pick(rectOf: (el: Element) => OverlayItem['rect']): Promise<Element | null> {
    this.cancel();
    return new Promise((resolve) => {
      this.resolve = resolve;
      const docs = reachableDocuments(this.doc);

      // composedPath()[0] — настоящая цель, даже внутри открытого shadow root.
      const targetOf = (e: Event): Element | null => {
        const t = e.composedPath()[0];
        return t && (t as Node).nodeType === 1 && !this.opts.ignore(t as Element) ? (t as Element) : null;
      };

      const onMove = (e: Event) => {
        const el = targetOf(e);
        this.opts.onHover(el ? { index: 0, label: '?', rect: rectOf(el) } : null, el);
      };
      const block = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.type === 'click') this.finish(targetOf(e));
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        this.finish(null);
      };

      for (const d of docs) {
        d.addEventListener('mousemove', onMove, true);
        for (const type of BLOCKED_EVENTS) d.addEventListener(type, block, true);
        d.addEventListener('keydown', onKey, true);
      }
      const prevCursor = this.doc.documentElement.style.cursor;
      this.doc.documentElement.style.cursor = 'crosshair';

      this.cleanup = () => {
        for (const d of docs) {
          d.removeEventListener('mousemove', onMove, true);
          for (const type of BLOCKED_EVENTS) d.removeEventListener(type, block, true);
          d.removeEventListener('keydown', onKey, true);
        }
        this.doc.documentElement.style.cursor = prevCursor;
        this.opts.onHover(null, null);
      };
    });
  }

  cancel(): void {
    this.finish(null);
  }

  private finish(el: Element | null): void {
    const resolve = this.resolve;
    this.cleanup?.();
    this.cleanup = null;
    this.resolve = null;
    resolve?.(el);
  }
}
