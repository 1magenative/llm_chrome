import { describe, expect, it } from 'vitest';
import { apiUrl, normalizeBaseUrl } from '@/lib/llm/url';

describe('normalizeBaseUrl', () => {
  it.each([
    ['http://192.168.1.10:11434', 'http://192.168.1.10:11434'],
    ['http://192.168.1.10:11434/', 'http://192.168.1.10:11434'],
    ['http://192.168.1.10:11434/v1', 'http://192.168.1.10:11434'],
    ['http://192.168.1.10:11434/v1/', 'http://192.168.1.10:11434'],
    ['http://host:8080/v1/chat/completions', 'http://host:8080'],
    ['http://host:8080/v1/models', 'http://host:8080'],
    ['192.168.1.10:8080', 'http://192.168.1.10:8080'],
    ['  llm.lan:8080  ', 'http://llm.lan:8080'],
    ['https://proxy.lan/llm/v1', 'https://proxy.lan/llm'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it.each(['', '   ', 'ftp://host', 'http://', 'chrome-extension://abc'])('отклоняет %j', (input) => {
    expect(normalizeBaseUrl(input)).toBeNull();
  });
});

describe('apiUrl', () => {
  it('добавляет /v1', () => {
    expect(apiUrl('http://h:1', '/models')).toBe('http://h:1/v1/models');
  });
});
