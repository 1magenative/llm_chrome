import { useEffect, useState } from 'preact/hooks';
import { browser } from '#imports';
import type { CourseState } from '@/lib/agent/course';
import { isUiEvent, sendToBackground } from '@/lib/messages';
import { saveSettings, type Settings } from '@/lib/settings';

const LABELS: Record<CourseState['status'], string> = {
  running: 'пролистываю',
  done: 'готово',
  stuck: 'застрял',
  stopped: 'остановлено',
  failed: 'ошибка',
};

/**
 * «Пролистать курс»: без модели — вниз, нижняя кнопка, затем кнопки снизу вверх.
 * На заминке (нет кнопок, перебрал все, ходит по кругу) зовёт нейросеть, а когда она
 * сдвинула курс с места — снова листает сам.
 */
export function SkipPanel({ busy, settings }: { busy: boolean; settings: Settings }) {
  const [state, setState] = useState<CourseState | null>(null);
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
  const agent = running && state.mode === 'agent';
  // Идущий проход пролистывания ещё не учтён в общих счётчиках.
  const live = running && state.mode === 'skip' && state.skip?.status === 'running' ? state.skip : null;
  const clicks = (state?.clicks ?? 0) + (live?.clicks ?? 0);
  const pages = (state?.pages ?? 0) + (live?.pages ?? 0);

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
            {agent ? '🧠 разбирается нейросеть' : LABELS[state.status]} · кликов {clicks} · страниц {pages}
            {state.handoffs > 0 && ` · нейросеть ×${state.handoffs}`}
          </span>
        )}
      </div>
      <label class="check" title="Застряв (нет кнопок, все перебраны, хожу по кругу), пролистывание передаёт страницу нейросети. Как только курс сдвинулся — снова листает само">
        <input
          type="checkbox"
          checked={settings.agent.skipWithAgent}
          disabled={running}
          onChange={(e) => void saveSettings({ ...settings, agent: { ...settings.agent, skipWithAgent: e.currentTarget.checked } })}
        />
        Застрял — звать нейросеть, потом листать дальше
      </label>
      {agent && state.note && <div class="muted">{state.note}</div>}
      {live?.last && <div class="muted mono runlog-task">{live.last}</div>}
      {state?.message && !running && <div class={state.status === 'stuck' || state.status === 'failed' ? 'warn' : 'muted'}>{state.message}</div>}
      {error && <div class="err">{error}</div>}
    </div>
  );
}
