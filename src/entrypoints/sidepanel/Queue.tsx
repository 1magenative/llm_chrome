import { useEffect, useState } from 'preact/hooks';
import { browser } from '#imports';
import type { DeferredItem } from '@/lib/agent/types';
import { isUiEvent, sendToBackground } from '@/lib/messages';
import { ActionLine } from './StepCard';

const STATUS: Record<DeferredItem['status'], string> = {
  pending: 'ждёт',
  resumed: 'продолжено',
  dismissed: 'убрано',
};

/** Очередь на утро: действия, отложенные в автономном режиме до подтверждения человеком. */
export function Queue({ busy }: { busy: boolean }) {
  const [items, setItems] = useState<DeferredItem[]>([]);
  const [error, setError] = useState('');

  const load = async () => {
    const res = await sendToBackground({ type: 'bg:queue-list' });
    if (res.ok) setItems(res.value);
  };

  useEffect(() => {
    void load();
    const listener = (msg: unknown) => {
      if (isUiEvent(msg) && msg.type === 'ui:queue-changed') void load();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  const pending = items.filter((i) => i.status === 'pending');
  if (items.length === 0) return null;

  const call = async (p: ReturnType<typeof sendToBackground>) => {
    setError('');
    const res = await p;
    if (!res.ok) setError(res.error);
  };
  const resume = async (id: string) => {
    const win = await browser.windows.getCurrent();
    await call(sendToBackground({ type: 'bg:queue-resume', id, windowId: win.id! }));
  };

  return (
    <details class={`card queue${pending.length ? ' warn-border' : ''}`} open={pending.length > 0}>
      <summary>
        Очередь на утро{pending.length ? ` — ждут подтверждения: ${pending.length}` : ''}
      </summary>
      {error && <div class="err">{error}</div>}
      <ul>
        {items.map((item) => (
          <li key={item.id} class={item.status === 'pending' ? '' : 'muted'}>
            <div class="runlog-task">{item.task}</div>
            <div class="muted stats">
              {new Date(item.createdAt).toLocaleString()} · шаг {item.step} · {STATUS[item.status]}
            </div>
            <div class="muted stats" title={item.url}>
              {item.title || item.url}
            </div>
            <ol class="actions">
              {item.actions.map((a, i) => (
                <ActionLine key={i} a={{ ...a, skipped: undefined }} />
              ))}
            </ol>
            {item.reasoning && <div class="muted">{item.reasoning}</div>}
            {item.status === 'pending' && (
              <div class="row">
                <button class="primary" disabled={busy} title="Открыть эту страницу и начать обычный запуск с контекстом ночной задачи" onClick={() => void resume(item.id)}>
                  Продолжить отсюда
                </button>
                <button onClick={() => void browser.tabs.create({ url: item.url })}>Открыть страницу</button>
                <button onClick={() => void call(sendToBackground({ type: 'bg:queue-dismiss', id: item.id }))}>Убрать</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
