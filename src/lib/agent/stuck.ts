import { actionSignature } from './loop';
import type { ExecutedAction } from './types';

/**
 * Детектор застревания: модель топчется на одном месте страницы — действия не удаются
 * («element is disabled», «nothing on the page changed») или повторяют уже сделанное здесь же.
 * Детектор зацикливания такое пропускает: шаги не одинаковые (ввод + клик, потом снова ввод).
 * Лекарство — принудительно прокрутить вниз: следующая кнопка («Дальше») часто ниже экрана.
 */

export interface StuckState {
  /** Отпечаток места (URL + прокрутка), где копится счётчик. */
  page: string;
  /** Шагов подряд без пользы на этом месте. */
  streak: number;
  /** Действия (по описанию элемента), уже сделанные на этом месте. */
  done: string[];
}

const NO_EFFECT = /nothing on the page changed/;

/** Учитывает выполненный шаг. unproductive — шаг ничего не дал. */
export function updateStuck(prev: StuckState | undefined, page: string, actions: readonly ExecutedAction[]): { state: StuckState; unproductive: boolean } {
  const ran = actions.filter((a) => a.result);
  const base: StuckState = prev && prev.page === page ? prev : { page, streak: 0, done: [] };
  if (ran.length === 0 || ran.some((a) => a.result?.navigated)) {
    return { state: { page, streak: 0, done: [] }, unproductive: false };
  }
  const sigs = ran.map((a) => actionSignature([a]));
  const failed = ran.some((a) => !a.result!.ok || NO_EFFECT.test(a.result!.message));
  const repeated = sigs.every((s) => base.done.includes(s));
  const unproductive = failed || repeated;
  return {
    state: { page, streak: unproductive ? base.streak + 1 : 0, done: [...new Set([...base.done, ...sigs])].slice(-30) },
    unproductive,
  };
}

/** Страница уже прокручена до конца (или не прокручивается вовсе). */
export function atBottom(observation: string): boolean {
  if (/^Scroll: none/m.test(observation)) return true;
  const m = /^Scroll: y=(\d+) of (\d+)/m.exec(observation);
  return !!m && Number(m[1]) >= Number(m[2]) - 2;
}

export const autoScrollNote = (steps: number) =>
  `AUTO-SCROLL: your last ${steps} steps made no progress here (actions failed, did nothing, or repeated what was already done), so the agent scrolled down one screen for you. Look at the NEW page state: the way forward (e.g. a "Next"/"Далее" button) is often lower on the page. Do NOT repeat the actions that did not work.`;

export const stuckAtBottomNote = (steps: number) =>
  `STUCK: your last ${steps} steps made no progress and the page is already scrolled to the bottom. Do NOT repeat them. Try a different element (a button that is not disabled, a link to the next part), go back, or use done / ask_user.`;
