import type { RunState, StepDetail, StepRecord } from '../agent/types';

export type FetchFn = typeof fetch;

export interface RemoteLogEvent {
  type: 'step' | 'run';
  runId: string;
  task: string;
  status: RunState['status'];
  step?: StepRecord & Partial<Pick<StepDetail, 'observation' | 'responses'>>;
  result?: string;
  error?: string;
  at: string;
}

/**
 * Отправляет событие лога POST-запросом. Лог — не критичная функция:
 * ошибки сети возвращаются строкой и не останавливают агента.
 */
export async function postLog(url: string, event: RemoteLogEvent, fetchImpl: FetchFn = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
