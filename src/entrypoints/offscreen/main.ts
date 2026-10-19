import { browser } from '#imports';
import { isOffscreenRequest } from '@/lib/alert-messages';

/**
 * Offscreen-документ: service worker не умеет играть звук, поэтому сигнал
 * «агент упёрся в рискованное действие» синтезируется здесь через Web Audio.
 */

let ctx: AudioContext | null = null;

async function beep(): Promise<void> {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  const start = ctx.currentTime + 0.05;
  // Два раза по три восходящих тона — заметно, но не пугающе.
  const notes = [660, 880, 1100];
  for (let rep = 0; rep < 2; rep++) {
    notes.forEach((freq, i) => {
      const t = start + rep * 0.9 + i * 0.18;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.17);
    });
  }
  await new Promise((r) => setTimeout(r, 2000));
}

browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!isOffscreenRequest(msg)) return;
  beep().then(
    () => sendResponse({ ok: true }),
    (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true;
});
