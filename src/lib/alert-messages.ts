/** background → offscreen-документ */
export type OffscreenRequest = { type: 'offscreen:beep' };

export function isOffscreenRequest(msg: unknown): msg is OffscreenRequest {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'offscreen:beep';
}
