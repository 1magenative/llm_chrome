import type { ActionResult, ElementBrief, ObservationHandle } from './types';
import { matchWord } from './risk';

/**
 * Пролистывание курса без модели: вниз страницы → нажать нижнюю кнопку; если ничего не изменилось —
 * ещё пару раз; затем жать кнопки снизу вверх, после каждой возвращаться вниз и снова пробовать нижнюю.
 * Модель не вызывается вовсе, поэтому шаг — доли секунды.
 */

export interface SkipObservation {
  url: string;
  elements: ElementBrief[];
  handle: ObservationHandle;
}

export interface SkipDeps {
  observe(): Promise<SkipObservation>;
  click(index: number, handle: ObservationHandle): Promise<ActionResult>;
  /** Прокрутить в самый низ (главную прокручиваемую область). */
  scrollToBottom(handle: ObservationHandle): Promise<void>;
  /** Рискованно ли нажимать (оплата, удаление, отправка) — решает классификатор риска. */
  isRisky(line: string, url: string): boolean;
  sleep(ms: number): Promise<void>;
  onState(state: SkipState): void;
}

export interface SkipConfig {
  /** Сколько раз жать нижнюю кнопку, пока ничего не меняется. */
  bottomRepeats: number;
  /** Пауза после клика, чтобы страница успела отреагировать, мс. */
  settleMs: number;
  /** Предохранитель: всего кликов за запуск. */
  maxClicks: number;
  /** Сколько раз можно жать одну и ту же кнопку на одной странице. */
  maxSameClicks: number;
}

export const DEFAULT_SKIP_CONFIG: SkipConfig = { bottomRepeats: 3, settleMs: 400, maxClicks: 1000, maxSameClicks: 8 };

export interface SkipState {
  status: 'running' | 'done' | 'stuck' | 'stopped' | 'failed';
  clicks: number;
  pages: number;
  last: string;
  message?: string;
}

/** Этого не жмём никогда, даже если внизу: сбросит код, выйдет из аккаунта и т.п. */
export const SKIP_DENY = ['сбросить', 'reset', 'выйти', 'выход', 'logout', 'log out', 'sign out', 'оценить', 'пожаловаться', 'report'];

/** Ключ элемента между наблюдениями (номера меняются): описание + порядковый номер среди одинаковых. */
function keyed(elements: readonly ElementBrief[]): Map<string, ElementBrief> {
  const seen = new Map<string, number>();
  const out = new Map<string, ElementBrief>();
  for (const e of [...elements].sort((a, b) => a.y - b.y || a.index - b.index)) {
    const n = (seen.get(e.line) ?? 0) + 1;
    seen.set(e.line, n);
    out.set(`${e.line}#${n}`, e);
  }
  return out;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** Ссылка на другой сайт: сборщик пишет href чужого сайта без ведущего «/». */
const leavesSite = (line: string) => {
  const m = /href="([^"]*)"/.exec(line);
  return !!m && !/^[/#?]/.test(m[1]!);
};

/**
 * Приоритет кнопки: «Далее» из заметки → кнопки содержимого с текстом → безымянные иконки
 * содержимого → панели, приклеенные к экрану, и всё внутри iframe. Приклеенные кнопки
 * (боковое меню, чат) всегда «ниже» урока по координатам, но к уроку не относятся.
 */
const NEXT_WORDS = ['далее', 'дальше', 'следующ', 'продолж', 'next', 'continue'];

export function rank(e: ElementBrief): number {
  if (e.next) return 0;
  // Кнопка «Дальше» в приклеенной нижней панели урока — всё же переход дальше.
  if (e.pinned && !e.inFrame && matchWord(e.line, NEXT_WORDS)) return 1;
  if (e.pinned || e.inFrame) return 3;
  return /^\S+ "[^"]+"/.test(e.line) ? 1 : 2;
}

/** Отпечаток содержимого: изменилось ли что-то после клика. */
export function signature(obs: SkipObservation): string {
  return `${obs.url}\n${[...obs.elements].sort((a, b) => a.y - b.y).map((e) => e.line).join('\n')}`;
}

export class Skipper {
  readonly state: SkipState = { status: 'running', clicks: 0, pages: 0, last: '' };
  private stopped = false;
  /** Сколько раз жали кнопку на текущей странице — чтобы не крутить одну вечно. */
  private pressed = new Map<string, number>();
  private pageUrl = '';
  private startHost = '';

  constructor(
    private readonly deps: SkipDeps,
    private readonly cfg: SkipConfig = DEFAULT_SKIP_CONFIG,
  ) {}

  stop(): void {
    this.stopped = true;
  }

  private emit(): void {
    this.deps.onState({ ...this.state });
  }

  private finish(status: SkipState['status'], message: string): void {
    Object.assign(this.state, { status, message });
    this.emit();
  }

  /** Кнопки, которые можно жать, — по приоритету (см. rank), внутри приоритета снизу вверх. */
  private candidates(obs: SkipObservation): string[] {
    const ok = [...keyed(obs.elements)].filter(([key, e]) => {
      if (!e.clickable || e.disabled || leavesSite(e.line)) return false;
      if (matchWord(e.line, SKIP_DENY) || this.deps.isRisky(e.line, obs.url)) return false;
      return (this.pressed.get(key) ?? 0) < this.cfg.maxSameClicks;
    });
    ok.sort(([, a], [, b]) => rank(a) - rank(b) || b.y - a.y);
    return ok.map(([key]) => key);
  }

  private async observeAtBottom(): Promise<SkipObservation> {
    const first = await this.deps.observe();
    await this.deps.scrollToBottom(first.handle);
    const obs = await this.deps.observe();
    if (obs.url !== this.pageUrl) {
      this.pageUrl = obs.url;
      this.pressed.clear();
      this.state.pages++;
    }
    return obs;
  }

  /** Нажать элемент по ключу в свежем наблюдении. true — страница изменилась. */
  private async press(key: string, obs: SkipObservation): Promise<boolean | 'gone'> {
    const el = keyed(obs.elements).get(key);
    if (!el) return 'gone';
    const before = signature(obs);
    this.pressed.set(key, (this.pressed.get(key) ?? 0) + 1);
    this.state.clicks++;
    this.state.last = el.line;
    this.emit();
    const res = await this.deps.click(el.index, obs.handle);
    await this.deps.sleep(this.cfg.settleMs);
    if (res.navigated) return true;
    const after = await this.deps.observe();
    return signature(after) !== before;
  }

  async run(): Promise<SkipState> {
    this.emit();
    try {
      while (!this.stopped) {
        if (this.state.clicks >= this.cfg.maxClicks) return (this.finish('done', `Достигнут предел кликов (${this.cfg.maxClicks}).`), this.state);
        let obs = await this.observeAtBottom();
        if (!this.startHost) this.startHost = hostOf(obs.url);
        if (hostOf(obs.url) !== this.startHost) return (this.finish('done', `Ушли на другой сайт: ${obs.url}`), this.state);

        const order = this.candidates(obs);
        if (order.length === 0) return (this.finish('stuck', 'На странице не осталось кнопок, которые можно нажать.'), this.state);

        // 1. Нижняя кнопка (или «Далее»), несколько раз.
        const bottom = order[0]!;
        let progressed = false;
        for (let i = 0; i < this.cfg.bottomRepeats && !this.stopped && !progressed; i++) {
          const r = await this.press(bottom, obs);
          if (r === 'gone') break;
          progressed = r;
          if (!progressed) obs = await this.deps.observe();
        }
        if (progressed || this.stopped) continue;

        // 2. Кнопки снизу вверх; после каждой — снова вниз и снова нижняя.
        for (const key of order.slice(1)) {
          if (this.stopped) break;
          obs = await this.deps.observe();
          const r = await this.press(key, obs);
          if (r === 'gone') continue;
          if (r === true && obs.url !== (await this.deps.observe()).url) {
            progressed = true;
            break;
          }
          obs = await this.observeAtBottom();
          const again = this.candidates(obs)[0];
          if (again && (await this.press(again, obs)) === true) {
            progressed = true;
            break;
          }
        }
        if (!progressed && !this.stopped) {
          return (this.finish('stuck', 'Перебрал все кнопки снизу вверх — дальше не продвинуться. Посмотрите страницу.'), this.state);
        }
      }
      this.finish('stopped', 'Остановлено.');
    } catch (err) {
      this.finish('failed', err instanceof Error ? err.message : String(err));
    }
    return this.state;
  }
}
