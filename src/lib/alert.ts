import { browser } from '#imports';
import type { OffscreenRequest } from './alert-messages';

/**
 * Сигнал человеку: звук (через offscreen-документ — service worker сам звук играть не может)
 * и системное уведомление. Используется, когда в автономном режиме агент упёрся в рискованное действие.
 */

const OFFSCREEN_URL = '/offscreen.html';
export const ALERT_NOTIFICATION_ID = 'agent-risky-action';

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const existing = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  creating ??= browser.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Звуковой сигнал: агенту нужно подтверждение рискованного действия',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

export async function playBeep(): Promise<void> {
  await ensureOffscreen();
  const res = (await browser.runtime.sendMessage({ type: 'offscreen:beep' } satisfies OffscreenRequest)) as { ok: boolean; error?: string } | undefined;
  if (res && !res.ok) throw new Error(res.error ?? 'не удалось воспроизвести звук');
}

export async function showNotification(title: string, message: string): Promise<void> {
  await browser.notifications.create(ALERT_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title,
    message: message.slice(0, 300),
    priority: 2,
    requireInteraction: true,
  });
}

/** Звук + уведомление; ошибки не роняют агента — сигнал не критичен. */
export async function alertHuman(title: string, message: string, sound: boolean): Promise<void> {
  await Promise.all([
    showNotification(title, message).catch((err: unknown) => console.warn('notification failed', err)),
    sound ? playBeep().catch((err: unknown) => console.warn('beep failed', err)) : Promise.resolve(),
  ]);
}
