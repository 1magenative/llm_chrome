import { useEffect, useRef, useState } from 'preact/hooks';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  parseExtraBody,
  saveSettings,
  type AgentSettings,
  type LlmProfile,
  type ProfileId,
  type Settings,
  type StructuredOutputMode,
} from '@/lib/settings';
import { checkConnection, probeGeneration, type ConnectionReport, type ProbeResult } from '@/lib/llm/connection';
import { normalizeBaseUrl } from '@/lib/llm/url';
import { CheckField, NumberField, TextField } from '@/ui/fields';

const STRUCTURED_LABELS: Record<StructuredOutputMode, string> = {
  auto: 'Авто (json_schema → парсинг текста)',
  json_schema: 'response_format: json_schema',
  json_object: 'response_format: json_object',
  off: 'Выкл (только парсинг текста)',
};

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<ProfileId>('fast');
  const [saved, setSaved] = useState<'idle' | 'dirty' | 'saved'>('idle');

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setTab(s.activeProfile);
    });
  }, []);

  if (!settings) return <main class="muted">Загрузка…</main>;

  const update = (fn: (s: Settings) => Settings) => {
    setSettings(fn(settings));
    setSaved('dirty');
  };
  const setProfile = <K extends keyof LlmProfile>(key: K, value: LlmProfile[K]) =>
    update((s) => ({ ...s, profiles: { ...s.profiles, [tab]: { ...s.profiles[tab], [key]: value } } }));
  const setAgent = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) =>
    update((s) => ({ ...s, agent: { ...s.agent, [key]: value } }));

  const extraBodyError = (Object.keys(settings.profiles) as ProfileId[])
    .map((id) => {
      try {
        parseExtraBody(settings.profiles[id].extraBody);
        return null;
      } catch (err) {
        return `${settings.profiles[id].label}: ${err instanceof Error ? err.message : String(err)}`;
      }
    })
    .find(Boolean);

  const onSave = async () => {
    if (extraBodyError) return;
    const p = settings.profiles;
    const fixed: Settings = {
      ...settings,
      profiles: {
        fast: { ...p.fast, baseUrl: normalizeBaseUrl(p.fast.baseUrl) ?? p.fast.baseUrl },
        slow: { ...p.slow, baseUrl: normalizeBaseUrl(p.slow.baseUrl) ?? p.slow.baseUrl },
      },
    };
    setSettings(await saveSettings(fixed));
    setSaved('saved');
  };

  const profile = settings.profiles[tab];

  return (
    <main>
      <h1>Настройки агента</h1>

      <section class="card">
        <h2>LLM-профили</h2>
        <div class="tabs" role="tablist">
          {(Object.keys(settings.profiles) as ProfileId[]).map((id) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {settings.profiles[id].label}
              {settings.activeProfile === id ? ' • активный' : ''}
            </button>
          ))}
        </div>

        <div class="grid">
          <TextField
            label="Адрес сервера"
            type="url"
            value={profile.baseUrl}
            placeholder="http://192.168.1.10:11434"
            onChange={(v) => setProfile('baseUrl', v)}
          />
          <TextField
            label="Модель"
            value={profile.model}
            list="models"
            placeholder="qwen3:14b"
            onChange={(v) => setProfile('model', v)}
          />
          <TextField label="API-ключ (необязательно)" type="password" value={profile.apiKey} onChange={(v) => setProfile('apiKey', v)} />
          <TextField label="Название профиля" value={profile.label} onChange={(v) => setProfile('label', v)} />
          <NumberField label="Температура" value={profile.temperature} min={0} max={2} step={0.05} onChange={(v) => setProfile('temperature', v)} />
          <NumberField label="Бюджет контекста, токенов" value={profile.contextTokens} min={1024} step={1024} onChange={(v) => setProfile('contextTokens', v)} />
          <NumberField label="Макс. токенов ответа" value={profile.maxOutputTokens} min={64} step={256} onChange={(v) => setProfile('maxOutputTokens', v)} />
          <NumberField label="Таймаут запроса, сек" value={profile.requestTimeoutSec} min={5} onChange={(v) => setProfile('requestTimeoutSec', v)} />
          <label class="field">
            <span>Structured output</span>
            <select
              value={profile.structuredOutput}
              onChange={(e) => setProfile('structuredOutput', e.currentTarget.value as StructuredOutputMode)}
            >
              {(Object.keys(STRUCTURED_LABELS) as StructuredOutputMode[]).map((m) => (
                <option key={m} value={m}>
                  {STRUCTURED_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label class="field">
          <span>Доп. параметры запроса (JSON-объект, вмешивается в тело /v1/chat/completions)</span>
          <textarea
            class="mono"
            rows={2}
            spellcheck={false}
            value={profile.extraBody}
            placeholder='{"top_k": 20, "min_p": 0}'
            onInput={(e) => setProfile('extraBody', e.currentTarget.value)}
          />
        </label>

        <div class="row" style={{ gap: '16px' }}>
          <CheckField
            label="Рассуждения (thinking)"
            hint="Выключено: chat_template_kwargs.enable_thinking=false и think=false. gpt-oss рассуждения не отключает."
            checked={profile.thinking}
            onChange={(v) => setProfile('thinking', v)}
          />
          <CheckField
            label="Использовать этот профиль по умолчанию"
            checked={settings.activeProfile === tab}
            onChange={(v) => v && update((s) => ({ ...s, activeProfile: tab }))}
          />
        </div>

        <ConnectionTester key={tab} profile={profile} />
      </section>

      <section class="card">
        <h2>Агент</h2>
        <div class="grid">
          <NumberField label="Лимит шагов" value={settings.agent.maxSteps} min={1} onChange={(v) => setAgent('maxSteps', v)} />
          <NumberField
            label="Действий за шаг (макс.)"
            value={settings.agent.maxActionsPerStep}
            min={1}
            max={10}
            onChange={(v) => setAgent('maxActionsPerStep', v)}
          />
          <NumberField label="Таймаут шага (без LLM), сек" value={settings.agent.stepTimeoutSec} min={5} onChange={(v) => setAgent('stepTimeoutSec', v)} />
          <NumberField label="Порог зацикливания (повторов)" value={settings.agent.loopThreshold} min={2} onChange={(v) => setAgent('loopThreshold', v)} />
          <NumberField
            label="Лимит наблюдения, символов"
            value={settings.agent.maxObservationChars}
            min={1000}
            step={1000}
            onChange={(v) => setAgent('maxObservationChars', v)}
          />
        </div>
        <div class="row" style={{ gap: '16px' }}>
          <CheckField
            label="Подтверждать каждый шаг"
            hint="Перед кликами, вводом и переходами агент ждёт «Выполнить» в панели"
            checked={settings.agent.approveEachStep}
            onChange={(v) => setAgent('approveEachStep', v)}
          />
          <CheckField
            label="Автономный режим"
            hint="Рискованные действия не выполняются, а откладываются в очередь на утро"
            checked={settings.agent.autonomous}
            onChange={(v) => setAgent('autonomous', v)}
          />
          <CheckField label="Клики через chrome.debugger (CDP)" checked={settings.agent.useDebugger} onChange={(v) => setAgent('useDebugger', v)} />
          <CheckField label="Визуальный курсор" checked={settings.agent.showCursor} onChange={(v) => setAgent('showCursor', v)} />
          <CheckField label="Debug-подсветка элементов" checked={settings.agent.debugOverlay} onChange={(v) => setAgent('debugOverlay', v)} />
        </div>
        <p class="muted" style={{ margin: 0 }}>
          Эти параметры начнут работать на этапах 2–6.
        </p>
      </section>

      <section class="card">
        <h2>Заметки для сайтов</h2>
        <p class="muted" style={{ margin: 0 }}>
          Подсказки модели о том, как устроен сайт. Попадают в промпт, когда агент на подходящей странице. Шаблон — домен (с поддоменами) и, при желании, начало пути: <span class="mono">practicum.yandex.ru/learn</span>.
        </p>
        {settings.siteNotes.map((note, i) => (
          <div key={i} class="site-note">
            <div class="row">
              <input
                type="text"
                class="mono"
                value={note.pattern}
                placeholder="practicum.yandex.ru"
                spellcheck={false}
                onInput={(e) => {
                  const pattern = e.currentTarget.value;
                  update((s) => ({ ...s, siteNotes: s.siteNotes.map((n, j) => (j === i ? { ...n, pattern } : n)) }));
                }}
              />
              <button onClick={() => update((s) => ({ ...s, siteNotes: s.siteNotes.filter((_, j) => j !== i) }))}>Удалить</button>
            </div>
            <textarea
              rows={4}
              value={note.notes}
              placeholder={'- «Узнать ответ» = проверить выбранный ответ. Сначала выбери вариант, потом нажми.\n- 👍/👎 «Оценить» у «Как вам задача?» — отзыв, не нажимать.'}
              onInput={(e) => {
                const notes = e.currentTarget.value;
                update((s) => ({ ...s, siteNotes: s.siteNotes.map((n, j) => (j === i ? { ...n, notes } : n)) }));
              }}
            />
            <label class="field">
              <span>Скрыть от модели — тексты кнопок, по одному на строку (модель их не увидит и не нажмёт)</span>
              <textarea
                rows={2}
                value={note.hide}
                placeholder="Оценить"
                onInput={(e) => {
                  const hide = e.currentTarget.value;
                  update((s) => ({ ...s, siteNotes: s.siteNotes.map((n, j) => (j === i ? { ...n, hide } : n)) }));
                }}
              />
            </label>
          </div>
        ))}
        <div class="row">
          <button onClick={() => update((s) => ({ ...s, siteNotes: [...s.siteNotes, { pattern: '', notes: '', hide: '' }] }))}>Добавить сайт</button>
        </div>
      </section>

      <section class="card">
        <h2>Логирование</h2>
        <CheckField
          label="Отправлять лог шагов POST-запросом"
          checked={settings.logging.remoteEnabled}
          onChange={(v) => update((s) => ({ ...s, logging: { ...s.logging, remoteEnabled: v } }))}
        />
        <TextField
          label="URL для логов"
          type="url"
          value={settings.logging.remoteUrl}
          placeholder="http://192.168.1.10:8080/agent-log"
          onChange={(v) => update((s) => ({ ...s, logging: { ...s.logging, remoteUrl: v } }))}
        />
      </section>

      <div class="save-bar row">
        <button class="primary" onClick={() => void onSave()} disabled={saved !== 'dirty' || !!extraBodyError}>
          Сохранить
        </button>
        <button
          onClick={() => {
            if (confirm('Сбросить все настройки к значениям по умолчанию?')) {
              setSettings(DEFAULT_SETTINGS);
              setSaved('dirty');
            }
          }}
        >
          Сбросить
        </button>
        <span class={extraBodyError ? 'err' : saved === 'dirty' ? 'warn' : 'muted'}>
          {extraBodyError ?? (saved === 'dirty' ? 'Есть несохранённые изменения' : saved === 'saved' ? 'Сохранено' : '')}
        </span>
      </div>
    </main>
  );
}

function ConnectionTester({ profile }: { profile: LlmProfile }) {
  const [report, setReport] = useState<ConnectionReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [streamText, setStreamText] = useState('');
  const [reasoningChars, setReasoningChars] = useState(0);
  const [probing, setProbing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const onCheck = async () => {
    setChecking(true);
    setReport(await checkConnection(profile));
    setChecking(false);
  };

  const onProbe = async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProbe(null);
    setStreamText('');
    setReasoningChars(0);
    setProbing(true);
    const res = await probeGeneration(profile, {
      signal: ctrl.signal,
      onDelta: ({ content, reasoning }) => {
        if (content) setStreamText((t) => t + content);
        if (reasoning) setReasoningChars((n) => n + reasoning.length);
      },
    });
    abortRef.current = null;
    setProbing(false);
    setProbe(res);
  };

  return (
    <div class="card report" style={{ background: 'var(--bg)' }}>
      <div class="row">
        <button onClick={() => void onCheck()} disabled={checking}>
          {checking ? 'Проверяю…' : 'Проверить соединение'}
        </button>
        {probing ? (
          <button onClick={() => abortRef.current?.abort()}>Остановить генерацию</button>
        ) : (
          <button onClick={() => void onProbe()}>Пробная генерация</button>
        )}
      </div>

      {report && (
        <div>
          {report.ok ? (
            <div class="ok">
              Соединение есть: {report.baseUrl}, {report.latencyMs} мс, моделей: {report.models.length}
            </div>
          ) : (
            <div class="err">{report.error}</div>
          )}
          {report.ok && (
            <div class="muted">
              Сервер: {report.server.kind}
              {report.server.version ? ` ${report.server.version}` : ''}
              {report.server.contextTokens ? `, контекст ${report.server.contextTokens}` : ''}
              {report.resolvedModel ? `, модель ${report.resolvedModel}` : ''}
            </div>
          )}
          {report.warnings.length > 0 && (
            <ul class="warn">
              {report.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <datalist id="models">
            {report.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      )}

      {(probing || probe) && (
        <div style={{ marginTop: '8px' }}>
          {probing && <div class="muted">Генерация… рассуждений: {reasoningChars} симв.</div>}
          {probe &&
            (probe.ok ? (
              <div class="ok">
                Первый токен через {probe.ttftMs} мс, всего {probe.totalMs} мс
                {probe.reasoningChars > 0 ? `, рассуждений ${probe.reasoningChars} симв.` : ''}
              </div>
            ) : (
              <div class="err">{probe.error}</div>
            ))}
          {streamText && <pre class="output mono">{streamText}</pre>}
        </div>
      )}
    </div>
  );
}
