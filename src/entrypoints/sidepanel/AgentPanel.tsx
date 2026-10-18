import { useEffect, useState } from 'preact/hooks';
import { browser } from '#imports';
import { TERMINAL_STATUSES, type RunState, type RunStatus } from '@/lib/agent/types';
import { isUiEvent, sendToBackground } from '@/lib/messages';
import { saveSettings, type Settings } from '@/lib/settings';
import { ActionLine, StepCard } from './StepCard';

export const STATUS_LABELS: Record<RunStatus, string> = {
  running: 'работает',
  paused: 'на паузе',
  awaiting_approval: 'ждёт одобрения',
  asking_user: 'ждёт ответа',
  done: 'готово',
  failed: 'ошибка',
  stopped: 'остановлен',
};

interface Live {
  phase: string;
  content: string;
  reasoningChars: number;
}

/** Текущее состояние запуска из background + живой поток токенов модели. */
function useRun(): { run: RunState | null; live: Live } {
  const [run, setRun] = useState<RunState | null>(null);
  const [live, setLive] = useState<Live>({ phase: '', content: '', reasoningChars: 0 });

  useEffect(() => {
    void sendToBackground({ type: 'bg:run-get' }).then((res) => res.ok && setRun(res.value));
    const listener = (msg: unknown) => {
      if (!isUiEvent(msg)) return;
      if (msg.type === 'ui:run-state') return setRun(msg.state);
      const e = msg.event;
      setLive((l) => {
        switch (e.phase) {
          case 'observe':
            return { phase: 'Смотрю на страницу…', content: '', reasoningChars: 0 };
          case 'llm':
            return { phase: e.attempt > 1 ? `Переспрашиваю модель (попытка ${e.attempt})…` : 'Модель думает…', content: '', reasoningChars: 0 };
          case 'delta':
            return { ...l, content: l.content + e.content, reasoningChars: l.reasoningChars + e.reasoning.length };
          case 'parse-error':
            return { ...l, phase: `Неразборчивый ответ: ${e.error}` };
        }
      });
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  return { run, live };
}

export function AgentPanel({ task, settings }: { task: string; settings: Settings }) {
  const { run, live } = useRun();
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState('');
  const active = run !== null && !TERMINAL_STATUSES.has(run.status);

  const call = async (p: ReturnType<typeof sendToBackground>) => {
    setError('');
    const res = await p;
    if (!res.ok) setError(res.error);
  };

  const start = async () => {
    const win = await browser.windows.getCurrent();
    await call(sendToBackground({ type: 'bg:run-start', windowId: win.id!, task }));
  };
  const control = (command: 'pause' | 'resume' | 'stop') => void call(sendToBackground({ type: 'bg:run-control', command }));

  const sendAnswer = () => {
    void call(sendToBackground({ type: 'bg:run-answer', text: answer }));
    setAnswer('');
  };

  const steps = run ? [...run.steps].reverse() : [];

  return (
    <>
      <div class="row controls">
        {!active && (
          <button class="primary" onClick={() => void start()} disabled={!task.trim()}>
            Старт
          </button>
        )}
        {active && run.status === 'paused' ? (
          <button class="primary" onClick={() => control('resume')}>
            Продолжить
          </button>
        ) : (
          active && (
            <button onClick={() => control('pause')} disabled={run.pauseRequested}>
              {run.pauseRequested ? 'Пауза после шага…' : 'Пауза'}
            </button>
          )
        )}
        {active && <button onClick={() => control('stop')}>Стоп</button>}
      </div>

      <label class="check">
        <input
          type="checkbox"
          checked={settings.agent.approveEachStep}
          disabled={active}
          onChange={(e) => void saveSettings({ ...settings, agent: { ...settings.agent, approveEachStep: e.currentTarget.checked } })}
        />
        Подтверждать каждый шаг
      </label>

      {error && <div class="err">{error}</div>}

      {run && (
        <div class={`card run-status status-${run.status}`}>
          <div>
            <b>{STATUS_LABELS[run.status]}</b> · шаг {run.steps.length} из {run.maxSteps} · {run.model}
          </div>
          <div class="muted runlog-task">{run.task}</div>
        </div>
      )}

      {run?.status === 'awaiting_approval' && run.pendingApproval && (
        <div class="card approval">
          <b>Агент хочет сделать:</b>
          {run.pendingApproval.reasoning && <p>{run.pendingApproval.reasoning}</p>}
          <ol class="actions">
            {run.pendingApproval.actions.map((a, i) => (
              <ActionLine key={i} a={a} />
            ))}
          </ol>
          <div class="row">
            <button class="primary" onClick={() => void call(sendToBackground({ type: 'bg:run-approve', approved: true }))}>
              Выполнить
            </button>
            <button onClick={() => void call(sendToBackground({ type: 'bg:run-approve', approved: false }))}>Отклонить</button>
          </div>
        </div>
      )}

      {run?.status === 'asking_user' && (
        <div class="card approval">
          <b>Агент спрашивает:</b>
          <p>{run.question}</p>
          <textarea rows={2} value={answer} onInput={(e) => setAnswer(e.currentTarget.value)} placeholder="Ваш ответ" />
          <div class="row">
            <button class="primary" onClick={sendAnswer} disabled={!answer.trim()}>
              Ответить
            </button>
          </div>
        </div>
      )}

      {run?.status === 'running' && live.phase && (
        <div class="card live">
          <div class="muted">
            {live.phase}
            {live.reasoningChars > 0 && ` · рассуждения ${live.reasoningChars} симв.`}
          </div>
          {live.content && <pre class="output mono">{live.content}</pre>}
        </div>
      )}

      {run?.status === 'done' && (
        <div class="card result ok-border">
          <b>Результат</b>
          <p class="pre">{run.result || '(пусто)'}</p>
        </div>
      )}
      {(run?.status === 'failed' || run?.status === 'stopped') && run.error && <div class="card err warn-border">{run.error}</div>}

      {run && run.extracted.length > 0 && (
        <details class="card" open={run.status === 'done'}>
          <summary>Сохранённые данные ({run.extracted.length})</summary>
          <ol>
            {run.extracted.map((e, i) => (
              <li key={i} class="pre">
                {e}
              </li>
            ))}
          </ol>
        </details>
      )}

      <section class="feed">
        {steps.length === 0 && <div class="empty muted card">Лента шагов появится, когда агент начнёт работать.</div>}
        {run && steps.map((s) => <StepCard key={`${run.id}-${s.n}`} step={s} runId={run.id} />)}
      </section>
    </>
  );
}
