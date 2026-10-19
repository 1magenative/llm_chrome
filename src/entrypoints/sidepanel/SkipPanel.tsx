import { useEffect, useState } from 'preact/hooks';
import { browser } from '#imports';
import type { SkipState } from '@/lib/agent/skipper';
import { isUiEvent, sendToBackground } from '@/lib/messages';

const LABELS: Record<SkipState['status'], string> = {
  running: 'пролистываю',
  done: 'готово',
  stuck: 'застрял',
  stopped: 'остановлено',
  failed: 'ошибка',
};

/**
 * Пролистывание курса без модели: вниз → нижняя кнопка, если не помогло — кнопки снизу вверх.
 * Для курсов, где содержимое можно не читать, а только жать «дальше».
 */
export function SkipPanel({ busy }: { busy: boolean }) {
  const [state, setState] = useState<SkipState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void sendToBackground({ type: 'bg:skip-get' }).then((r) => r.ok && setState(r.value));
    const listener = (msg: unknown) => {
      if (isUiEvent(msg) && msg.type === 'ui:skip-state') setState(msg.state);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  const running = state?.status === 'running';

  const start = async () => {
    setError('');
    const win = await browser.windows.getCurrent();
    const r = await sendToBackground({ type: 'bg:skip-start', windowId: win.id! });
    if (!r.ok) setError(r.error);
  };

  return (
    <div class={`card skip${running ? ' warn-border' : ''}`}>
      <div class="row">
        {running ? (
          <button onClick={() => void sendToBackground({ type: 'bg:skip-stop' })}>Остановить пролистывание</button>
        ) : (
          <button
            onClick={() => void start()}
            disabled={busy}
            title="Без модели: прокрутить вниз, нажать нижнюю кнопку; если ничего не изменилось — повторить, затем перебирать кнопки снизу вверх, каждый раз возвращаясь вниз"
          >
            ⏩ Пролистать курс
          </button>
        )}
        {state && (
          <span class="muted">
            {LABELS[state.status]} · кликов {state.clicks} · страниц {state.pages}
          </span>
        )}
      </div>
      {state?.last && running && <div class="muted mono runlog-task">{state.last}</div>}
      {state?.message && !running && <div class={state.status === 'stuck' || state.status === 'failed' ? 'warn' : 'muted'}>{state.message}</div>}
      {error && <div class="err">{error}</div>}
    </div>
  );
}
