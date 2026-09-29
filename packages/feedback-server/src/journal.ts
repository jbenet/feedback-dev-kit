/**
 * The journal: every report is written to disk before the request is answered, and filed later.
 *
 * Why (Capital OS, 27 Sep 2026): the server was pegged by an import and "can't submit feedback";
 * then "it should journal to the server. the page may die or close forever". So the route checks the
 * report, writes it here as one file, and answers 202 at once. Filing — the issue number, the database
 * row, the GitHub issue, the title — happens afterwards, off the request (ingest.ts).
 *
 *   <dir>/<clientId>.json                   journaled, not yet filed
 *   <dir>/files/<clientId>.<nonce>/N-kind.ext  its pictures, decoded, beside it
 *   <dir>/filed/<clientId>.json             filed: the issue id and where it went, without pictures
 *   <dir>/refused/<clientId>.json           can never be filed, kept whole with the reason
 *   <dir>/refused/files/…                   the refused entry's pictures
 *
 * Crash safety. The pictures are written and fsynced first, into a folder no entry names yet; the
 * entry is then written to a temporary, fsynced, and hard-linked into place (the commit), and the
 * folder is fsynced. A crash at any point leaves either no entry (the client resends; a stray
 * folder or temporary is swept later) or a complete entry whose pictures are all on disk. Readers
 * skip dot-files, so a half-written temporary is never taken for a report.
 *
 * Idempotency. The client id is the file name. A resend of an id that is journaled, filed or
 * refused writes nothing and says which; concurrent sends of one id in this process share one
 * write, and across processes the hard link lets exactly one win.
 *
 * Database-free on purpose. Nothing here imports a database, auth or a framework: the request that
 * writes the journal must never wait on them, because they are exactly what is busy when a report
 * matters most.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createAtomic, exists, readJson, syncDir, writeAtomic } from './fsutil.ts';
import { isClientId } from './validate.ts';
import type {
  CheckedReport, FiledRecord, ImageType, IssueAttachment, JournalEntry, JournaledAttachment, JournalStatus,
} from './types.ts';

const EXT: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export type JournalWriteResult =
  | { already: null; filed: null }
  | { already: 'journaled'; filed: null }
  | { already: 'filed'; filed: FiledRecord }
  | { already: 'refused'; filed: null; reason: string };

export type JournalRead =
  | { ok: true; entry: JournalEntry }
  | { ok: false; reason: string };

export interface Journal {
  readonly dir: string;
  /** Journal one report. Answers once it is on disk; a known client id writes nothing. */
  write(input: { clientId: string; reporter: string | null; report: CheckedReport }): Promise<JournalWriteResult>;
  status(clientId: string): Promise<JournalStatus | null>;
  /** Client ids waiting to be filed, oldest first (server receive time, then id). */
  pending(): Promise<string[]>;
  read(clientId: string): Promise<JournalRead | null>;
  /** The entry's pictures, in token order. `missing` counts any that are gone from disk. */
  attachments(entry: JournalEntry): Promise<{ attachments: IssueAttachment[]; missing: number }>;
  /** Filed: the record goes to filed/ first, then the entry leaves. A crash between is a resend the store dedupes. */
  markFiled(entry: JournalEntry, issue: { id: string | null; location: string | null; title: string }): Promise<FiledRecord>;
  /** Can never be filed: kept whole in refused/ with the reason, rather than retried forever. */
  markRefused(clientId: string, reason: string, entry?: JournalEntry | null): Promise<void>;
  /** Remove picture folders no entry names and stray temporaries, older than `olderThanMs`. */
  sweep(olderThanMs?: number): Promise<{ removed: number }>;
}

export interface JournalOptions {
  /** Server clock, for receivedAt. Injected in tests. */
  now?: () => Date;
}

/** One write per client id at a time, shared across module copies (Next can load a module twice in one process). */
const inflight = ((globalThis as typeof globalThis & { __feedbackKitJournalWrites?: Map<string, Promise<JournalWriteResult>> })
  .__feedbackKitJournalWrites ??= new Map<string, Promise<JournalWriteResult>>());

/** GUESS: long enough that no write in progress is this old; short enough that crash debris does not linger. */
export const SWEEP_AFTER_MS = 60 * 60 * 1000;

export function createJournal(dir: string, options: JournalOptions = {}): Journal {
  const now = options.now ?? (() => new Date());
  const filedDir = join(dir, 'filed');
  const refusedDir = join(dir, 'refused');
  const filesDir = join(dir, 'files');
  const entryPath = (id: string) => join(dir, `${id}.json`);

  const readFiled = (id: string) => readJson<FiledRecord>(join(filedDir, `${id}.json`));
  const readRefused = (id: string) => readJson<{ reason?: string }>(join(refusedDir, `${id}.json`));

  async function known(id: string): Promise<JournalWriteResult | null> {
    const filed = await readFiled(id);
    if (filed) return { already: 'filed', filed };
    if (await exists(entryPath(id))) return { already: 'journaled', filed: null };
    const refused = await readRefused(id);
    if (refused) return { already: 'refused', filed: null, reason: refused.reason ?? 'refused' };
    return null;
  }

  async function writeNew(input: { clientId: string; reporter: string | null; report: CheckedReport }): Promise<JournalWriteResult> {
    const { clientId, report } = input;
    const seen = await known(clientId);
    if (seen) return seen;

    // Pictures first, into a folder of their own that no entry names until the commit below.
    const folder = `${clientId}.${randomBytes(4).toString('hex')}`;
    const saved: JournaledAttachment[] = [];
    if (report.attachments.length > 0) {
      const abs = join(filesDir, folder);
      await mkdir(abs, { recursive: true });
      let n = 0;
      for (const a of report.attachments) {
        n += 1;
        const bytes = Buffer.from(a.base64, 'base64');
        const name = `${n}-${a.kind}.${EXT[a.contentType]}`;
        const fh = await open(join(abs, name), 'wx');
        try {
          await fh.writeFile(bytes);
          await fh.sync();
        } finally {
          await fh.close();
        }
        saved.push({
          kind: a.kind, contentType: a.contentType, file: `files/${folder}/${name}`, bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), ...(a.name ? { name: a.name } : {}),
        });
      }
      await syncDir(abs);
      await syncDir(filesDir);
    }

    const { attachments: _pictures, ...rest } = report;
    const entry: JournalEntry = {
      v: 1, clientId, receivedAt: now().toISOString(), reporter: input.reporter,
      request: { ...rest, attachments: saved },
    };
    const won = await createAtomic(dir, `${clientId}.json`, JSON.stringify(entry));
    if (!won) {
      // Another process committed this id a moment ago. Its entry stands; ours leaves no trace.
      if (saved.length > 0) await rm(join(filesDir, folder), { recursive: true, force: true });
      return (await known(clientId)) ?? { already: 'journaled', filed: null };
    }
    return { already: null, filed: null };
  }

  const journal: Journal = {
    dir,

    write(input) {
      if (!isClientId(input.clientId)) return Promise.reject(new Error('The client id is malformed.'));
      const key = `${dir}\0${input.clientId}`;
      const running = inflight.get(key);
      // A concurrent resend of the same id waits for the first write and gets its answer, as a repeat.
      if (running) return running.then((r) => (r.already === null ? { already: 'journaled', filed: null } : r));
      const work = writeNew(input);
      inflight.set(key, work);
      void work.finally(() => { if (inflight.get(key) === work) inflight.delete(key); }).catch(() => undefined);
      return work;
    },

    async status(clientId) {
      if (!isClientId(clientId)) return null;
      const filed = await readFiled(clientId);
      if (filed) return { state: 'filed', issueId: filed.issueId, location: filed.location };
      if (await exists(entryPath(clientId))) return { state: 'journaled' };
      const refused = await readRefused(clientId);
      if (refused) return { state: 'refused', reason: refused.reason ?? 'refused' };
      return null;
    },

    async pending() {
      let names: string[];
      try { names = await readdir(dir); } catch { return []; }
      const ids = names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).map((n) => n.slice(0, -5)).filter(isClientId);
      const stamped = await Promise.all(ids.map(async (id) => {
        const r = await journal.read(id);
        return { id, at: r?.ok ? r.entry.receivedAt : '' };
      }));
      // Server time, then id. Never the client's clock: a phone set to 2019 must not jump the queue.
      return stamped.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).map((s) => s.id);
    },

    async read(clientId) {
      if (!isClientId(clientId)) return null;
      let text: string;
      try { text = await readFile(entryPath(clientId), 'utf8'); } catch { return null; }
      try {
        const entry = JSON.parse(text) as JournalEntry;
        if (entry?.clientId !== clientId || !entry.request || typeof entry.request.body !== 'string') {
          return { ok: false, reason: 'The journal entry is not a report.' };
        }
        return { ok: true, entry };
      } catch {
        // Atomic writes make this impossible short of disk damage or a hand edit. Kept, never guessed at.
        return { ok: false, reason: 'The journal entry is unreadable (not JSON).' };
      }
    },

    async attachments(entry) {
      const out: IssueAttachment[] = [];
      let missing = 0;
      for (const a of entry.request.attachments) {
        try {
          const bytes = await readFile(join(dir, a.file));
          out.push({ kind: a.kind, contentType: a.contentType, bytes: new Uint8Array(bytes), ...(a.name ? { name: a.name } : {}) });
        } catch {
          missing += 1;
        }
      }
      return { attachments: out, missing };
    },

    async markFiled(entry, issue) {
      const record: FiledRecord = {
        clientId: entry.clientId, issueId: issue.id, location: issue.location, title: issue.title,
        receivedAt: entry.receivedAt, filedAt: now().toISOString(),
      };
      await writeAtomic(filedDir, `${entry.clientId}.json`, JSON.stringify(record));
      await rm(entryPath(entry.clientId), { force: true });
      await syncDir(dir);
      // The store has its own copy of every picture now.
      for (const folder of new Set(entry.request.attachments.map((a) => a.file.split('/').slice(0, 2).join('/')))) {
        await rm(join(dir, folder), { recursive: true, force: true });
      }
      return record;
    },

    async markRefused(clientId, reason, entry) {
      if (!isClientId(clientId)) return;
      let kept: unknown = entry ?? null;
      if (entry) {
        // The pictures move with it, so the refused record is whole.
        const moved: JournaledAttachment[] = [];
        for (const a of entry.request.attachments) {
          const folder = a.file.split('/').slice(0, 2).join('/');
          if (await exists(join(dir, folder))) {
            await mkdir(join(refusedDir, 'files'), { recursive: true });
            await rename(join(dir, folder), join(refusedDir, folder)).catch(() => undefined);
          }
          moved.push(a);
        }
        kept = { ...entry, request: { ...entry.request, attachments: moved } };
      } else {
        try { kept = await readFile(entryPath(clientId), 'utf8'); } catch { kept = null; }
      }
      await writeAtomic(refusedDir, `${clientId}.json`, JSON.stringify({ clientId, entry: kept, reason, refusedAt: now().toISOString() }));
      await rm(entryPath(clientId), { force: true });
      await syncDir(dir);
    },

    async sweep(olderThanMs = SWEEP_AFTER_MS) {
      let removed = 0;
      const cutoff = Date.now() - olderThanMs;
      const old = async (p: string) => { try { return (await stat(p)).mtimeMs < cutoff; } catch { return false; } };
      // Temporaries a crash left behind.
      const temporaries = async (d: string) => {
        let names: string[] = [];
        try { names = await readdir(d); } catch { return; }
        for (const n of names) {
          if (n.startsWith('.') && n.endsWith('.tmp') && await old(join(d, n))) {
            await rm(join(d, n), { force: true });
            removed += 1;
          }
        }
      };
      await temporaries(dir);
      await temporaries(filedDir);
      await temporaries(refusedDir);
      // Picture folders no pending entry names: a crash before the commit, or a lost race.
      let folders: string[] = [];
      try { folders = await readdir(filesDir); } catch { folders = []; }
      if (folders.length > 0) {
        const named = new Set<string>();
        for (const id of await journal.pending()) {
          const r = await journal.read(id);
          if (r?.ok) for (const a of r.entry.request.attachments) named.add(a.file.split('/')[1]!);
        }
        for (const f of folders) {
          if (named.has(f) || !(await old(join(filesDir, f)))) continue;
          await rm(join(filesDir, f), { recursive: true, force: true });
          removed += 1;
        }
      }
      return { removed };
    },
  };
  return journal;
}
