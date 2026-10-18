// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ElementPicker } from '@/lib/dom/picker';

describe('ElementPicker', () => {
  it('возвращает кликнутый элемент и не пропускает клик на страницу', async () => {
    document.body.innerHTML = '<button id="b">OK</button>';
    const pageClick = vi.fn();
    document.getElementById('b')!.addEventListener('click', pageClick);
    const onHover = vi.fn();
    const picker = new ElementPicker(document, { onHover, ignore: () => false });

    const picked = picker.pick(() => () => ({ x: 0, y: 0, width: 1, height: 1 }));
    expect(picker.active).toBe(true);
    const btn = document.getElementById('b')!;
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
    expect(onHover).toHaveBeenLastCalledWith(expect.objectContaining({ label: '?' }), btn);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));

    await expect(picked).resolves.toBe(btn);
    expect(pageClick).not.toHaveBeenCalled();
    expect(picker.active).toBe(false);
    expect(onHover).toHaveBeenLastCalledWith(null, null);
  });

  it('Esc и cancel() отменяют выбор', async () => {
    const picker = new ElementPicker(document, { onHover: () => {}, ignore: () => false });
    const p1 = picker.pick(() => () => ({ x: 0, y: 0, width: 1, height: 1 }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p1).resolves.toBeNull();

    const p2 = picker.pick(() => () => ({ x: 0, y: 0, width: 1, height: 1 }));
    picker.cancel();
    await expect(p2).resolves.toBeNull();
  });

  it('видит цель внутри открытого shadow root', async () => {
    document.body.innerHTML = '<x-host></x-host>';
    const shadow = document.querySelector('x-host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>В тени</button>';
    const picker = new ElementPicker(document, { onHover: () => {}, ignore: () => false });
    const picked = picker.pick(() => () => ({ x: 0, y: 0, width: 1, height: 1 }));
    const inner = shadow.querySelector('button')!;
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    await expect(picked).resolves.toBe(inner);
  });
});
