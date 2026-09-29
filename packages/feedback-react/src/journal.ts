/**
 * The outbox's rules, with no browser in them: the backoff, what counts as the server accepting a
 * report, and what a response does to the outbox. The storage and the sender are in outbox.ts.
 *
 * File posts the report to the server, which journals it to disk and answers 202 at once; the
 * server files it afterwards. The browser's outbox is the fallback for when the request cannot
 * reach the server at all — a restart, the network — and keeps resending until the server
 * accepts. The server dedupes on the client id, so a resend never files twice.
 */

/**
 * What the feedback route takes. There is no title: the server writes one from the body, the page
 * and the screenshots (an LLM, or the first line of the body trimmed to 80 characters).
 */
export interface FeedbackRequest {
  /** Markdown. Pictures dropped into it are `![name](attachment:N)` references. */
  body: string;
  kind: string;
  priority: string;
  page: string;
  /** route, url, filters, client {userAgent, viewport, pixelRatio, touch}, and anything the app adds. */
  context: Record<string, unknown>;
  /** PNG data URLs, in order. */
  screenshots: string[];
  /** PNG, JPEG, GIF or WebP data URLs dropped into the body; `attachment:N` counts these from 1. */
  images: Array<{ name?: string; dataUrl: string }>;
  /** How many screenshots are numbered before the images, so the server can resolve `attachment:N`. */
  imageOffset: number;
}

export interface JournalEntry {
  /** The idempotency key: the server files one issue per client id, however often it is sent. */
  clientId: string;
  createdAt: string;
  /** Sends that ended without a confirmation. */
  attempts: number;
  /** When the sender may try again on its own (ms since the epoch). */
  nextAt: number;
  lastError: string | null;
  /**
   * The server answered and said no (a 4xx: too large, not a PNG). Resending the same thing gets
   * the same answer, so it waits for "Retry now" instead of the clock.
   */
  refused: boolean;
  /** Kept in localStorage without its pictures, because IndexedDB was unavailable. */
  textOnly?: boolean;
  request: FeedbackRequest;
}

/**
 * How long to wait after the nth unconfirmed send: 5 s, 15 s, 60 s, then every 2 minutes. GUESS:
 * a busy server lasts minutes, a restart well under one; two minutes keeps a stuck report trying
 * without adding load to a server that is already struggling.
 */
export const BACKOFF_MS = [5_000, 15_000, 60_000] as const;
export const BACKOFF_CAP_MS = 120_000;
/**
 * One send's patience: 3 s, plus 1 s for every megabyte of pictures to upload, at most 20 s. GUESS:
 * the journal answers in well under 100 ms; the rest is the upload.
 */
export const SEND_TIMEOUT_MS = 3_000;
export const sendTimeout = (bodyChars: number) => Math.min(20_000, SEND_TIMEOUT_MS + Math.floor(bodyChars / 1_000_000) * 1_000);

export function retryDelay(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 1) return BACKOFF_MS[0];
  return BACKOFF_MS[Math.floor(attempts) - 1] ?? BACKOFF_CAP_MS;
}

/** A client id the server accepts: what request-key.ts makes, and nothing that could be a path. */
export const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
export const isClientId = (v: unknown): v is string => typeof v === 'string' && CLIENT_ID.test(v);

/** An issue id as the server gives them out: a number, or a GitHub-style `#123`-free slug. */
const ISSUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type SendOutcome =
  /** Journaled on the server: safe there, filed shortly. `id` when it was already filed. */
  | { kind: 'journaled'; id: string | null; repeat: boolean }
  | { kind: 'filed'; id: string; repeat: boolean }
  | { kind: 'retry'; error: string }
  | { kind: 'refused'; error: string };

/**
 * What one response means. Acceptance is a 2xx that says it journaled and echoes this entry's
 * client id; a server that files synchronously confirms with an issue id and the client id, and
 * that counts too. Anything else — a 200 from a proxy, an HTML error page, a response for another
 * report — leaves the entry in the outbox. 408 and 429 are the server asking for later, not no.
 */
export function classify(clientId: string, status: number | null, json: unknown, networkError?: string): SendOutcome {
  if (status === null) return { kind: 'retry', error: networkError || 'No answer from the server' };
  const body = (json && typeof json === 'object' ? json : {}) as { id?: unknown; clientId?: unknown; error?: unknown; repeat?: unknown; journaled?: unknown };
  const said = typeof body.error === 'string' && body.error ? body.error : null;
  if (status >= 200 && status < 300) {
    if (body.journaled === true && body.clientId === clientId) {
      return { kind: 'journaled', id: typeof body.id === 'string' && ISSUE_ID.test(body.id) ? body.id : null, repeat: body.repeat === true };
    }
    if (typeof body.id === 'string' && ISSUE_ID.test(body.id) && body.clientId === clientId) {
      return { kind: 'filed', id: body.id, repeat: body.repeat === true };
    }
    return { kind: 'retry', error: 'The server answered without confirming it kept the report' };
  }
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { kind: 'refused', error: said ?? `The server refused it (${status})` };
  }
  return { kind: 'retry', error: said ?? `The server answered ${status}` };
}

/**
 * The outbox after one send. The entry leaves only when the server confirmed it kept it (journaled,
 * or filed); every other outcome keeps it, counted and rescheduled. Others are untouched.
 */
export function settle(entries: JournalEntry[], clientId: string, outcome: SendOutcome, now: number): JournalEntry[] {
  if (outcome.kind === 'filed' || outcome.kind === 'journaled') return entries.filter((e) => e.clientId !== clientId);
  return entries.map((e) => {
    if (e.clientId !== clientId) return e;
    const attempts = e.attempts + 1;
    return {
      ...e,
      attempts,
      lastError: outcome.error,
      refused: outcome.kind === 'refused',
      nextAt: now + retryDelay(attempts),
    };
  });
}

/** Whether the sender should try this entry now. A kick (page load, online, a live server) skips the clock, not a refusal. */
export function due(entry: JournalEntry, now: number, kicked: boolean): boolean {
  if (entry.refused) return false;
  return kicked || entry.nextAt <= now;
}

/** The first line of words in a markdown body, trimmed to 80 characters: the title a server falls back to. */
export function firstLine(text: string, max = 80): string {
  const first = text.split('\n')
    .map((l) => l.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/^[#>*\-\s]+/, '').trim())
    .find(Boolean);
  return first ? (first.length > max ? `${first.slice(0, max - 1)}…` : first) : '';
}

/** The report's name in the outbox list, until the server has written its title. */
export const entryTitle = (entry: JournalEntry): string => firstLine(entry.request.body) || 'Untitled';

/** How many pictures go with it. */
export const entryPictures = (entry: JournalEntry) => entry.request.screenshots.length + entry.request.images.length;

/** What "Copy text" copies: enough to file it by hand if everything else fails. */
export function entryText(entry: JournalEntry): string {
  const r = entry.request;
  return [r.body.trim(), '', `${r.kind} · ${r.priority} · ${r.page} · written ${entry.createdAt}`].join('\n');
}
