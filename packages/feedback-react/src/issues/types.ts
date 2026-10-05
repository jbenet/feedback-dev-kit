/** An issue as the server's read API returns it (GET /api/issues, GET /api/issues/:id). */
export type IssueStatus = 'open' | 'triaged' | 'agent-ready' | 'in-progress' | 'done';
export type IssueKind = 'bug' | 'request' | 'question' | 'chore';
export type IssuePriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface Issue {
  id: string;
  /** Written by the server (an LLM, or the body's first line), never typed by the reporter. */
  title: string;
  /** Markdown; pictures refer to files filed with it, e.g. `attachments/0007-2.png`. */
  body: string;
  kind: IssueKind | string;
  priority: IssuePriority | string;
  status: IssueStatus | string;
  /** Resolved by the server from the session. */
  reporter: string;
  page: string;
  /** ISO time it was filed. */
  created: string;
  closedAt?: string | null;
  /** Screenshot paths, relative to the issues store; the client turns them into URLs. */
  screenshots: string[];
  attachments?: string[];
  labels?: string[];
  context?: Record<string, unknown> | null;
  /** The release that closed it, when one is recorded. */
  fixedIn?: string | null;
  /** Where it lives: a file path, or a URL for a GitHub issue. */
  location?: string;
}

export const STATUSES: IssueStatus[] = ['open', 'triaged', 'agent-ready', 'in-progress', 'done'];
export const PRIORITIES: IssuePriority[] = ['P0', 'P1', 'P2', 'P3'];
export const KINDS: IssueKind[] = ['bug', 'request', 'question', 'chore'];
/** A kind as a CSS class suffix: one of ours, or 'other' (the kind is reporter data, not a class list). */
export const KIND_CLASS = (kind: string): string => ((KINDS as string[]).includes(kind) ? kind : 'other');

/** What each priority means: an order, not a delivery date — the queue decides the date. */
export const PRIORITY: Record<IssuePriority, { means: string; detail: string }> = {
  P0: { means: 'Blocking', detail: 'Nobody can work around this. It goes to the front.' },
  P1: { means: 'Serious', detail: 'There is a workaround and it hurts to use.' },
  P2: { means: 'Normal', detail: 'Worth doing. Ordered against everything else at P2.' },
  P3: { means: 'Someday', detail: 'A good idea with no clock on it.' },
};
