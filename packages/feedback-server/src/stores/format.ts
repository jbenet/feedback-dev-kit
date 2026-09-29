/**
 * The issue file format: markdown with a small frontmatter, read and written by hand.
 *
 * No YAML library on purpose: the frontmatter is a closed set of scalar and string-array fields,
 * and a hand-written serializer keeps the comments and field order a person expects in an editor.
 * Lines the writer does not manage (assignee:, branch:, fixed_in:, client_id:, anything a person
 * adds) are kept verbatim, in order, so a status change never drops them.
 *
 *   ---
 *   id: "0007"
 *   title: Export button does nothing on the orders page
 *   status: open          # open | triaged | agent-ready | in-progress | done
 *   kind: bug             # bug | request | question | chore
 *   priority: P2          # P0 blocking | P1 serious | P2 normal | P3 someday
 *   reporter: ada
 *   page: /orders
 *   created: 2026-09-29T10:00:00Z
 *   labels: []
 *   screenshots: [attachments/0007-screenshot.png]
 *   attachments: [attachments/0007-screenshot.png]
 *   client_id: 3f0c…
 *   ---
 *
 *   The body, in markdown.
 *
 *   ![Screenshot](attachments/0007-screenshot.png)
 *
 *   ```json context
 *   { … }
 *   ```
 */
import type { IssueKind, IssuePriority, IssueStatus } from '../types.ts';

export interface ParsedIssue {
  id: string;
  title: string;
  status: IssueStatus;
  kind: IssueKind;
  priority: IssuePriority;
  reporter: string;
  page: string;
  created: string;
  closedAt?: string | null;
  labels: string[];
  body: string;
  context: Record<string, unknown> | null;
  screenshots: string[];
  attachments: string[];
  fixedIn: string | null;
  /** Frontmatter lines the writer does not manage, verbatim and in order. */
  extra?: string[];
  clientId?: string | null;
}

const COMMENTED = new Set(['status', 'kind', 'priority']);
const MANAGED = new Set([
  'id', 'title', 'status', 'kind', 'priority', 'reporter', 'page', 'created', 'labels',
  'screenshots', 'attachments', 'screenshot', 'attachment', 'closed_at',
]);

export function parseIssue(file: string, fallbackId: string): ParsedIssue {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(file.trim());
  const front = match ? match[1]! : '';
  const rest = match ? match[2]! : file;

  const fields: Record<string, string | string[]> = {};
  const extra: string[] = [];
  for (const line of front.split(/\r?\n/)) {
    const m = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    if (!MANAGED.has(key)) extra.push(line.trimEnd());
    let raw = m[2]!.trim();
    if (COMMENTED.has(key)) raw = raw.replace(/\s+#.*$/, '').trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      fields[key] = raw.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
    } else {
      fields[key] = unquote(raw);
    }
  }

  const str = (k: string, d = ''): string => (typeof fields[k] === 'string' ? (fields[k] as string) : d);
  const legacy = str('screenshot') || str('attachment');
  const screenshots = Array.isArray(fields['screenshots']) ? (fields['screenshots'] as string[]) : legacy ? [legacy] : [];
  const attachments = Array.isArray(fields['attachments']) ? (fields['attachments'] as string[]) : [...screenshots];
  // The screenshot links in the prose are for somebody reading the file in an editor; the app shows the pictures.
  let trimmed = rest;
  for (const shot of screenshots) trimmed = trimmed.replace(`![Screenshot](${shot})`, '');
  const { body, context } = splitContext(trimmed);
  const fromBody = /\*\*[^*]*?\(([A-Z]+\d+)\)/.exec(body);

  return {
    fixedIn: str('fixed_in') || fromBody?.[1] || null,
    id: str('id', fallbackId),
    title: str('title', '(untitled)'),
    status: (str('status', 'open') === 'review' ? 'done' : str('status', 'open')) as IssueStatus,
    kind: str('kind', 'bug') as IssueKind,
    priority: str('priority', 'P2') as IssuePriority,
    reporter: str('reporter', 'unknown'),
    page: str('page', ''),
    created: str('created', ''),
    closedAt: str('closed_at') || null,
    clientId: str('client_id') || null,
    labels: Array.isArray(fields['labels']) ? (fields['labels'] as string[]) : [],
    screenshots,
    attachments,
    body,
    context,
    extra,
  };
}

function splitContext(rest: string): { body: string; context: Record<string, unknown> | null } {
  const fence = /```json context\r?\n([\s\S]*?)```/.exec(rest);
  if (!fence) return { body: rest.trim(), context: null };
  let context: Record<string, unknown> | null = null;
  try { context = JSON.parse(fence[1]!) as Record<string, unknown>; } catch { context = null; }
  return { body: rest.replace(fence[0], '').trim(), context };
}

/** The writer quotes with JSON.stringify, so the reader unescapes with JSON.parse. */
function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const v: unknown = JSON.parse(s);
      if (typeof v === 'string') return v;
    } catch { /* not JSON: plain strip */ }
    return s.slice(1, -1);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

/** Quoted whenever the plain value would not read back as itself. */
const NEEDS_QUOTES = /^$|^[\d\s[{'"]|[:#"\\\r\n,\]]|\s$/;
const quote = (s: string): string => (NEEDS_QUOTES.test(s) ? JSON.stringify(s) : s);
const listItem = (s: string): string => (/[,\]\s"'[]/.test(s) ? JSON.stringify(s) : s);

export function serializeIssue(issue: ParsedIssue): string {
  const lines = [
    '---',
    `id: ${JSON.stringify(issue.id)}`,
    `title: ${quote(issue.title)}`,
    `status: ${issue.status.padEnd(14)}# open | triaged | agent-ready | in-progress | done`,
    `kind: ${issue.kind.padEnd(16)}# bug | request | question | chore`,
    `priority: ${issue.priority.padEnd(12)}# P0 blocking | P1 serious | P2 normal | P3 someday`,
    `reporter: ${quote(issue.reporter)}`,
    `page: ${quote(issue.page)}`,
    `created: ${issue.created}`,
    ...(issue.closedAt ? [`closed_at: ${issue.closedAt}`] : []),
    `labels: [${issue.labels.map(listItem).join(', ')}]`,
    ...(issue.screenshots.length > 0 ? [`screenshots: [${issue.screenshots.join(', ')}]`] : []),
    ...(issue.attachments.length > 0 ? [`attachments: [${issue.attachments.join(', ')}]`] : []),
    ...(issue.extra ?? []),
    '---',
    '',
    issue.body.trim(),
    '',
  ];
  for (const shot of issue.screenshots) {
    lines.push(`![Screenshot](${shot})`);
    lines.push('');
  }
  if (issue.context) {
    lines.push('```json context');
    // A fence inside the context would end the block early.
    lines.push(JSON.stringify(issue.context, null, 2).replace(/```/g, '`​``'));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '') || 'issue';
}
