import { browser } from '#imports';

const INTERVAL_MS = 20_000;

/**
 * Не даёт Chrome выгрузить service worker во время долгой операции.
 * Таймер простоя (30 с) сбрасывают только вызовы extension API, а не байты из fetch,
 * поэтому раз в 20 с дёргаем самый дешёвый из них. Возвращает функцию остановки.
 */
export function startKeepAlive(): () => void {
  const id = setInterval(() => {
    void browser.runtime.getPlatformInfo().catch(() => {});
  }, INTERVAL_MS);
  return () => clearInterval(id);
}
