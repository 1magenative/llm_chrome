export interface StableOptions {
  /** Сколько миллисекунд без изменений DOM считать «успокоился». */
  quietMs: number;
  /** Дольше не ждём: бесконечные анимации, тикеры, чаты. */
  timeoutMs: number;
}

export interface StableResult {
  mutations: number;
  timedOut: boolean;
  ms: number;
}

export const DEFAULT_STABLE: StableOptions = { quietMs: 400, timeoutMs: 4000 };

/** Ждёт, пока DOM перестанет меняться (MutationObserver), но не дольше timeoutMs. */
export function waitForStable(doc: Document, opts: StableOptions = DEFAULT_STABLE): Promise<StableResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    let mutations = 0;
    let quiet: ReturnType<typeof setTimeout>;
    const finish = (timedOut: boolean) => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(hard);
      resolve({ mutations, timedOut, ms: Math.round(performance.now() - started) });
    };
    const observer = new MutationObserver((records) => {
      mutations += records.length;
      clearTimeout(quiet);
      quiet = setTimeout(() => finish(false), opts.quietMs);
    });
    observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    quiet = setTimeout(() => finish(false), opts.quietMs);
    const hard = setTimeout(() => finish(true), opts.timeoutMs);
  });
}
