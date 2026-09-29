/**
 * An idempotency key for one request from the browser (issue 0104).
 *
 * `crypto.randomUUID` exists only in a secure context: https, or localhost. The live server is
 * reached from the local network over plain http (docs/agent-rules/real-data.md), where Safari and
 * Chrome leave it undefined, so every status change on an iPad failed with "crypto.randomUUID is
 * not a function". `crypto.getRandomValues` is available in every context, so the fallback builds
 * the same kind of version-4 UUID from it. No Math.random: two tabs must not share a key.
 */
export function newRequestKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
