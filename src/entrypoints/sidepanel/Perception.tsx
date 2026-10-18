import { useState } from 'preact/hooks';
import { browser } from '#imports';
import type { Diagnosis } from '@/lib/dom/diagnose';
import { errorMessage, sendToBackground, type ObserveResult } from '@/lib/messages';
import { activeTab, ensureContentScript, sendToContent } from '@/lib/perception';
import { hiddenNamesFor, type SiteNote } from '@/lib/agent/site-notes';

async function currentWindowId(): Promise<number> {
  const win = await browser.windows.getCurrent();
  if (win.id === undefined) throw new Error('Не удалось определить окно.');
  return win.id;
}

interface Props {
  defaultHighlight: boolean;
  maxChars: number;
  siteNotes: SiteNote[];
}

/** «Что видит модель»: снимок активной вкладки ровно в том виде, в каком он уйдёт в промпт. */
export function Perception({ defaultHighlight, maxChars, siteNotes }: Props) {
  const [highlight, setHighlight] = useState(defaultHighlight);
  const [result, setResult] = useState<ObserveResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [picking, setPicking] = useState(false);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);

  const observe = async (withHighlight = highlight) => {
    setBusy(true);
    setError('');
    const res = await sendToBackground({ type: 'bg:observe', windowId: await currentWindowId(), highlight: withHighlight });
    setBusy(false);
    if (res.ok) setResult(res.value);
    else setError(res.error);
  };

  const toggleHighlight = async (enabled: boolean) => {
    setHighlight(enabled);
    // Включение пересобирает снимок, чтобы номера на странице совпадали с текстом.
    if (enabled) return observe(true);
    const res = await sendToBackground({ type: 'bg:highlight', windowId: await currentWindowId(), enabled: false });
    if (!res.ok) setError(res.error);
  };

  const copy = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Панель говорит с content script напрямую: ожидание клика может длиться долго,
  // а service worker держать живым ради этого незачем.
  const pick = async () => {
    setError('');
    setDiagnosis(null);
    try {
      const tab = await activeTab(await currentWindowId());
      await ensureContentScript(tab.id, tab.url);
      if (picking) {
        await sendToContent(tab.id, { type: 'content:pick-cancel' });
        return;
      }
      setPicking(true);
      const hide = tab.url ? hiddenNamesFor(tab.url, siteNotes) : [];
      setDiagnosis(await sendToContent(tab.id, { type: 'content:pick', maxChars, hide }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPicking(false);
    }
  };

  const s = result?.stats;

  return (
    <details class="card perception">
      <summary>Что видит модель</summary>
      <div class="row">
        <button onClick={() => void observe()} disabled={busy}>
          {busy ? 'Снимаю…' : result ? 'Обновить' : 'Показать'}
        </button>
        <label class="check">
          <input type="checkbox" checked={highlight} onChange={(e) => void toggleHighlight(e.currentTarget.checked)} />
          Подсветка на странице
        </label>
        <button onClick={() => void pick()} title="Кликните элемент на странице — расширение объяснит, видит ли его модель">
          {picking ? 'Отменить выбор' : 'Почему не виден?'}
        </button>
        {result && (
          <button onClick={() => void copy()} title="Скопировать текст наблюдения">
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        )}
      </div>

      {error && <div class="err">{error}</div>}

      {picking && <div class="muted">Кликните элемент на странице. Esc — отмена.</div>}

      {diagnosis && (
        <div class={`card diagnosis ${diagnosis.ok ? 'ok-border' : 'warn-border'}`}>
          <div class="mono">{diagnosis.element}</div>
          <div class={diagnosis.ok ? 'ok' : 'warn'}>{diagnosis.verdict}</div>
          {diagnosis.details.length > 0 && (
            <ul>
              {diagnosis.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {s && (
        <div class="muted stats">
          Элементов: {s.shownElements} из {s.totalElements}
          {s.omittedElements > 0 && <span class="warn"> (не влезло {s.omittedElements})</span>} · символов {s.chars} / {s.maxChars}
          {s.textTruncated && ' · текст обрезан'} · {s.durationMs} мс
          <br />
          Отброшено: перекрыто {s.covered}, невидимо {s.hidden}, вне прокрутки {s.offscreen}
          {s.userHidden > 0 && `, скрыто заметкой ${s.userHidden}`}
          {s.walkTruncated && <span class="warn"> · DOM слишком большой, обход прерван</span>}
        </div>
      )}

      {result && <pre class="output mono observation">{result.text}</pre>}
    </details>
  );
}
