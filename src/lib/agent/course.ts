import type { RunStatus } from './types';
import type { SkipState } from './skipper';

/**
 * Прохождение курса двумя режимами по очереди: «Пролистать курс» листает сам, пока может;
 * застряв (нет кнопок, перебрал все, ходит по кругу), зовёт нейросеть разобраться с заминкой —
 * решить задание, закрыть окно, найти кнопку. Как только нейросеть сдвинула курс с места
 * (перешли на другую страницу или она сообщила, что путь свободен), снова листает сам.
 */

export interface SolveResult {
  status: RunStatus;
  result?: string;
  error?: string;
  /** Пока работала нейросеть, страница сменилась — её остановили, курс идёт дальше. */
  movedOn: boolean;
}

export interface CourseDeps {
  /** Один проход пролистывания до остановки. */
  skip(): Promise<SkipState>;
  /** Нейросеть разбирается с заминкой; url — где застряли (сменился — значит, помогло). */
  solve(task: string, url: string): Promise<SolveResult>;
  /** Остановить то, что сейчас работает (пролистывание или нейросеть). */
  cancel(): void;
  onState(state: CourseState): void;
  /** Позвать человека: звук и уведомление. */
  alert(message: string): void;
}

export interface CourseConfig {
  /** Звать ли нейросеть при заминке. Выключено — просто остановиться, как раньше. */
  withAgent: boolean;
  /** Сколько раз подряд звать нейросеть на одну страницу, если после неё курс так и не сдвинулся. */
  maxAgentPerPage: number;
}

export interface CourseState {
  status: 'running' | 'done' | 'stuck' | 'stopped' | 'failed';
  mode: 'skip' | 'agent';
  /** Последний проход пролистывания. */
  skip: SkipState | null;
  /** Всего кликов и страниц за все проходы. */
  clicks: number;
  pages: number;
  /** Сколько раз звали нейросеть. */
  handoffs: number;
  /** Что сейчас делает нейросеть / почему её позвали. */
  note?: string;
  message?: string;
}

/** Ответ нейросети «не могу» — первым словом result (так просим в задаче). */
const GAVE_UP = /^\s*(НЕ_МОГУ|НЕ МОГУ|CANNOT|STUCK)(?=$|[\s:.,!—-])/i;

const REASONS: Record<NonNullable<SkipState['reason']>, string> = {
  'no-buttons': 'на странице не осталось кнопок, которые я могу нажать',
  exhausted: 'нажал все кнопки снизу вверх, но курс не продвинулся',
  loop: 'кнопки меняют страницу, но я хожу по кругу и дальше не продвигаюсь',
};

/** Задача для нейросети: разобраться с заминкой и сразу вернуть управление. */
export function solveTask(s: SkipState): string {
  const why = s.reason ? REASONS[s.reason] : (s.message ?? 'курс не продвигается');
  return [
    `Я автоматически пролистываю онлайн-курс, но застрял на этой странице: ${why}.`,
    s.last ? `Последней нажатой была кнопка: ${s.last}.` : '',
    'Твоя задача — только убрать заминку, чтобы курс можно было листать дальше. Найди, что мешает: нерешённое задание или тест,',
    'неактивная кнопка «Далее»/«Дальше», всплывающее окно, которое надо закрыть, поле, которое надо заполнить, кнопка выше по странице.',
    'Теорию не читай и не пересказывай. Если нужно решить задание — реши его и нажми проверку.',
    'Как только путь дальше свободен (задание принято, кнопка «Далее» стала активной, открылся следующий блок или урок), СРАЗУ вызови done',
    'с коротким описанием, что сделал, — дальше продолжит автоматика. Если без человека не обойтись, вызови done и начни result со слова НЕ_МОГУ.',
  ]
    .filter(Boolean)
    .join(' ');
}

export class Course {
  readonly state: CourseState = { status: 'running', mode: 'skip', skip: null, clicks: 0, pages: 0, handoffs: 0 };
  private stopped = false;
  private agentAt = new Map<string, number>();

  constructor(
    private readonly deps: CourseDeps,
    private readonly cfg: CourseConfig,
  ) {}

  stop(): void {
    this.stopped = true;
    this.deps.cancel();
  }

  private emit(): void {
    this.deps.onState({ ...this.state, skip: this.state.skip ? { ...this.state.skip } : null });
  }

  /** Состояние текущего прохода пролистывания — для панели, пока он идёт. */
  skipProgress(s: SkipState): void {
    this.state.skip = s;
    this.emit();
  }

  private finish(status: CourseState['status'], message: string): CourseState {
    Object.assign(this.state, { status, message, note: undefined });
    this.emit();
    return this.state;
  }

  async run(): Promise<CourseState> {
    this.emit();
    try {
      while (!this.stopped) {
        this.state.mode = 'skip';
        this.state.note = undefined;
        this.emit();
        const s = await this.deps.skip();
        this.state.skip = s;
        this.state.clicks += s.clicks;
        this.state.pages += s.pages;
        if (this.stopped || s.status === 'stopped') break;
        if (s.status !== 'stuck') return this.finish(s.status, s.message ?? '');
        if (!this.cfg.withAgent) {
          this.deps.alert(s.message ?? 'Пролистывание застряло.');
          return this.finish('stuck', s.message ?? '');
        }

        const url = s.url ?? '';
        // Пролистывание после нейросети сдвинуло курс (новые блоки, задания) — счётчик заново.
        // (В петле «изменения» бесполезны — там считаем только переход на другую страницу.)
        if (s.pages > 1 || (s.reason !== 'loop' && (s.progress ?? 0) > 0)) this.agentAt.delete(url);
        const tries = (this.agentAt.get(url) ?? 0) + 1;
        this.agentAt.set(url, tries);
        if (tries > this.cfg.maxAgentPerPage) {
          const msg = `Нейросеть уже ${tries - 1} раз(а) помогала на этой странице, а курс снова застрял — нужен человек. ${s.message ?? ''}`.trim();
          this.deps.alert(msg);
          return this.finish('stuck', msg);
        }

        this.state.mode = 'agent';
        this.state.handoffs++;
        this.state.note = `Застрял: ${s.message ?? ''} Разбирается нейросеть…`;
        this.emit();
        const r = await this.deps.solve(solveTask(s), url);
        if (this.stopped) break;
        if (r.movedOn) continue; // страница сменилась — курс поехал, листаем сами
        if (r.status === 'stopped') return this.finish('stopped', 'Нейросеть остановлена вручную — пролистывание тоже.');
        if (r.status === 'done' && !GAVE_UP.test(r.result ?? '')) {
          // Нейросеть сказала, что путь свободен, — пробуем листать с того же места.
          continue;
        }
        const why = r.status === 'done' ? (r.result ?? '').replace(GAVE_UP, '').trim() : (r.error ?? `нейросеть остановилась (${r.status})`);
        const msg = `Нейросеть не смогла продвинуть курс: ${why || 'без объяснений'}`;
        this.deps.alert(msg);
        return this.finish('stuck', msg);
      }
      return this.finish('stopped', 'Остановлено.');
    } catch (err) {
      return this.finish('failed', err instanceof Error ? err.message : String(err));
    }
  }
}
