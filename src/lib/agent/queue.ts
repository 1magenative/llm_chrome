import { formatAction } from './actions';
import type { RunConfig } from './runner';
import type { DeferredItem, ExecutedAction } from './types';

/** Что агент хотел сделать — по описанию элемента, а не по номеру (номера давно устарели). */
export function describeForResume(ex: ExecutedAction): string {
  const a = ex.action;
  const on = ex.target ?? ('index' in a ? `element [${a.index}]` : '');
  switch (a.action) {
    case 'click':
      return `click ${on}`;
    case 'type':
      return `type "${a.text}" into ${on}${a.submit ? ' and press Enter' : ''}`;
    case 'select':
      return `select "${a.value}" in ${on}`;
    default:
      return formatAction(a);
  }
}

/**
 * Задача для утреннего запуска из очереди: исходная задача + контекст ночного запуска.
 * Задача пользователя идёт первой и на его языке — по ней модель выбирает язык ответа.
 */
export function resumeTask(item: DeferredItem): string {
  const lines = [
    item.task.trim(),
    '',
    `Context: this task was started earlier in autonomous night mode. On ${item.url}${item.title ? ` ("${item.title}")` : ''} the agent wanted to do the following, and it needed the user's confirmation:`,
    ...item.actions.map((a) => `- ${describeForResume(a)}`),
  ];
  if (item.reasoning) lines.push(`Reasoning at that moment: ${item.reasoning}`);
  if (item.extracted.length) lines.push('Facts saved during the night run:', ...item.extracted.map((e) => `- ${e}`));
  lines.push(
    'The user is here now. Continue the task from the current page (the form may have been reset — fill it in again if needed). Risky actions will be confirmed by the user.',
  );
  return lines.join('\n');
}

/** Всё, что нужно background, чтобы после перезапуска поднять запуск снова (сам RunState — в журнале). */
export interface RunCheckpoint {
  runId: string;
  /** Конфиг запуска; системный промпт подставляется заново из src/prompts/system.md. */
  cfg: Omit<RunConfig, 'systemTemplate'>;
  profileId: string;
  tab: { tabId: number; windowId: number; url: string };
  savedAt: number;
}

/** Та же страница: без #якоря. */
export function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.split('#')[0] === b.split('#')[0];
}
