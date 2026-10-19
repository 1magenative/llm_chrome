import type { SiteRiskMode } from './risk';

/** Заметка пользователя о сайте: попадает в промпт, когда агент на подходящей странице. */
export interface SiteNote {
  /** «practicum.yandex.ru» или «practicum.yandex.ru/learn» — домен (с поддоменами) и необязательный префикс пути. */
  pattern: string;
  notes: string;
  /** Тексты элементов, которые модель не должна видеть и нажимать — по одному на строку. */
  hide: string;
  /** Рискованные действия на этом сайте: спрашивать / выполнять без подтверждения / запрещать. */
  risk: SiteRiskMode;
  /** Тексты кнопок, для которых подтверждение не нужно — по одному на строку. */
  safe: string;
  /** Кнопка перехода дальше («Далее» с шуточным текстом или одними эмодзи): текст или `css:` — модель увидит пометку NEXT. */
  next: string;
}

interface ParsedPattern {
  host: string;
  path: string;
}

function parsePattern(pattern: string): ParsedPattern | null {
  const s = pattern
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
  if (!s) return null;
  const slash = s.indexOf('/');
  return slash === -1 ? { host: s, path: '' } : { host: s.slice(0, slash), path: s.slice(slash) };
}

export function noteMatches(url: string, pattern: string): boolean {
  const p = parsePattern(pattern);
  if (!p) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const hostOk = host === p.host || host.endsWith(`.${p.host}`);
  return hostOk && (!p.path || u.pathname.toLowerCase().startsWith(p.path));
}

/** Правила «скрыть от модели» для страницы (без пустых; текст или `css: селектор` — см. dom/hide-rules.ts). */
export function hiddenNamesFor(url: string, notes: readonly SiteNote[]): string[] {
  return rulesFor(url, notes, 'hide');
}

/** Правила кнопки «Далее» для страницы (как «скрыть», но элемент помечается, а не прячется). */
export function nextRulesFor(url: string, notes: readonly SiteNote[]): string[] {
  return rulesFor(url, notes, 'next');
}

function rulesFor(url: string, notes: readonly SiteNote[], field: 'hide' | 'next'): string[] {
  return notes
    .filter((n) => noteMatches(url, n.pattern))
    .flatMap((n) => n[field].split('\n'))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Шаблон заметки для страницы: домен без www. */
export function sitePatternFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Добавляет правило «Скрыть от модели» в заметку с этим шаблоном (создаёт её, если нет).
 * Повтор не дублируется.
 */
export function addHideRule(notes: readonly SiteNote[], pattern: string, rule: string, field: 'hide' | 'next' = 'hide'): SiteNote[] {
  const r = rule.trim();
  const p = pattern.trim();
  if (!r || !p) return [...notes];
  const i = notes.findIndex((n) => n.pattern.trim().toLowerCase() === p.toLowerCase());
  if (i === -1) return [...notes, { pattern: p, notes: '', hide: '', risk: 'ask', safe: '', next: '', [field]: r }];
  const note = notes[i]!;
  const lines = note[field].split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.includes(r)) return [...notes];
  const copy = [...notes];
  copy[i] = { ...note, [field]: [...lines, r].join('\n') };
  return copy;
}

/** Текст заметок для страницы; пустая строка — подходящих нет. */
export function siteNotesFor(url: string, notes: readonly SiteNote[]): string {
  return notes
    .filter((n) => n.notes.trim() && noteMatches(url, n.pattern))
    .map((n) => n.notes.trim())
    .join('\n');
}
