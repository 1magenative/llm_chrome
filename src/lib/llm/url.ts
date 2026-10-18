/**
 * Приводит введённый пользователем адрес к виду `http://host:port[/prefix]` без
 * завершающего `/` и без `/v1` — суффиксы API добавляются в клиенте.
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

  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/v1(\/chat\/completions|\/models)?$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** URL OpenAI-совместимого эндпоинта, например `apiUrl(base, '/chat/completions')`. */
export function apiUrl(baseUrl: string, path: `/${string}`): string {
  return `${baseUrl}/v1${path}`;
}
