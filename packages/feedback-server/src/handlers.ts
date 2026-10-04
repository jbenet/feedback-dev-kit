/**
 * The HTTP side, framework-agnostic: a Request goes in, a Response comes out. Adapters for Next.js
 * route handlers (next.ts) and plain Node http (node.ts) are thin wrappers around handle().
 *
 *   POST  /api/feedback                  journal a report; 202 once it is on disk
 *   GET   /api/feedback?clientId=…       where a journaled report stands (reads the journal only)
 *   GET   /api/feedback/export?since=…   issues created after `since` (Bearer FEEDBACK_EXPORT_TOKEN)
 *   POST  /api/feedback/mcp              the feedback tools over MCP, for other apps (with `mcp` options; mcp.ts)
 *   GET   /api/issues                    the issues page's list (?status=&kind=&priority=&q=)
 *   GET   /api/issues/:id                one issue
 *   PATCH /api/issues/:id                { status?, priority?, kind?, labels? }
 *   GET   /api/issues/attachments/…      a picture filed with an issue
 *
 * The issue reads are also served under /api/feedback/issues… and /api/feedback/attachments/…, so one
 * catch-all route can carry everything.
 *
 * The POST never touches the store, a database, or anything else that can be busy: origin check,
 * size limits, validation, one journal write, answer. The reporter comes from resolveReporter(req)
 * — your session — and never from the request body.
 */
import { timingSafeEqual } from 'node:crypto';
import { ingesterFor } from './ingest.ts';
import { createJournal, type Journal } from './journal.ts';
import { checkOrigin, type OriginPolicy } from './origin.ts';
import { STATUSES, KINDS, PRIORITIES, type FeedbackStore, type IssueFilter, type IssuePatch, type IssueStatus, type IssueKind, type IssuePriority } from './types.ts';
import { patternScreen } from './injection.ts';
import { createFeedbackMcp, type FeedbackMcpOptions } from './mcp.ts';
import { checkReport, DEFAULT_LIMITS, isClientId, newClientId, type Limits } from './validate.ts';

export type Action = 'read' | 'update' | 'attachment';

export interface HandlerOptions {
  /** The journal, or its folder (e.g. `issues/inbox`). */
  journal: Journal | string;
  /** Where the ingester files issues; the reads (issues, export, attachments) come from it. */
  store?: FeedbackStore;
  /** Default '/api/feedback'. */
  basePath?: string;
  /** Where the issue reads live. Default '/api/issues'. They are also served under `${basePath}/issues`. */
  issuesPath?: string;
  /**
   * New reports per reporter (or per client address when there is no reporter) per minute. Resends of
   * a known client id are free: they write nothing. Default 30 (GUESS); false turns it off.
   */
  rateLimit?: { perMinute: number } | false;
  /**
   * Who is reporting, from your session: a cookie, a header your auth proxy sets. Must be fast and
   * must not wait on a database — resolve further in the ingester's identify(). Return null when
   * nobody is signed in. A throw is treated as null: a report is never lost to a session lookup.
   */
  resolveReporter?: (req: Request) => string | null | undefined | Promise<string | null | undefined>;
  /** Same-origin by default. false turns the check off (only for non-browser clients behind other auth). */
  origin?: OriginPolicy | false;
  limits?: Partial<Limits>;
  /**
   * Whether this server files reports. PL LabOS tools refuses on development copies so two servers never
   * hand out the same issue numbers; the browser's outbox keeps the report until the right server
   * takes it. Default true.
   */
  accept?: boolean | (() => boolean);
  refusalMessage?: string;
  /** Bearer token for GET export. Default: FEEDBACK_EXPORT_TOKEN. Unset: the export answers 404. */
  exportToken?: string | (() => string | undefined);
  /**
   * May this request read issues, update one, or fetch a picture? Default: allow. Issues can hold
   * anything a reporter saw; put them behind your auth. Return a Response to answer with it instead.
   */
  authorize?: (req: Request, action: Action) => boolean | Response | Promise<boolean | Response>;
  /**
   * A report that looks like a prompt injection (injection.ts): 'flag' (default) journals it and the
   * ingester files it flagged; 'refuse' answers 422 with the reasons, and the reporter's browser keeps
   * the report and shows why it was not filed.
   */
  onSuspicious?: 'flag' | 'refuse';
  /** Called after a new report is journaled. Default: kick the ingester started for this journal. */
  onJournaled?: (clientId: string) => void;
  /**
   * Serve the feedback tools over MCP at `${basePath}/mcp`, so other apps and their agents can give
   * this one feedback (docs/MCP.md). `identify` says who is calling; without `mcp` there is no endpoint.
   */
  mcp?: Omit<FeedbackMcpOptions, 'journal' | 'store'>;
}

export interface FeedbackHandler {
  handle(req: Request): Promise<Response>;
  readonly journal: Journal;
  readonly basePath: string;
  readonly issuesPath: string;
  /** Whether a path belongs to this handler (for adapters that share a server). */
  owns(pathname: string): boolean;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

/** Read at most `max` bytes of the body; null when it is larger. */
async function readLimited(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const csv = <T extends string>(v: string | null, allowed: readonly T[]): T[] | undefined => {
  if (!v) return undefined;
  const out = v.split(',').map((s) => s.trim()).filter((s): s is T => (allowed as readonly string[]).includes(s));
  return out.length ? out : undefined;
};

export function createFeedbackHandler(options: HandlerOptions): FeedbackHandler {
  const journal = typeof options.journal === 'string' ? createJournal(options.journal) : options.journal;
  const basePath = (options.basePath ?? '/api/feedback').replace(/\/$/, '');
  const issuesPath = (options.issuesPath ?? '/api/issues').replace(/\/$/, '');
  const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  const perMinute = options.rateLimit === false ? 0 : options.rateLimit?.perMinute ?? 30;
  /** New reports in the last minute, per sender. In memory: a restart forgives everyone. */
  const recent = new Map<string, number[]>();
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const store = options.store;
  const accepting = () => (typeof options.accept === 'function' ? options.accept() : options.accept ?? true);
  const exportToken = () => (typeof options.exportToken === 'function' ? options.exportToken() : options.exportToken ?? process.env.FEEDBACK_EXPORT_TOKEN);
  const journaled = options.onJournaled ?? (() => ingesterFor(journal.dir)?.kick());
  const mcp = options.mcp ? createFeedbackMcp({
    limits: options.limits, onSuspicious: options.onSuspicious, onJournaled: options.onJournaled, ...options.mcp, journal, store,
  }) : null;

  async function allowed(req: Request, action: Action): Promise<Response | null> {
    if (!options.authorize) return null;
    const verdict = await options.authorize(req, action);
    if (verdict instanceof Response) return verdict;
    return verdict ? null : json({ error: 'Not allowed.' }, 403);
  }

  async function submit(req: Request): Promise<Response> {
    if (!accepting()) {
      return json({ error: options.refusalMessage ?? 'This server does not file feedback. It stays in your browser until the right server takes it.' }, 403);
    }
    if (options.origin !== false) {
      const bad = checkOrigin(req, options.origin ?? {});
      if (bad) return json({ error: bad }, 403);
    }
    const text = await readLimited(req, limits.maxRequestBytes).catch(() => undefined);
    if (text === null) return json({ error: 'The report is too large. Remove a picture and send again.' }, 413);
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text ?? '') as Record<string, unknown>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    } catch {
      return json({ error: 'The report did not arrive whole. It is still in your browser; it will be sent again.' }, 400);
    }
    // A resend after a timeout must not file twice: the client id names the journal file. A malformed
    // one is refused, not replaced; none at all (an old client) gets one.
    const given = raw.clientId ?? raw.client_id;
    if (given !== undefined && !isClientId(given)) return json({ error: 'The report\'s client id is malformed.' }, 400);
    const clientId = (given as string | undefined) ?? newClientId();
    const checked = checkReport(raw, limits);
    if (!checked.ok) return json({ error: checked.error, clientId }, checked.status);
    if (options.onSuspicious === 'refuse') {
      const { reasons } = patternScreen({ body: checked.value.body, context: checked.value.context });
      if (reasons.length) {
        return json({ error: `Not filed: it reads like instructions to an automated system (${reasons.join('; ')}). Describe the problem in your own words and send again.`, clientId }, 422);
      }
    }

    let reporter: string | null = null;
    try {
      const who = options.resolveReporter ? await options.resolveReporter(req) : null;
      reporter = typeof who === 'string' && who.trim() ? who.trim().slice(0, 200) : null;
    } catch { reporter = null; }

    const sender = reporter ?? `addr:${req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'}`;
    if (perMinute > 0) {
      const cutoff = Date.now() - 60_000;
      const times = (recent.get(sender) ?? []).filter((t) => t > cutoff);
      recent.set(sender, times);
      if (times.length >= perMinute && !(await journal.status(clientId))) {
        return json({ error: 'Too many reports in a minute. This one is kept in your browser and sent shortly.', clientId }, 429, { 'retry-after': '60' });
      }
      if (recent.size > 10_000) for (const [k, v] of recent) if (!v.some((t) => t > cutoff)) recent.delete(k);
    }

    try {
      const done = await journal.write({ clientId, reporter, report: checked.value });
      if (done.already === null && perMinute > 0) recent.get(sender)?.push(Date.now());
      if (done.already === 'refused') return json({ error: done.reason, clientId, state: 'refused' }, 422);
      if (done.already === null) {
        try { journaled(clientId); } catch { /* filing is someone else's problem; the report is safe */ }
      }
      return json({
        journaled: true, clientId, repeat: done.already !== null,
        ...(done.already === 'filed' && done.filed.issueId ? { id: done.filed.issueId } : {}),
      }, 202);
    } catch (err) {
      return json({
        error: `The server could not save it: ${err instanceof Error ? err.message : 'unknown error'}. It is still in your browser and will be sent again.`,
      }, 500);
    }
  }

  async function status(url: URL): Promise<Response> {
    const clientId = url.searchParams.get('clientId') ?? url.searchParams.get('client_id') ?? '';
    if (!isClientId(clientId)) return json({ error: 'Give a clientId.' }, 400);
    const s = await journal.status(clientId);
    if (!s) return json({ state: 'unknown' }, 404);
    if (s.state === 'filed') return json({ state: 'filed', id: s.issueId, location: s.location });
    if (s.state === 'refused') return json({ state: 'refused', error: s.reason });
    return json({ state: 'journaled' });
  }

  async function exportIssues(req: Request, url: URL): Promise<Response> {
    const token = exportToken();
    if (!token || !store) return new Response(null, { status: 404 });
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(req.headers.get('authorization') ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return new Response(null, { status: 401 });
    const since = url.searchParams.get('since') ?? '';
    const at = Date.parse(since);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(since) || !Number.isFinite(at)) {
      return json({ error: 'Give since as an ISO timestamp with a timezone.' }, 400);
    }
    // `created` is when the issue was filed, not when it was journaled, so a report that waited in the
    // journal still appears after a cursor that moved past its arrival.
    const items = (await store.list()).filter((i) => Date.parse(i.created) > at).sort((a, b) => a.created.localeCompare(b.created));
    return json({ items });
  }

  async function issues(req: Request, url: URL, rest: string[]): Promise<Response> {
    if (!store) return json({ error: 'No issue store is configured.' }, 404);
    const id = rest[0] ? decodeURIComponent(rest[0]) : null;
    if (req.method === 'GET' && !id) {
      const denied = await allowed(req, 'read');
      if (denied) return denied;
      const filter: IssueFilter = {
        status: csv<IssueStatus>(url.searchParams.get('status'), STATUSES),
        kind: csv<IssueKind>(url.searchParams.get('kind'), KINDS),
        priority: csv<IssuePriority>(url.searchParams.get('priority'), PRIORITIES),
        q: url.searchParams.get('q') ?? undefined,
      };
      return json({ issues: await store.list(filter), destination: store.destination, store: store.kind });
    }
    if (!id || rest.length > 1 || !/^[\w.-]{1,64}$/.test(id)) return json({ error: 'Not found.' }, 404);
    if (req.method === 'GET') {
      const denied = await allowed(req, 'read');
      if (denied) return denied;
      const issue = await store.get(id);
      return issue ? json({ issue }) : json({ error: 'Not found.' }, 404);
    }
    if (req.method === 'PATCH') {
      if (options.origin !== false) {
        const bad = checkOrigin(req, options.origin ?? {});
        if (bad) return json({ error: bad }, 403);
      }
      const denied = await allowed(req, 'update');
      if (denied) return denied;
      let body: Record<string, unknown>;
      try { body = JSON.parse((await readLimited(req, 64_000)) ?? '') as Record<string, unknown>; } catch { return json({ error: 'Send JSON.' }, 400); }
      const patch: IssuePatch = {};
      if (body.status !== undefined) {
        if (!(STATUSES as readonly unknown[]).includes(body.status)) return json({ error: 'Unknown status.' }, 400);
        patch.status = body.status as IssueStatus;
      }
      if (body.priority !== undefined) {
        if (!(PRIORITIES as readonly unknown[]).includes(body.priority)) return json({ error: 'Unknown priority.' }, 400);
        patch.priority = body.priority as IssuePriority;
      }
      if (body.kind !== undefined) {
        if (!(KINDS as readonly unknown[]).includes(body.kind)) return json({ error: 'Unknown kind.' }, 400);
        patch.kind = body.kind as IssueKind;
      }
      if (body.labels !== undefined) {
        if (!Array.isArray(body.labels) || !body.labels.every((l) => typeof l === 'string' && /^[\w:./-]{1,50}$/.test(l))) {
          return json({ error: 'Labels are short words.' }, 400);
        }
        patch.labels = body.labels as string[];
      }
      if (!(await store.get(id))) return json({ error: 'Not found.' }, 404);
      return json({ issue: await store.update(id, patch) });
    }
    return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, PATCH' });
  }

  async function attachment(req: Request, rest: string[]): Promise<Response> {
    if (!store) return new Response('Not found', { status: 404 });
    const denied = await allowed(req, 'attachment');
    if (denied) return denied;
    const path = ['attachments', ...rest.map((s) => decodeURIComponent(s))].join('/');
    const file = await store.readAttachment(path);
    if (!file) return new Response('Not found', { status: 404 });
    return new Response(file.bytes as Uint8Array<ArrayBuffer>, {
      headers: { 'content-type': file.contentType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" },
    });
  }

  return {
    journal,
    basePath,
    issuesPath,
    owns: (pathname) => under(pathname, basePath) || under(pathname, issuesPath),
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      try {
        if (under(url.pathname, issuesPath)) {
          const parts = url.pathname.slice(issuesPath.length).split('/').filter(Boolean);
          if (parts[0] === 'attachments' && parts.length > 1 && req.method === 'GET') return await attachment(req, parts.slice(1));
          return await issues(req, url, parts);
        }
        if (!under(url.pathname, basePath)) return json({ error: 'Not found.' }, 404);
        const parts = url.pathname.slice(basePath.length).split('/').filter(Boolean);
        if (parts.length === 0) {
          if (req.method === 'POST') return await submit(req);
          if (req.method === 'GET') return await status(url);
          return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, POST' });
        }
        const [head, ...rest] = parts;
        if (head === 'export' && rest.length === 0 && req.method === 'GET') return await exportIssues(req, url);
        if (head === 'mcp' && rest.length === 0 && mcp) return await mcp.handle(req);
        if (head === 'issues') return await issues(req, url, rest);
        if (head === 'attachments' && rest.length > 0 && req.method === 'GET') return await attachment(req, rest);
        return json({ error: 'Not found.' }, 404);
      } catch (err) {
        return json({ error: `The server failed: ${err instanceof Error ? err.message : 'unknown error'}` }, 500);
      }
    },
  };
}
