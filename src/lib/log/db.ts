import type { DeferredItem, RunState, RunSummary, StepDetail, StepRecord } from '../agent/types';

const DB_NAME = 'agent-log';
/** v2 — очередь отложенных действий (этап 6). */
const DB_VERSION = 2;
const RUNS = 'runs';
const STEPS = 'steps';
const DETAILS = 'details';
const QUEUE = 'queue';

/** Сколько запусков хранить; старые удаляются при старте нового. */
export const MAX_RUNS = 50;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(RUNS)) db.createObjectStore(RUNS, { keyPath: 'id' }).createIndex('startedAt', 'startedAt');
      if (!db.objectStoreNames.contains(STEPS)) db.createObjectStore(STEPS, { keyPath: ['runId', 'n'] });
      if (!db.objectStoreNames.contains(DETAILS)) db.createObjectStore(DETAILS, { keyPath: ['runId', 'n'] });
      if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      dbPromise = null;
      reject(r.error ?? new Error('IndexedDB open failed'));
    };
  });
  return dbPromise;
}

/** Только для тестов: закрыть соединение, чтобы следующая открылась заново. */
export async function resetLogDb(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}

/** Состояние запуска без шагов (они лежат отдельно). */
type StoredRun = Omit<RunState, 'steps'> & { stepCount: number };

function toStored(run: RunState): StoredRun {
  const { steps, ...rest } = run;
  return { ...rest, stepCount: steps.length };
}

export async function saveRun(run: RunState): Promise<void> {
  const db = await open();
  const tx = db.transaction(RUNS, 'readwrite');
  tx.objectStore(RUNS).put(toStored(run));
  await done(tx);
}

export async function saveStep(runId: string, step: StepRecord, detail?: StepDetail): Promise<void> {
  const db = await open();
  const tx = db.transaction([STEPS, DETAILS], 'readwrite');
  tx.objectStore(STEPS).put({ runId, ...step });
  if (detail) tx.objectStore(DETAILS).put(detail);
  await done(tx);
}

export async function getStepDetail(runId: string, n: number): Promise<StepDetail | undefined> {
  const db = await open();
  return (await req(db.transaction(DETAILS).objectStore(DETAILS).get([runId, n]))) as StepDetail | undefined;
}

export async function listRuns(limit = 20): Promise<RunSummary[]> {
  const db = await open();
  const all = (await req(db.transaction(RUNS).objectStore(RUNS).index('startedAt').getAll())) as StoredRun[];
  return all
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      task: r.task,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      steps: r.stepCount,
      result: r.result,
      error: r.error,
    }));
}

const inRun = (runId: string) => IDBKeyRange.bound([runId, -Infinity], [runId, Infinity]);

/** Запуск целиком (со всеми шагами) — для продолжения после перезапуска. */
export async function loadRun(runId: string): Promise<RunState | null> {
  const db = await open();
  const tx = db.transaction([RUNS, STEPS]);
  const stored = (await req(tx.objectStore(RUNS).get(runId))) as StoredRun | undefined;
  if (!stored) return null;
  const rows = (await req(tx.objectStore(STEPS).getAll(inRun(runId)))) as (StepRecord & { runId: string })[];
  const { stepCount: _count, ...rest } = stored;
  const steps = rows.sort((a, b) => a.n - b.n).map(({ runId: _id, ...s }) => s);
  return { ...rest, steps };
}

// ——— очередь на утро ———

export async function addDeferred(item: DeferredItem): Promise<void> {
  const db = await open();
  const tx = db.transaction(QUEUE, 'readwrite');
  tx.objectStore(QUEUE).put(item);
  await done(tx);
}

/** Очередь: сначала ждущие подтверждения (новые сверху), затем недавно разобранные. */
export async function listDeferred(limit = 50): Promise<DeferredItem[]> {
  const db = await open();
  const all = (await req(db.transaction(QUEUE).objectStore(QUEUE).getAll())) as DeferredItem[];
  const rank = (i: DeferredItem) => (i.status === 'pending' ? 0 : 1);
  return all.sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt).slice(0, limit);
}

export async function getDeferred(id: string): Promise<DeferredItem | null> {
  const db = await open();
  return ((await req(db.transaction(QUEUE).objectStore(QUEUE).get(id))) as DeferredItem | undefined) ?? null;
}

export async function setDeferredStatus(id: string, status: DeferredItem['status']): Promise<void> {
  const db = await open();
  const tx = db.transaction(QUEUE, 'readwrite');
  const store = tx.objectStore(QUEUE);
  const item = (await req(store.get(id))) as DeferredItem | undefined;
  if (item) store.put({ ...item, status });
  await done(tx);
}

/** Убирает разобранные элементы очереди старше maxAgeMs. */
export async function pruneDeferred(now: number, maxAgeMs = 14 * 24 * 3600 * 1000): Promise<number> {
  const db = await open();
  const tx = db.transaction(QUEUE, 'readwrite');
  const store = tx.objectStore(QUEUE);
  const all = (await req(store.getAll())) as DeferredItem[];
  const old = all.filter((i) => i.status !== 'pending' && now - i.createdAt > maxAgeMs);
  for (const i of old) store.delete(i.id);
  await done(tx);
  return old.length;
}

/** Полный лог запуска для экспорта в JSON. */
export async function exportRun(runId: string): Promise<{ run: StoredRun; steps: (StepRecord & Partial<StepDetail>)[] } | null> {
  const db = await open();
  const tx = db.transaction([RUNS, STEPS, DETAILS]);
  const run = (await req(tx.objectStore(RUNS).get(runId))) as StoredRun | undefined;
  if (!run) return null;
  const steps = (await req(tx.objectStore(STEPS).getAll(inRun(runId)))) as (StepRecord & { runId: string })[];
  const details = (await req(tx.objectStore(DETAILS).getAll(inRun(runId)))) as StepDetail[];
  const byN = new Map(details.map((d) => [d.n, d]));
  return {
    run,
    steps: steps.map(({ runId: _id, ...s }) => {
      const d = byN.get(s.n);
      return d ? { ...s, observation: d.observation, history: d.history, responses: d.responses } : s;
    }),
  };
}

/** Удаляет самые старые запуски сверх лимита. */
export async function pruneRuns(keep = MAX_RUNS): Promise<number> {
  const db = await open();
  const all = (await req(db.transaction(RUNS).objectStore(RUNS).getAll())) as StoredRun[];
  const old = all.sort((a, b) => b.startedAt - a.startedAt).slice(keep);
  if (old.length === 0) return 0;
  const tx = db.transaction([RUNS, STEPS, DETAILS], 'readwrite');
  for (const r of old) {
    tx.objectStore(RUNS).delete(r.id);
    tx.objectStore(STEPS).delete(inRun(r.id));
    tx.objectStore(DETAILS).delete(inRun(r.id));
  }
  await done(tx);
  return old.length;
}
