import { storage } from '#imports';
import type { RunCheckpoint } from './agent/queue';

/**
 * Указатель на незавершённый запуск: сам RunState (с шагами) лежит в журнале IndexedDB,
 * здесь — конфиг и вкладка. Пишется при старте и перед каждым действием, стирается по завершении.
 */
const item = storage.defineItem<RunCheckpoint | null>('local:activeRun', { fallback: null });

export const loadCheckpoint = (): Promise<RunCheckpoint | null> => item.getValue();
export const saveCheckpoint = (cp: RunCheckpoint): Promise<void> => item.setValue(cp);
export const clearCheckpoint = (): Promise<void> => item.removeValue();
