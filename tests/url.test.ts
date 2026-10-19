import { describe, expect, it } from 'vitest';
import { apiUrl, hasApiPrefix, isLocalHost, normalizeBaseUrl, serverRoot } from '@/lib/llm/url';

describe('normalizeBaseUrl', () => {
  it.each([
    ['http://192.168.1.10:11434', 'http://192.168.1.10:11434'],
    ['http://192.168.1.10:11434/', 'http://192.168.1.10:11434'],
    // версия в адресе сохраняется: у каждого сервиса она своя
    ['http://192.168.1.10:11434/v1', 'http://192.168.1.10:11434/v1'],
    ['https://vyceai.com/v1/', 'https://vyceai.com/v1'],
    ['https://vyceai.com/v1/chat/completions', 'https://vyceai.com/v1'],
    ['http://host:8080/v1/models', 'http://host:8080/v1'],
    ['https://api.example/openai/v2', 'https://api.example/openai/v2'],
    ['192.168.1.10:8080', 'http://192.168.1.10:8080'],
    ['  llm.lan:8080  ', 'http://llm.lan:8080'],
    ['https://proxy.lan/llm', 'https://proxy.lan/llm'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it.each(['', '   ', 'ftp://host', 'http://', 'chrome-extension://abc'])('отклоняет %j', (input) => {
    expect(normalizeBaseUrl(input)).toBeNull();
  });
});

describe('apiUrl', () => {
  it('добавляет префикс только если его нет в адресе', () => {
    expect(apiUrl('http://h:1', '/models')).toBe('http://h:1/v1/models');
    expect(apiUrl('https://vyceai.com/v1', '/chat/completions')).toBe('https://vyceai.com/v1/chat/completions');
    expect(apiUrl('https://api.example/openai/v2', '/models')).toBe('https://api.example/openai/v2/models');
    expect(apiUrl('https://proxy.lan/llm', '/models')).toBe('https://proxy.lan/llm/v1/models');
    // префикс провайдера применяется к адресу без версии
    expect(apiUrl('https://generativelanguage.googleapis.com', '/models', '/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/models',
    );
    // ...и не дублируется, если пользователь вставил полный адрес
    expect(apiUrl('https://generativelanguage.googleapis.com/v1beta/openai', '/models', '/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/models',
    );
  });

  it('hasApiPrefix распознаёт сегмент версии, а не любую букву v', () => {
    expect(hasApiPrefix('https://x/v1')).toBe(true);
    expect(hasApiPrefix('https://x/v1beta/openai')).toBe(true);
    expect(hasApiPrefix('https://x/openai/v1')).toBe(true);
    expect(hasApiPrefix('https://x')).toBe(false);
    expect(hasApiPrefix('https://x/llm')).toBe(false);
    expect(hasApiPrefix('https://v1.example.com/llm')).toBe(false);
  });
});

describe('serverRoot', () => {
  it('снимает префикс версии — Ollama и llama.cpp отвечают от корня', () => {
    expect(serverRoot('http://192.168.1.10:11434/v1')).toBe('http://192.168.1.10:11434');
    expect(serverRoot('http://192.168.1.10:11434')).toBe('http://192.168.1.10:11434');
    expect(serverRoot('https://proxy.lan/llm/v1')).toBe('https://proxy.lan/llm');
    expect(serverRoot('https://generativelanguage.googleapis.com/v1beta/openai')).toBe('https://generativelanguage.googleapis.com');
  });
});

describe('isLocalHost', () => {
  it.each(['http://localhost:11434', 'http://127.0.0.1:8080', 'http://192.168.1.10:11434', 'http://10.0.0.5', 'http://172.16.0.1', 'http://llm.lan:8080', 'http://macbook.local', 'http://my-server:8080'])(
    '%s — своя сеть',
    (url) => expect(isLocalHost(url)).toBe(true),
  );
  it.each(['https://vyceai.com/v1', 'https://generativelanguage.googleapis.com', 'http://8.8.8.8', 'http://172.32.0.1', 'не адрес'])(
    '%s — внешний',
    (url) => expect(isLocalHost(url)).toBe(false),
  );
});
