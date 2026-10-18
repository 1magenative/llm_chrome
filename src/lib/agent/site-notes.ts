/** Заметка пользователя о сайте: попадает в промпт, когда агент на подходящей странице. */
export interface SiteNote {
  /** «practicum.yandex.ru» или «practicum.yandex.ru/learn» — домен (с поддоменами) и необязательный префикс пути. */
  pattern: string;
  notes: string;
  /** Тексты элементов, которые модель не должна видеть и нажимать — по одному на строку. */
  hide: string;
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

/** Тексты «скрыть от модели» для страницы (нижний регистр, без пустых). */
export function hiddenNamesFor(url: string, notes: readonly SiteNote[]): string[] {
  return notes
    .filter((n) => noteMatches(url, n.pattern))
    .flatMap((n) => n.hide.split('\n'))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Текст заметок для страницы; пустая строка — подходящих нет. */
export function siteNotesFor(url: string, notes: readonly SiteNote[]): string {
  return notes
    .filter((n) => n.notes.trim() && noteMatches(url, n.pattern))
    .map((n) => n.notes.trim())
    .join('\n');
}
