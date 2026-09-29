/**
 * What a report must be before it is journaled. What is refused here is refused now, with the
 * reason and the right status, instead of sitting in the journal failing on every ingest pass.
 */
import { continuations, titleFrom } from './title.ts';
import {
  KINDS, PRIORITIES,
  type CheckedAttachment, type CheckedReport, type ImageType, type IssueKind, type IssuePriority,
} from './types.ts';

/** A client id: what crypto.randomUUID makes, and nothing that could name a path. */
export const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
export const isClientId = (v: unknown): v is string => typeof v === 'string' && CLIENT_ID.test(v);

/** A v4 UUID, from getRandomValues when randomUUID is missing (plain http leaves it undefined in browsers). */
export function newClientId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface Limits {
  /** The whole request, in bytes, read before parsing. GUESS: every picture plus generous text. */
  maxRequestBytes: number;
  /** One picture's base64. As Capital OS. */
  maxImageBase64: number;
  /** Every picture together, base64. GUESS (Capital OS: 40 MB). Over it: 413. */
  maxTotalBase64: number;
  /** How many pictures. GUESS. */
  maxAttachments: number;
  /** The markdown body, in characters. GUESS; GitHub caps an issue body at 65,536. */
  maxBodyChars: number;
  /** A title someone sent, in characters. */
  maxTitleChars: number;
  /** The captured context, serialized. GUESS. */
  maxContextBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxRequestBytes: 48_000_000,
  maxImageBase64: 12_000_000,
  maxTotalBase64: 40_000_000,
  maxAttachments: 20,
  maxBodyChars: 60_000,
  maxTitleChars: 200,
  maxContextBytes: 64_000,
};

export type Checked<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/;

/** Keys in the captured context that only the server may write. A client value is dropped. */
const SERVER_CONTEXT_KEYS = ['reporter', 'reporterVerification', 'user', 'journaledAt', 'receivedAt'];

/** Query parameters and filter keys that carry credentials, not page state. */
export const SECRET_PARAM = /^(?:.*[_-])?(?:token|access_token|id_token|key|api_key|apikey|code|password|passwd|secret|signature|sig|session|auth)$/i;

/**
 * The client captures the URL and its query as page state; a magic link or an OAuth redirect puts a
 * credential there. Such values are replaced before anything is journaled (the client should strip
 * them too; this is the second line).
 */
export function scrubSecrets(context: Record<string, unknown>): void {
  if (typeof context.url === 'string') {
    try {
      const u = new URL(context.url);
      let changed = false;
      for (const k of [...u.searchParams.keys()]) {
        if (SECRET_PARAM.test(k)) { u.searchParams.set(k, '[removed]'); changed = true; }
      }
      if (u.hash && /(?:token|code|key|secret)=/i.test(u.hash)) { u.hash = ''; changed = true; }
      if (u.username || u.password) { u.username = ''; u.password = ''; changed = true; }
      if (changed) context.url = u.toString();
    } catch { /* not a URL: left as text */ }
  }
  if (context.filters && typeof context.filters === 'object' && !Array.isArray(context.filters)) {
    const filters = { ...(context.filters as Record<string, unknown>) };
    for (const k of Object.keys(filters)) if (SECRET_PARAM.test(k)) filters[k] = '[removed]';
    context.filters = filters;
  }
}

/**
 * A report as the box sends it, checked: words (a title or a body), only the four image types
 * (screenshots PNG only), sizes capped. Odd kinds and priorities fall back to bug and P2.
 */
export function checkReport(raw: unknown, limits: Limits = DEFAULT_LIMITS): Checked<CheckedReport> {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  // A title is one line, and a line-end backslash is a typed newline, not text.
  const title = continuations(str(b.title)).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const body = continuations(str(b.body)).replace(/\r\n/g, '\n');
  if (!title && !titleFrom(body)) {
    return { ok: false, status: 400, error: 'Say what happened. A description is enough.' };
  }
  if (body.length > limits.maxBodyChars) {
    return { ok: false, status: 413, error: `The description is too long (over ${limits.maxBodyChars.toLocaleString('en-US')} characters).` };
  }
  if (title.length > limits.maxTitleChars) {
    return { ok: false, status: 413, error: `The title is too long (over ${limits.maxTitleChars} characters).` };
  }

  // Pictures: the Capital OS pair (screenshots, images), or one `attachments` list in token order.
  const listed: Array<{ kind: 'screenshot' | 'image'; name?: string; dataUrl: string }> = [];
  if (Array.isArray(b.attachments) && b.attachments.length > 0) {
    for (const a of b.attachments as unknown[]) {
      const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
      listed.push({ kind: o.kind === 'screenshot' ? 'screenshot' : 'image', name: typeof o.name === 'string' ? o.name : undefined, dataUrl: str(o.dataUrl) });
    }
  } else {
    for (const s of Array.isArray(b.screenshots) ? b.screenshots : []) listed.push({ kind: 'screenshot', dataUrl: str(s) });
    for (const i of Array.isArray(b.images) ? b.images : []) {
      const o = (i && typeof i === 'object' ? i : {}) as Record<string, unknown>;
      listed.push({ kind: 'image', name: typeof o.name === 'string' ? o.name : undefined, dataUrl: str(o.dataUrl) });
    }
  }
  if (listed.length > limits.maxAttachments) {
    return { ok: false, status: 413, error: `Too many pictures (at most ${limits.maxAttachments}).` };
  }
  const attachments: CheckedAttachment[] = [];
  let total = 0;
  for (const a of listed) {
    const m = DATA_URL.exec(a.dataUrl);
    if (a.kind === 'screenshot') {
      if (!m || m[1] !== 'image/png') return { ok: false, status: 400, error: 'A screenshot was not a PNG.' };
    } else if (!m) {
      return { ok: false, status: 400, error: 'An attached file was not a PNG, JPEG, GIF or WebP.' };
    }
    if (m[2]!.length > limits.maxImageBase64) {
      return { ok: false, status: 413, error: a.kind === 'screenshot' ? 'A screenshot is too large.' : 'An attached file is too large.' };
    }
    total += m[2]!.length;
    // A file name is for alt text only: one line, no path, bounded.
    const name = a.name?.replace(/[\r\n\\/]+/g, ' ').trim().slice(0, 120) || undefined;
    attachments.push({ kind: a.kind, contentType: m[1] as ImageType, base64: m[2]!, ...(name ? { name } : {}) });
  }
  if (total > limits.maxTotalBase64) {
    return { ok: false, status: 413, error: 'The pictures together are too large. Remove one and send again.' };
  }

  const context: Record<string, unknown> = b.context && typeof b.context === 'object' && !Array.isArray(b.context)
    ? { ...(b.context as Record<string, unknown>) } : {};
  for (const key of SERVER_CONTEXT_KEYS) delete context[key];
  scrubSecrets(context);
  let contextBytes: number;
  try { contextBytes = Buffer.byteLength(JSON.stringify(context)); } catch { return { ok: false, status: 400, error: 'The captured context is not plain data.' }; }
  if (contextBytes > limits.maxContextBytes) {
    return { ok: false, status: 413, error: 'The captured page context is too large.' };
  }

  const kind = (KINDS as readonly string[]).includes(str(b.kind)) ? str(b.kind) as IssueKind : 'bug';
  const priority = (PRIORITIES as readonly string[]).includes(str(b.priority)) ? str(b.priority) as IssuePriority : 'P2';
  const page = str(b.page).replace(/[\r\n]+/g, ' ').trim().slice(0, 2_000) || '/';
  const imageOffset = Number.isInteger(b.imageOffset) && (b.imageOffset as number) >= 0 && (b.imageOffset as number) <= listed.length
    ? b.imageOffset as number : 0;

  return { ok: true, value: { title, body, kind, priority, page, context, attachments, imageOffset } };
}
