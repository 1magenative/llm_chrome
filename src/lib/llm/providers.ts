/**
 * Откуда брать модель. Все варианты говорят на OpenAI-совместимом протоколе
 * (`/chat/completions`, `/models`), различаются префиксом пути и мелочами тела запроса.
 */
export type ProviderId = 'openai' | 'google';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Префикс пути перед /chat/completions и /models. */
  apiPrefix: string;
  /** Что подставить в адрес и модель при выборе провайдера. */
  baseUrl: string;
  model: string;
  /** Провайдер облачный всегда, каким бы ни был адрес. Для остальных решает сам адрес (isLocalHost). */
  cloud: boolean;
  /** Где взять ключ. */
  keyUrl?: string;
  keyRequired: boolean;
  hint?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openai: {
    id: 'openai',
    label: 'OpenAI-совместимый API (свой сервер или облако по ключу)',
    apiPrefix: '/v1',
    baseUrl: 'http://192.168.1.10:11434',
    model: 'qwen3:14b',
    cloud: false,
    keyRequired: false,
    hint: 'Подходит любой сервис с эндпоинтом /chat/completions: llama.cpp и Ollama в сети, OpenRouter, свой прокси. Вставьте адрес вместе с версией, например https://vyceai.com/v1, и ключ.',
  },
  google: {
    id: 'google',
    label: 'Google Gemini (облако, по API-ключу)',
    // https://ai.google.dev/gemini-api/docs/openai
    apiPrefix: '/v1beta/openai',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-3.8-flash',
    cloud: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    keyRequired: true,
    hint: 'Ключ из Google AI Studio. Список моделей появится после «Проверить соединение». Рассуждения у Pro- и 3.x-моделей отключить нельзя — оставьте переключатель включённым.',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function providerInfo(id: string | undefined): ProviderInfo {
  return PROVIDERS[id as ProviderId] ?? PROVIDERS.openai;
}
