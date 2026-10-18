import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DEFAULT_SETTINGS, activeProfile, loadSettings, parseExtraBody, sanitizeSettings, saveSettings } from '@/lib/settings';

describe('sanitizeSettings', () => {
  it('мусор → дефолты', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });

  it('частичные настройки дополняются дефолтами', () => {
    const s = sanitizeSettings({ profiles: { slow: { model: 'qwen3:32b-q4' } }, agent: { autonomous: true } });
    expect(s.profiles.slow.model).toBe('qwen3:32b-q4');
    expect(s.profiles.slow.baseUrl).toBe(DEFAULT_SETTINGS.profiles.slow.baseUrl);
    expect(s.profiles.fast).toEqual(DEFAULT_SETTINGS.profiles.fast);
    expect(s.agent.autonomous).toBe(true);
    expect(s.agent.maxSteps).toBe(DEFAULT_SETTINGS.agent.maxSteps);
  });

  it('зажимает числа и округляет целые', () => {
    const s = sanitizeSettings({
      profiles: { fast: { temperature: 9, contextTokens: 10, requestTimeoutSec: '30.6' } },
      agent: { maxSteps: -5, loopThreshold: 2.7 },
    });
    expect(s.profiles.fast.temperature).toBe(2);
    expect(s.profiles.fast.contextTokens).toBe(1024);
    expect(s.profiles.fast.requestTimeoutSec).toBe(31);
    expect(s.agent.maxSteps).toBe(1);
    expect(s.agent.loopThreshold).toBe(3);
  });

  it('неверные типы и enum-значения заменяются дефолтами', () => {
    const s = sanitizeSettings({
      activeProfile: 'turbo',
      profiles: { fast: { structuredOutput: 'grammar', temperature: 'abc', apiKey: 42 } },
      agent: { autonomous: 'yes' },
    });
    expect(s.activeProfile).toBe('fast');
    expect(s.profiles.fast.structuredOutput).toBe('auto');
    expect(s.profiles.fast.temperature).toBe(DEFAULT_SETTINGS.profiles.fast.temperature);
    expect(s.profiles.fast.apiKey).toBe('');
    expect(s.agent.autonomous).toBe(false);
  });

  it('обрезает пробелы в адресе, ключе и модели', () => {
    const s = sanitizeSettings({ profiles: { fast: { baseUrl: ' http://h:1 ', apiKey: ' k ', model: ' m ' } } });
    expect(s.profiles.fast).toMatchObject({ baseUrl: 'http://h:1', apiKey: 'k', model: 'm' });
  });

  it('рассуждения, доп. параметры и действий за шаг', () => {
    const s = sanitizeSettings({ profiles: { fast: { thinking: true, extraBody: ' {"top_k":20} ' } }, agent: { maxActionsPerStep: 50 } });
    expect(s.profiles.fast.thinking).toBe(true);
    expect(s.profiles.fast.extraBody).toBe('{"top_k":20}');
    expect(s.profiles.slow.thinking).toBe(true);
    expect(DEFAULT_SETTINGS.profiles.fast.thinking).toBe(false);
    expect(s.agent.maxActionsPerStep).toBe(10);
  });

  it('parseExtraBody', () => {
    expect(parseExtraBody('')).toEqual({});
    expect(parseExtraBody('{"min_p":0.05}')).toEqual({ min_p: 0.05 });
    expect(() => parseExtraBody('{oops}')).toThrow(/не JSON/);
    expect(() => parseExtraBody('"str"')).toThrow(/JSON-объектом/);
  });

  it('activeProfile возвращает выбранный профиль', () => {
    const s = sanitizeSettings({ activeProfile: 'slow' });
    expect(activeProfile(s)).toBe(s.profiles.slow);
  });
});

describe('хранение', () => {
  beforeEach(() => fakeBrowser.reset());

  it('без сохранённых данных отдаёт дефолты', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('сохраняет и читает обратно', async () => {
    const s = sanitizeSettings({ activeProfile: 'slow', profiles: { slow: { model: 'gpt-oss:20b' } } });
    await saveSettings(s);
    expect(await loadSettings()).toEqual(s);
  });

  it('хранит в storage.local, не в sync', async () => {
    await saveSettings(DEFAULT_SETTINGS);
    expect(await fakeBrowser.storage.local.get('settings')).toHaveProperty('settings');
    expect(await fakeBrowser.storage.sync.get('settings')).toEqual({});
  });
});
