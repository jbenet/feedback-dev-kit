/**
 * The shapes shared by the handlers, the journal, the ingester and the stores.
 *
 * The wire format is Capital OS's /api/feedback request, minus the title: the client never asks
 * for one. A title may still be sent (an agent filing through the API), and is then kept.
 */

export type IssueStatus = 'open' | 'triaged' | 'agent-ready' | 'in-progress' | 'done';
export type IssueKind = 'bug' | 'request' | 'question' | 'chore';
export type IssuePriority = 'P0' | 'P1' | 'P2' | 'P3';
export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const STATUSES: readonly IssueStatus[] = ['open', 'triaged', 'agent-ready', 'in-progress', 'done'];
export const KINDS: readonly IssueKind[] = ['bug', 'request', 'question', 'chore'];
export const PRIORITIES: readonly IssuePriority[] = ['P0', 'P1', 'P2', 'P3'];

/** What the browser sends to POST {base}/api/feedback. Every field is optional on the wire; checkReport decides. */
export interface FeedbackWireRequest {
  /** Idempotency key: 8–64 letters, digits and hyphens (a UUID). `client_id` is accepted too. */
  clientId?: string;
  client_id?: string;
  /** Optional. The client never asks for one; the ingester generates it. */
  title?: string;
  /** Markdown. Images dropped into it are written `![name](attachment:N)`. */
  body?: string;
  kind?: IssueKind;
  priority?: IssuePriority;
  /** The route the report was written on, e.g. `/orders`. */
  page?: string;
  /** { route, url, filters, client: { userAgent, viewport, pixelRatio, touch }, … } */
  context?: Record<string, unknown>;
  /** Annotated screenshots, PNG data URLs. */
  screenshots?: string[];
  /** Images dropped into the body: PNG, JPEG, GIF or WebP data URLs. */
  images?: Array<{ name?: string; dataUrl: string }>;
  /** How far the body's `attachment:N` tokens are from the attachment array (the screenshot takes slot 1). */
  imageOffset?: number;
  /** Alternative to screenshots + images: one list, in token order. */
  attachments?: Array<{ kind?: 'screenshot' | 'image'; name?: string; dataUrl: string }>;
}

/** A picture after validation: decoded later, on the journal's side. */
export interface CheckedAttachment {
  kind: 'screenshot' | 'image';
  contentType: ImageType;
  name?: string;
  base64: string;
}

/** A report after checkReport: complete, typed, sizes capped. */
export interface CheckedReport {
  /** What the sender typed as a title; '' when none (the usual case). */
  title: string;
  body: string;
  kind: IssueKind;
  priority: IssuePriority;
  page: string;
  context: Record<string, unknown>;
  attachments: CheckedAttachment[];
  imageOffset: number;
}

/** A picture as the journal keeps it: a file beside the entry. */
export interface JournaledAttachment {
  kind: 'screenshot' | 'image';
  contentType: ImageType;
  name?: string;
  /** Relative to the journal directory. */
  file: string;
  bytes: number;
  sha256: string;
}

/** One journaled report: `<journal>/<clientId>.json`. */
export interface JournalEntry {
  v: 1;
  clientId: string;
  /** Server time when it arrived. Orders the inbox; the client's clock is never used for anything. */
  receivedAt: string;
  /**
   * What resolveReporter(req) returned at request time, from the session. Never from the body.
   * The ingester may resolve it further (identify), off the request.
   */
  reporter: string | null;
  request: Omit<CheckedReport, 'attachments'> & { attachments: JournaledAttachment[] };
}

export interface FiledRecord {
  clientId: string;
  issueId: string | null;
  location: string | null;
  title: string;
  receivedAt: string;
  filedAt: string;
}

export type JournalStatus =
  | { state: 'journaled' }
  | { state: 'filed'; issueId: string | null; location: string | null }
  | { state: 'refused'; reason: string };

/** A picture handed to a store: bytes, and what it is. The store names the file. */
export interface IssueAttachment {
  kind: 'screenshot' | 'image';
  contentType: ImageType;
  bytes: Uint8Array;
  name?: string;
}

export interface IssueDraft {
  title: string;
  body: string;
  kind: IssueKind;
  priority: IssuePriority;
  reporter: string;
  page: string;
  labels: string[];
  context: Record<string, unknown> | null;
  attachments?: IssueAttachment[];
  /** How far the body's `attachment:N` tokens are from the attachments array. */
  tokenOffset?: number;
  /** The idempotency key. A store files one issue per client id, however often it is asked. */
  clientId?: string;
  /** When the server received it (journal time); stores use it as the issue's creation time. */
  receivedAt?: string;
}

export interface Issue {
  id: string;
  title: string;
  status: IssueStatus;
  kind: IssueKind;
  priority: IssuePriority;
  reporter: string;
  page: string;
  labels: string[];
  body: string;
  context: Record<string, unknown> | null;
  created: string;
  closedAt: string | null;
  /** Where the issue lives: a path relative to the issues directory, or a URL. */
  location: string;
  /** Screenshot paths, relative to the issues directory (served by GET {base}/attachments/<path>). */
  screenshots: string[];
  /** Every picture filed with it, relative to the issues directory. */
  attachments: string[];
  clientId?: string | null;
  /** The version that closed it, from `fixed_in:` or the closing note, when recorded. */
  fixedIn: string | null;
  /** A web URL, when the store has one (GitHub). */
  url?: string | null;
}

export interface IssueFilter {
  status?: IssueStatus[];
  kind?: IssueKind[];
  priority?: IssuePriority[];
  /** Case-insensitive substring over title, body, reporter and page. */
  q?: string;
}

export type IssuePatch = Partial<Pick<Issue, 'status' | 'priority' | 'kind' | 'labels'>>;

/** Where issues go. Every store dedupes on clientId. */
export interface FeedbackStore {
  readonly kind: string;
  /** A sentence saying where issues go, shown in the UI so it is never a guess. */
  readonly destination: string;
  create(draft: IssueDraft): Promise<Issue & { repeat?: boolean }>;
  list(filter?: IssueFilter): Promise<Issue[]>;
  get(id: string): Promise<Issue | null>;
  update(id: string, patch: IssuePatch): Promise<Issue>;
  /** An attachment by its path relative to the issues directory; null when absent or not a picture. */
  readAttachment(path: string): Promise<{ bytes: Uint8Array; contentType: ImageType } | null>;
  /** Pull state changed elsewhere (GitHub) back into the local mirror. */
  sync?(): Promise<{ updated: number }>;
}

/**
 * A store says this when an entry can never be filed, however often it is tried. The ingester moves
 * it to refused/ with the reason instead of retrying forever. Anything else is retried.
 */
export class RefusedError extends Error {
  override name = 'RefusedError';
}

/** A store says this when it knows how long to wait (a rate limit). The ingester waits at least that long. */
export class RetryLaterError extends Error {
  override name = 'RetryLaterError';
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}
