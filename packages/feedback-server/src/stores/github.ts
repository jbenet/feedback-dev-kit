/**
 * Files + GitHub Issues store. Each report becomes a GitHub issue (REST, via fetch) and a local
 * mirror file in the files store's format, named by the GitHub number. The issues page reads the
 * mirror, so it never spends GitHub's rate limit; sync() pulls status changes made on GitHub back.
 *
 * Idempotency. The issue body carries a hidden marker, `<!-- feedback-kit client_id: … -->`. Before
 * creating, the store looks in the mirror, then lists the repository's issues updated since the
 * report arrived (minus a skew allowance) and looks for the marker. The listing endpoint is used,
 * not search: search is eventually consistent, so an issue created a moment before a crash may not
 * be found by it, and the retry would file a duplicate.
 *
 * Pictures. Screenshots show whatever was on the reporter's screen: names, amounts, private notes.
 * An issue body is readable by everyone who can read the repository — the whole internet, for a
 * public one — and a picture uploaded to GitHub stays in its git history after the issue is closed
 * or deleted. So the default keeps pictures on your server ('local') and links to them there.
 * 'repo' uploads them to a repository you name, which must be private (checked; a public one is
 * refused and the pictures stay local). 'none' keeps them local and only counts them in the issue.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeAtomic } from '../fsutil.ts';
import {
  RetryLaterError, STATUSES,
  type FeedbackStore, type Issue, type IssueDraft, type IssueFilter, type IssuePatch, type IssuePriority, type IssueStatus,
} from '../types.ts';
import { attachmentNames, fileStore, isoNow, padId, readAttachmentFrom, rewriteTokens, serially, statusPatch, type FileStore } from './files.ts';

export type GitHubAttachments =
  /** Pictures stay on this server. With `baseUrl`, the issue links to them (behind your app's own auth). */
  | { mode: 'local'; baseUrl?: string }
  /** Uploaded to a private repository's contents under `path/<clientId>/`. */
  | { mode: 'repo'; repo: string; branch?: string; path?: string; allowPublic?: boolean }
  /** Pictures stay on this server and the issue only says how many there are. */
  | { mode: 'none' };

export interface GitHubStoreOptions {
  /** `owner/name` of the repository that gets the issues. */
  repo: string;
  /**
   * Default: FEEDBACK_GITHUB_TOKEN, then GITHUB_TOKEN. Needs issues: write (and contents: write for 'repo' pictures).
   * A function is called before each request, for tokens that rotate (a GitHub App's) or arrive later.
   */
  token?: string | (() => string | undefined);
  /** Local mirror folder (absolute, or relative to process.cwd()). */
  dir: string;
  attachments?: GitHubAttachments;
  /** Every issue gets this label, plus kind:*, priority:*, status:*. Default 'feedback'. */
  label?: string;
  /** The sentence the issues pages show for where issues go. Default names the repository and the mirror folder. */
  destination?: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  /** Longest rate-limit wait taken inline; a longer one is handed to the ingester's backoff. Default 60 s. */
  maxInlineWaitMs?: number;
  /** Spacing between content-creating requests (GitHub's secondary limits ask for about 1 s). Default 1000. */
  minWriteIntervalMs?: number;
  /** How far before the report's arrival to look for an issue already made for it. Covers skew between our clock and GitHub's. Default 10 min. */
  skewMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface GhIssue {
  number: number; html_url: string; state: 'open' | 'closed'; body?: string | null; title: string;
  labels: Array<string | { name?: string }>; updated_at: string; created_at: string; pull_request?: unknown;
}

export const marker = (clientId: string) => `<!-- feedback-kit client_id: ${clientId} -->`;
/** GitHub's issue body limit, in characters. */
const BODY_MAX = 65_536;

const labelNames = (labels: GhIssue['labels']) => labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean);

export function githubStore(options: GitHubStoreOptions): FeedbackStore & { files: FileStore; sync(): Promise<{ updated: number }> } {
  const [owner, name] = options.repo.split('/');
  if (!owner || !name) throw new Error('githubStore: repo must be "owner/name".');
  const api = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxInline = options.maxInlineWaitMs ?? 60_000;
  const minWrite = options.minWriteIntervalMs ?? 1_000;
  const skew = options.skewMs ?? 10 * 60_000;
  const baseLabel = options.label ?? 'feedback';
  const pictures: GitHubAttachments = options.attachments ?? { mode: 'local' };
  const files = fileStore({ dir: options.dir, now });
  const syncFile = join(files.root, '.github-sync.json');
  const token = () => (typeof options.token === 'function' ? options.token() : options.token)
    ?? process.env.FEEDBACK_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  let lastWrite = 0;
  let assetsPrivate: boolean | null = null;
  let warnedPublic = false;

  /** One REST call, with rate limits handled: short waits inline, long ones handed back as RetryLaterError. */
  async function gh<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; link: string | null }> {
    const auth = token();
    if (!auth) throw new Error('No GitHub token (set FEEDBACK_GITHUB_TOKEN). Reports stay journaled until one is set.');
    const writes = method !== 'GET';
    for (let attempt = 0; ; attempt += 1) {
      if (writes && minWrite > 0) {
        const wait = lastWrite + minWrite - Date.now();
        if (wait > 0) await sleep(wait);
        lastWrite = Date.now();
      }
      let res: Response;
      try {
        res = await doFetch(`${api}${path}`, {
          method,
          headers: {
            accept: 'application/vnd.github+json', authorization: `Bearer ${auth}`,
            'x-github-api-version': '2022-11-28', 'user-agent': 'feedback-kit',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        if (attempt < 2) { await sleep(1_000 * 3 ** attempt); continue; }
        throw new Error(`GitHub unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      const message = typeof (data as { message?: unknown })?.message === 'string' ? (data as { message: string }).message : '';

      const limited = res.status === 429 || (res.status === 403 && (
        res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after') || /rate limit/i.test(message)));
      if (limited) {
        const wait = rateLimitWait(res.headers);
        if (wait <= maxInline && attempt < 3) { await sleep(wait); continue; }
        throw new RetryLaterError(`GitHub rate limit: ${message || res.status}`, wait);
      }
      if (res.status >= 500 && attempt < 2) { await sleep(1_000 * 3 ** attempt); continue; }
      return { status: res.status, data: data as T, link: res.headers.get('link') };
    }
  }

  const ok = <T>(r: { status: number; data: T }, what: string): T => {
    if (r.status >= 200 && r.status < 300) return r.data;
    const message = (r.data as { message?: string } | null)?.message ?? '';
    // Every failure is retried by the ingester: a bad token or a missing repository is configuration,
    // and a report must never be dropped because of it.
    throw new Error(`GitHub ${what} failed (${r.status}${message ? `: ${message}` : ''})`);
  };

  /** An issue already made for this client id: in the mirror, or on GitHub with the marker. */
  async function findOnGitHub(clientId: string, receivedAt: string | undefined): Promise<GhIssue | null> {
    const since = new Date((Date.parse(receivedAt ?? '') || now().getTime()) - skew).toISOString();
    let next: string | null = `/repos/${owner}/${name}/issues?state=all&since=${encodeURIComponent(since)}&per_page=100`;
    for (let pages = 0; next && pages < 20; pages += 1) {
      const r: { status: number; data: GhIssue[]; link: string | null } = await gh<GhIssue[]>('GET', next);
      const hit = ok(r, 'issue listing').find((i) => !i.pull_request && (i.body ?? '').includes(marker(clientId)));
      if (hit) return hit;
      next = nextPage(r.link, api);
    }
    return null;
  }

  async function uploadable(): Promise<boolean> {
    if (pictures.mode !== 'repo') return false;
    if (pictures.allowPublic) return true;
    if (assetsPrivate === null) {
      const r = await gh<{ private?: boolean }>('GET', `/repos/${pictures.repo}`);
      assetsPrivate = ok(r, 'attachments repository lookup').private === true;
    }
    if (!assetsPrivate && !warnedPublic) {
      warnedPublic = true;
      console.warn(`[feedback] ${pictures.repo} is not private; screenshots stay on this server (set allowPublic to override).`);
    }
    return assetsPrivate;
  }

  /** Where each picture is linked from the GitHub issue, in token order; null when it is not linked. */
  async function pictureLinks(draft: IssueDraft, clientId: string, localPaths: string[]): Promise<Array<string | null>> {
    const atts = draft.attachments ?? [];
    if (atts.length === 0) return [];
    if (pictures.mode === 'repo' && await uploadable()) {
      const base = (pictures.path ?? 'feedback').replace(/^\/|\/$/g, '');
      const links: Array<string | null> = [];
      const referenced = referencedSlots(draft.body, draft.tokenOffset ?? 0);
      for (let i = 0; i < atts.length; i += 1) {
        // A dropped image the body no longer points at stays local: only what the report shows leaves.
        if (atts[i]!.kind === 'image' && !referenced.has(i)) { links.push(null); continue; }
        const file = `${base}/${clientId}/${localPaths[i]!.split('/').pop()}`;
        const put = await gh<{ content?: { html_url?: string } }>('PUT', `/repos/${pictures.repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}`, {
          message: `feedback-kit: picture for ${clientId}`,
          content: Buffer.from(atts[i]!.bytes).toString('base64'),
          ...(pictures.branch ? { branch: pictures.branch } : {}),
        });
        // 422 here means the file is already there: a retry after an upload that did land. Same bytes.
        if (put.status !== 422) ok(put, 'picture upload');
        links.push(`https://github.com/${pictures.repo}/blob/${pictures.branch ?? 'HEAD'}/${file}?raw=true`);
      }
      return links;
    }
    if (pictures.mode === 'local' && pictures.baseUrl) {
      const base = pictures.baseUrl.replace(/\/$/, '');
      return localPaths.map((p) => `${base}/${p}`);
    }
    return localPaths.map(() => null);
  }

  function issueBody(draft: IssueDraft, clientId: string, links: Array<string | null>, localPaths: string[]): string {
    const offset = draft.tokenOffset ?? 0;
    // A picture with no link becomes a note, not a broken image.
    let text = draft.body.replace(/!\[([^\]]*)\]\(attachment:(\d+)\)/g, (whole, alt: string, n: string) => {
      const i = Number(n) - 1 + offset;
      if (i < 0 || i >= localPaths.length) return whole;
      return links[i] ? `![${alt}](${links[i]})` : `*[${alt || 'image'}: kept on the server as ${localPaths[i]}]*`;
    });
    text = rewriteTokens(text, links.map((l, i) => l ?? localPaths[i]!), offset);
    const shots = (draft.attachments ?? []).map((a, i) => ({ a, i })).filter(({ a }) => a.kind === 'screenshot');
    const shotLines = shots.map(({ i }) => (links[i] ? `![Screenshot](${links[i]})` : null)).filter(Boolean);
    const kept = links.filter((l) => !l).length;
    const meta = [
      '---',
      `<sub>Reported by **${draft.reporter}** on \`${draft.page.replace(/`/g, "'")}\` · ${draft.kind} · ${draft.priority}`
        + `${kept ? ` · ${kept} picture${kept === 1 ? '' : 's'} kept on the server` : ''} · filed by feedback-kit</sub>`,
    ];
    const context = draft.context ? ['', '<details><summary>Captured context</summary>', '', '```json',
      JSON.stringify(draft.context, null, 2).replace(/```/g, '`​``'), '```', '</details>'] : [];
    const tail = ['', ...meta, ...context, '', marker(clientId)].join('\n');
    const head = [text.trim(), ...(shotLines.length ? ['', ...shotLines] : [])].join('\n');
    const room = BODY_MAX - tail.length - 200;
    const cut = head.length > room ? `${head.slice(0, room)}\n\n*…cut to fit GitHub's limit; the whole report is in the local mirror.*` : head;
    return `${cut}\n${tail}`;
  }

  /** Our labels, created once per process on first use (422: it exists already). */
  const madeLabels = new Set<string>();
  async function ensureLabels(names: string[]) {
    for (const label of names) {
      if (madeLabels.has(label)) continue;
      const r = await gh('POST', `/repos/${owner}/${name}/labels`, { name: label, color: labelColor(label) });
      if (r.status !== 422) ok(r, `label ${label}`);
      madeLabels.add(label);
    }
  }

  const labelsFor = (draft: Pick<IssueDraft, 'kind' | 'priority' | 'labels'>, status: IssueStatus = 'open') =>
    [...new Set([baseLabel, `kind:${draft.kind}`, `priority:${draft.priority}`, `status:${status}`, ...draft.labels])];

  const store = {
    kind: 'github',
    files,
    destination: options.destination ?? `GitHub issues in ${options.repo}, mirrored in ${options.dir}`,

    // Serial per mirror, so two passes cannot both miss the marker and both create.
    create: (draft: IssueDraft) => serially(files.root, async (): Promise<Issue & { repeat?: boolean }> => {
      const clientId = draft.clientId ?? randomUUID();
      const mirrored = await files.findByClientId(clientId);
      if (mirrored) return { ...mirrored, repeat: true };

      const atts = draft.attachments ?? [];
      const { paths } = attachmentNames('report', clientId, atts);
      const localDraft = { ...draft, clientId };
      const existing = await findOnGitHub(clientId, draft.receivedAt);
      if (existing) {
        // Made on GitHub before a crash; only the mirror is missing.
        const issue = await files.writeIssue(localDraft, padId(existing.number), { url: existing.html_url, attachmentPrefix: 'report', attachmentSubdir: clientId });
        return { ...issue, repeat: true };
      }

      const links = await pictureLinks(draft, clientId, paths);
      await ensureLabels(labelsFor(draft));
      const created = ok(await gh<GhIssue>('POST', `/repos/${owner}/${name}/issues`, {
        title: draft.title, body: issueBody(draft, clientId, links, paths), labels: labelsFor(draft),
      }), 'issue creation');
      return files.writeIssue(localDraft, padId(created.number), { url: created.html_url, attachmentPrefix: 'report', attachmentSubdir: clientId });
    }),

    list: (filter?: IssueFilter) => files.list(filter),
    get: (id: string) => files.get(id),

    async update(id: string, patch: IssuePatch): Promise<Issue> {
      const current = await files.get(id);
      if (!current) throw new Error(`No such issue: ${id}`);
      const number = Number(id);
      const gi = ok(await gh<GhIssue>('GET', `/repos/${owner}/${name}/issues/${number}`), 'issue lookup');
      const status = patch.status ?? current.status;
      const priority = patch.priority ?? current.priority;
      const kind = patch.kind ?? current.kind;
      // Labels someone added on GitHub stay; a labels patch replaces the free labels but never ours.
      const others = labelNames(gi.labels).filter((l) => !/^(status|priority|kind):/.test(l));
      const free = patch.labels ? [...others.filter((l) => l === baseLabel), ...patch.labels] : others;
      const managed = [`kind:${kind}`, `priority:${priority}`, `status:${status}`];
      await ensureLabels(managed);
      const labels = [...new Set([...free, ...managed])];
      ok(await gh('PATCH', `/repos/${owner}/${name}/issues/${number}`, {
        labels, state: status === 'done' ? 'closed' : 'open', ...(status === 'done' ? { state_reason: 'completed' } : {}),
      }), 'issue update');
      return files.patchFile(id, statusPatch(current, patch, now));
    },

    readAttachment: (path: string) => readAttachmentFrom(files.root, path),

    /**
     * Status back from GitHub: closed is done; open takes its status:* label, else stays as the
     * mirror has it (or becomes open, if the mirror said done — it was reopened). The cursor is
     * GitHub's own updated_at, never this server's clock, so clock skew cannot skip a change.
     */
    async sync(): Promise<{ updated: number }> {
      const cursor = (await readJson<{ since?: string }>(syncFile))?.since;
      let newest = cursor ?? '';
      let updated = 0;
      let next: string | null = `/repos/${owner}/${name}/issues?state=all&labels=${encodeURIComponent(baseLabel)}&sort=updated&direction=asc&per_page=100${cursor ? `&since=${encodeURIComponent(cursor)}` : ''}`;
      for (let pages = 0; next && pages < 50; pages += 1) {
        const r: { status: number; data: GhIssue[]; link: string | null } = await gh<GhIssue[]>('GET', next);
        const list = ok(r, 'sync listing');
        next = nextPage(r.link, api);
        for (const gi of list) {
          if (gi.pull_request) continue;
          if (gi.updated_at > newest) newest = gi.updated_at;
          const local = await files.get(padId(gi.number));
          if (!local) continue;
          const names = labelNames(gi.labels);
          const labelled = names.map((l) => /^status:(.+)$/.exec(l)?.[1]).find((s): s is IssueStatus => (STATUSES as readonly string[]).includes(s ?? ''));
          const status: IssueStatus = gi.state === 'closed' ? 'done' : labelled ?? (local.status === 'done' ? 'open' : local.status);
          const priority = (names.map((l) => /^priority:(P[0-3])$/.exec(l)?.[1]).find(Boolean) ?? local.priority) as IssuePriority;
          const kind = (names.map((l) => /^kind:(bug|request|question|chore)$/.exec(l)?.[1]).find(Boolean) ?? local.kind) as Issue['kind'];
          if (status !== local.status || priority !== local.priority || kind !== local.kind || gi.title !== local.title) {
            await files.patchFile(local.id, { ...statusPatch(local, { status, priority, kind }, now), title: gi.title });
            updated += 1;
          }
        }
      }
      if (newest && newest !== cursor) await writeAtomic(files.root, '.github-sync.json', JSON.stringify({ since: newest, at: isoNow(now) }));
      return { updated };
    },
  };
  return store;
}

/** Which attachment slots the body's `attachment:N` tokens point at. */
function referencedSlots(body: string, offset: number): Set<number> {
  const out = new Set<number>();
  for (const m of body.matchAll(/\(attachment:(\d+)\)/g)) out.add(Number(m[1]) - 1 + offset);
  return out;
}

/** The `rel="next"` URL from GitHub's Link header, as a path on the API. */
function nextPage(link: string | null, api: string): string | null {
  const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
  if (!m) return null;
  return m[1]!.startsWith(api) ? m[1]!.slice(api.length) : null;
}

const labelColor = (label: string) =>
  label.startsWith('priority:P0') ? 'b60205' : label.startsWith('priority:') ? 'd93f0b'
    : label.startsWith('status:') ? '0e8a16' : label.startsWith('kind:') ? '1d76db' : 'ededed';

/**
 * How long GitHub asked us to wait. `retry-after` wins; else the reset time, measured against
 * GitHub's own Date header so a skewed local clock neither spins nor sleeps for hours; else a minute
 * (GitHub's advice for secondary limits). Clamped to 1 s – 15 min.
 */
export function rateLimitWait(headers: Headers): number {
  const retryAfter = Number(headers.get('retry-after'));
  let wait: number;
  if (Number.isFinite(retryAfter) && retryAfter > 0) wait = retryAfter * 1_000;
  else if (headers.get('x-ratelimit-remaining') === '0' && headers.get('x-ratelimit-reset')) {
    const serverNow = Date.parse(headers.get('date') ?? '') || Date.now();
    wait = Number(headers.get('x-ratelimit-reset')) * 1_000 - serverNow + 1_000;
  } else wait = 60_000;
  return Math.min(15 * 60_000, Math.max(1_000, Number.isFinite(wait) ? wait : 60_000));
}
