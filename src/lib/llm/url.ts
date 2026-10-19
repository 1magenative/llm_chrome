/**
 * Приводит введённый адрес к каноническому виду: без завершающего `/` и без
 * `/chat/completions` или `/models` на конце. Префикс версии (`/v1`, `/v1beta/openai`,
 * `/api/v1`…) сохраняется как есть — он у каждого сервиса свой.
 * Возвращает null, если адрес не похож на http(s)-URL.
 */
export function normalizeBaseUrl(input: string): string | null {
  let s = input.trim();
  if (s === '') return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '') return null;

  const path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** Есть ли в адресе сегмент версии API (`v1`, `v1beta`, `v2`…) — значит, путь уже полный. */
export function hasApiPrefix(baseUrl: string): boolean {
  const path = baseUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  return path.split('/').some((segment) => /^v\d/i.test(segment));
}

/**
 * URL эндпоинта. Если пользователь уже указал версию в адресе (`https://vyceai.com/v1`),
 * путь берётся как есть; иначе добавляется префикс провайдера.
 */
export function apiUrl(baseUrl: string, path: `/${string}`, apiPrefix = '/v1'): string {
  return `${baseUrl}${hasApiPrefix(baseUrl) ? '' : apiPrefix}${path}`;
}

/**
 * Корень сервера без префикса версии: `http://h:11434/v1` → `http://h:11434`.
 * Нужен для «не-OpenAI» путей своего сервера (`/api/version` у Ollama, `/props` у llama.cpp).
 */
export function serverRoot(baseUrl: string): string {
  const m = /^(https?:\/\/[^/]+)(.*)$/i.exec(baseUrl);
  if (!m) return baseUrl;
  const segments = m[2]!.split('/');
  const i = segments.findIndex((seg) => /^v\d/i.test(seg));
  return m[1]! + (i === -1 ? m[2]! : segments.slice(0, i).join('/').replace(/\/$/, ''));
}

/** Локальные и адреса домашней сети: туда данные страниц не уходят наружу. */
export function isLocalHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.lan')) return true;
  if (!host.includes('.') && !host.includes(':')) return true; // имя машины в локальной сети
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}
