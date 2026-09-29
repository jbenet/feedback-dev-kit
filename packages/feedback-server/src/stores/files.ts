/**
 * Files-only store: the Capital OS format. Each issue is `<dir>/NNNN-slug.md` with frontmatter, its
 * pictures in `<dir>/attachments/`. The complaint and its fix can travel in one pull request, and
 * `git log issues/` is free triage history.
 *
 * Numbering reads the folder, so creates run one at a time per folder, in this process. Only one
 * process may file into a folder (run one ingester); two would take the same number. The SQL and
 * GitHub stores do not have this limit.
 */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { writeAtomic } from '../fsutil.ts';
import type {
  FeedbackStore, ImageType, Issue, IssueAttachment, IssueDraft, IssueFilter, IssuePatch,
} from '../types.ts';
import { parseIssue, serializeIssue, slugify, type ParsedIssue } from './format.ts';

const FILE = /^(\d{4,})-([a-z0-9-]+)\.md$/;
export const ATTACHMENTS = 'attachments';
export const EXT: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const TYPE_OF: Record<string, ImageType> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** One create at a time per folder, shared across module copies in one process. */
const creating = ((globalThis as typeof globalThis & { __feedbackKitIssueCreates?: Map<string, Promise<unknown>> })
  .__feedbackKitIssueCreates ??= new Map<string, Promise<unknown>>());
export function serially<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (creating.get(key) ?? Promise.resolve()).then(work);
  creating.set(key, result.catch(() => undefined));
  return result;
}

export const padId = (n: number) => String(n).padStart(4, '0');

/** Seconds are not enough: two issues filed in one second must still sort and export apart. */
export const isoNow = (now: () => Date) => now().toISOString();

export interface FileStoreOptions {
  /** The issues folder. Absolute, or relative to process.cwd(). */
  dir: string;
  /** Shown in the UI. */
  destination?: string;
  now?: () => Date;
}

export interface FileStore extends FeedbackStore {
  readonly root: string;
  findByClientId(clientId: string): Promise<Issue | null>;
  /**
   * Write one issue under a given id: its pictures (named `<prefix>-screenshot.png`, `<prefix>-image-1.jpg`
   * under `attachments/<subdir>`), then the markdown, each atomically. The primitive the other stores reuse.
   */
  writeIssue(draft: IssueDraft, id: string, options?: { extra?: string[]; attachmentPrefix?: string; attachmentSubdir?: string; created?: string; url?: string | null }): Promise<Issue>;
  /** Replace the fields a store manages on an existing file, keeping every line it does not. */
  patchFile(id: string, patch: Partial<ParsedIssue>): Promise<Issue>;
}

export function fileStore(options: FileStoreOptions | string): FileStore {
  const opts = typeof options === 'string' ? { dir: options } : options;
  const root = isAbsolute(opts.dir) ? opts.dir : join(process.cwd(), opts.dir);
  const now = opts.now ?? (() => new Date());

  const read = async (): Promise<Array<{ file: string; issue: ParsedIssue }>> => {
    let names: string[];
    try { names = await readdir(root); } catch { return []; }
    const out: Array<{ file: string; issue: ParsedIssue }> = [];
    for (const name of names.sort()) {
      const m = FILE.exec(name);
      if (!m) continue;
      try {
        out.push({ file: name, issue: parseIssue(await readFile(join(root, name), 'utf8'), m[1]!) });
      } catch { /* vanished between readdir and read */ }
    }
    return out;
  };

  const urlOf = (p: ParsedIssue) => p.extra?.map((l) => /^url:\s*(\S+)/.exec(l)?.[1]).find(Boolean) ?? null;

  const toIssue = (file: string, p: ParsedIssue): Issue => ({
    id: p.id, title: p.title, status: p.status, kind: p.kind, priority: p.priority,
    reporter: p.reporter, page: p.page, labels: p.labels, body: p.body, context: p.context,
    created: p.created, closedAt: p.closedAt ?? null, location: urlOf(p) ?? file,
    screenshots: p.screenshots, attachments: p.attachments, fixedIn: p.fixedIn,
    clientId: p.clientId ?? null, url: urlOf(p),
  });

  const find = async (id: string) => (await read()).find((r) => r.issue.id === id) ?? null;

  async function saveAttachments(prefix: string, subdir: string | undefined, incoming: IssueAttachment[]) {
    const names = attachmentNames(prefix, subdir, incoming);
    if (incoming.length === 0) return names;
    const rel = subdir ? `${ATTACHMENTS}/${subdir}` : ATTACHMENTS;
    const abs = join(root, ...rel.split('/'));
    await mkdir(abs, { recursive: true });
    for (let i = 0; i < incoming.length; i += 1) {
      await writeAtomic(abs, names.paths[i]!.slice(rel.length + 1), incoming[i]!.bytes);
    }
    return names;
  }

  const store: FileStore = {
    kind: 'files',
    root,
    destination: opts.destination ?? `${opts.dir}/NNNN-slug.md`,

    async findByClientId(clientId) {
      const hit = (await read()).find((r) => r.issue.clientId === clientId);
      return hit ? toIssue(hit.file, hit.issue) : null;
    },

    async writeIssue(draft, id, o = {}) {
      const { paths, screenshots } = await saveAttachments(o.attachmentPrefix ?? id, o.attachmentSubdir, draft.attachments ?? []);
      const extra = [
        ...(o.url ? [`url: ${o.url}`] : []),
        ...(draft.clientId ? [`client_id: ${draft.clientId}`] : []),
        ...(o.extra ?? []),
      ];
      const parsed: ParsedIssue = {
        id, title: draft.title, status: 'open', kind: draft.kind, priority: draft.priority,
        reporter: draft.reporter, page: draft.page, labels: draft.labels, context: draft.context,
        body: rewriteTokens(draft.body, paths, draft.tokenOffset ?? 0),
        screenshots, attachments: paths, fixedIn: null, created: o.created ?? isoNow(now),
        clientId: draft.clientId ?? null, extra,
      };
      const file = `${id}-${slugify(draft.title)}.md`;
      await writeAtomic(root, file, serializeIssue(parsed));
      return toIssue(file, parsed);
    },

    async patchFile(id, patch) {
      const hit = await find(id);
      if (!hit) throw new Error(`No such issue: ${id}`);
      const updated: ParsedIssue = { ...hit.issue, ...patch };
      await writeAtomic(root, hit.file, serializeIssue(updated));
      return toIssue(hit.file, updated);
    },

    create: (draft) => serially(root, async () => {
      const existing = await read();
      // A resend: the issue this report already made, not a second one.
      const already = draft.clientId ? existing.find((r) => r.issue.clientId === draft.clientId) : undefined;
      if (already) return { ...toIssue(already.file, already.issue), repeat: true };
      const next = padId(existing.reduce((max, r) => Math.max(max, Number(r.issue.id) || 0), 0) + 1);
      return store.writeIssue(draft, next);
    }),

    async list(filter?: IssueFilter) {
      return filterIssues((await read()).map((r) => toIssue(r.file, r.issue)), filter)
        .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    },

    async get(id) {
      const hit = await find(id);
      return hit ? toIssue(hit.file, hit.issue) : null;
    },

    update: (id, patch) => serially(root, async () => {
      const hit = await find(id);
      if (!hit) throw new Error(`No such issue: ${id}`);
      return store.patchFile(id, statusPatch(hit.issue, patch, now));
    }),

    readAttachment: (path) => readAttachmentFrom(root, path),
  };
  return store;
}

/**
 * The names a store gives an issue's pictures, relative to the issues folder, in token order.
 * Images are numbered among images, so `0008-image-1.png` is the first one somebody dropped.
 */
export function attachmentNames(prefix: string, subdir: string | undefined, incoming: Array<Pick<IssueAttachment, 'kind' | 'contentType'>>) {
  const rel = subdir ? `${ATTACHMENTS}/${subdir}` : ATTACHMENTS;
  const paths: string[] = [];
  const screenshots: string[] = [];
  let imageNo = 0;
  let shotNo = 0;
  for (const a of incoming) {
    const name = a.kind === 'screenshot'
      ? `${prefix}-screenshot${(shotNo += 1) === 1 ? '' : `-${shotNo}`}.${EXT[a.contentType]}`
      : `${prefix}-image-${(imageNo += 1)}.${EXT[a.contentType]}`;
    paths.push(`${rel}/${name}`);
    if (a.kind === 'screenshot') screenshots.push(`${rel}/${name}`);
  }
  return { paths, screenshots };
}

/** The body's `(attachment:N)` tokens, rewritten to where the store put the pictures. Only the store names files. */
export const rewriteTokens = (body: string, targets: string[], offset: number) =>
  body.replace(/\(attachment:(\d+)\)/g, (whole, n: string) => {
    const hit = targets[Number(n) - 1 + offset];
    return hit ? `(${hit})` : whole;
  });

/** A status change records or clears closed_at. */
export function statusPatch(current: { status: string }, patch: IssuePatch, now: () => Date): Partial<ParsedIssue> {
  const out: Partial<ParsedIssue> = { ...patch };
  if (patch.status && patch.status !== current.status) out.closedAt = patch.status === 'done' ? isoNow(now) : null;
  return out;
}

export function filterIssues(all: Issue[], filter?: IssueFilter): Issue[] {
  const q = filter?.q?.trim().toLowerCase();
  return all.filter((i) =>
    (!filter?.status?.length || filter.status.includes(i.status))
    && (!filter?.kind?.length || filter.kind.includes(i.kind))
    && (!filter?.priority?.length || filter.priority.includes(i.priority))
    && (!q || [i.title, i.body, i.reporter, i.page, i.id].some((s) => s.toLowerCase().includes(q))));
}

/**
 * A picture filed with an issue, by its path under the issues folder. The path is normalised and
 * re-rooted; only `attachments/…` with one of the four image extensions is served, so a traversal
 * cannot walk out and nothing here is ever executed.
 */
export async function readAttachmentFrom(root: string, path: string): Promise<{ bytes: Uint8Array; contentType: ImageType } | null> {
  if (typeof path !== 'string' || path.includes('\0') || isAbsolute(path)) return null;
  const rel = normalize(path).split(sep).join('/');
  if (rel.startsWith('..') || !rel.startsWith(`${ATTACHMENTS}/`) || rel.split('/').includes('..')) return null;
  const ext = /\.([a-z]+)$/i.exec(rel)?.[1]?.toLowerCase();
  const contentType = ext ? TYPE_OF[ext] : undefined;
  if (!contentType) return null;
  try {
    return { bytes: new Uint8Array(await readFile(join(root, ...rel.split('/')))), contentType };
  } catch {
    return null;
  }
}
