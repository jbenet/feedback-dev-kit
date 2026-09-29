/**
 * Files + SQL store. The database numbers issues and dedupes client ids (a unique constraint, so
 * several ingesters can share one database safely); the markdown files and pictures are still
 * written, in the files store's format, so the issues folder reads the same either way.
 *
 * Order, for crash safety: one transaction inserts the row (number taken under a table lock,
 * files_written = false); then the pictures and the markdown are written; then files_written = true.
 * A crash after the commit leaves a row whose files are missing; the retry finds the row by client
 * id, sees files_written = false, and writes them. The journal keeps the pictures until the store
 * says it filed, so they are always there to write.
 */
import type { FeedbackStore, Issue, IssueDraft, IssueFilter, IssuePatch, IssueStatus } from '../types.ts';
import { fileStore, filterIssues, isoNow, padId, readAttachmentFrom, statusPatch, type FileStore } from './files.ts';
import { slugify } from './format.ts';
import type { SqlDriver } from './sql-drivers.ts';

export { pgDriver, sqliteDriver, type SqlDriver, type SqliteLike, type PgQueryable, type PgPoolLike } from './sql-drivers.ts';

export interface Migration { id: string; sqlite: string; postgres: string }

/** Applied in order, once each, recorded in feedback_migrations. Never edit one that has shipped; add another. */
export const MIGRATIONS: Migration[] = [
  {
    id: '0001_feedback_issue',
    sqlite: `
      CREATE TABLE feedback_issue (
        number        INTEGER PRIMARY KEY,
        id            TEXT NOT NULL UNIQUE,
        client_id     TEXT UNIQUE,
        title         TEXT NOT NULL,
        body          TEXT NOT NULL,
        kind          TEXT NOT NULL,
        priority      TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'open',
        reporter      TEXT NOT NULL,
        page          TEXT NOT NULL,
        labels        TEXT NOT NULL DEFAULT '[]',
        context       TEXT,
        screenshots   TEXT NOT NULL DEFAULT '[]',
        attachments   TEXT NOT NULL DEFAULT '[]',
        location      TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        closed_at     TEXT,
        updated_at    TEXT NOT NULL,
        files_written INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX feedback_issue_status ON feedback_issue (status, priority);
      CREATE INDEX feedback_issue_created ON feedback_issue (created_at);`,
    postgres: `
      CREATE TABLE feedback_issue (
        number        integer PRIMARY KEY,
        id            text NOT NULL UNIQUE,
        client_id     text UNIQUE,
        title         text NOT NULL,
        body          text NOT NULL,
        kind          text NOT NULL CHECK (kind IN ('bug','request','question','chore')),
        priority      text NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
        status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','triaged','agent-ready','in-progress','done')),
        reporter      text NOT NULL,
        page          text NOT NULL,
        labels        jsonb NOT NULL DEFAULT '[]',
        context       jsonb,
        screenshots   jsonb NOT NULL DEFAULT '[]',
        attachments   jsonb NOT NULL DEFAULT '[]',
        location      text NOT NULL,
        created_at    timestamptz NOT NULL,
        closed_at     timestamptz,
        updated_at    timestamptz NOT NULL,
        files_written boolean NOT NULL DEFAULT false
      );
      CREATE INDEX feedback_issue_status ON feedback_issue (status, priority);
      CREATE INDEX feedback_issue_created ON feedback_issue (created_at);`,
  },
];

/** Apply pending migrations, each in its own transaction. Safe to call on every start. */
export async function migrate(db: SqlDriver): Promise<string[]> {
  await db.exec(db.dialect === 'postgres'
    ? 'CREATE TABLE IF NOT EXISTS feedback_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    : "CREATE TABLE IF NOT EXISTS feedback_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    const did = await db.transaction(async (tx) => {
      // Two processes starting at once: the lock makes the second wait and then see the row.
      if (tx.dialect === 'postgres') await tx.exec('LOCK TABLE feedback_migrations IN EXCLUSIVE MODE');
      const seen = await tx.query('SELECT id FROM feedback_migrations WHERE id = $1', [m.id]);
      if (seen.length > 0) return false;
      await tx.exec(tx.dialect === 'postgres' ? m.postgres : m.sqlite);
      await tx.query('INSERT INTO feedback_migrations (id) VALUES ($1)', [m.id]);
      return true;
    });
    if (did) applied.push(m.id);
  }
  return applied;
}

interface Row {
  number: number; id: string; client_id: string | null; title: string; body: string; kind: string; priority: string;
  status: string; reporter: string; page: string; labels: unknown; context: unknown; screenshots: unknown; attachments: unknown;
  location: string; created_at: unknown; closed_at: unknown; files_written: unknown;
}

const json = <T>(v: unknown, d: T): T => {
  if (v === null || v === undefined) return d;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return d; } }
  return v as T;
};
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' && v ? new Date(v).toISOString() : null);
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 't';

export interface SqlStoreOptions {
  db: SqlDriver;
  /** The issues folder for markdown and pictures (absolute, or relative to process.cwd()). */
  dir: string;
  /** Run migrations on first use. Default true. */
  autoMigrate?: boolean;
  destination?: string;
  now?: () => Date;
}

export function sqlStore(options: SqlStoreOptions): FeedbackStore & { files: FileStore; migrate(): Promise<string[]> } {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const files = fileStore({ dir: options.dir, now });
  let ready: Promise<unknown> | null = null;
  const init = () => (ready ??= options.autoMigrate === false ? Promise.resolve() : migrate(db).catch((err) => { ready = null; throw err; }));
  const jsonParam = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

  const toIssue = (r: Row): Issue => {
    const context = json<Record<string, unknown> | null>(r.context, null);
    return {
      id: r.id, title: r.title, status: r.status as IssueStatus, kind: r.kind as Issue['kind'], priority: r.priority as Issue['priority'],
      reporter: r.reporter, page: r.page, labels: json<string[]>(r.labels, []), body: r.body, context,
      created: iso(r.created_at) ?? '', closedAt: iso(r.closed_at), location: r.location,
      screenshots: json<string[]>(r.screenshots, []), attachments: json<string[]>(r.attachments, []),
      clientId: r.client_id, fixedIn: null,
    };
  };

  /** Pictures and markdown for a row, then the flag. Idempotent: every write replaces atomically. */
  async function writeFiles(row: Row, draft: IssueDraft): Promise<Issue> {
    // The row's words win over the draft's: a retry after a restart may carry a freshly generated title.
    const written = await files.writeIssue(
      { ...draft, title: row.title, body: row.body, reporter: row.reporter, page: row.page },
      row.id, { created: iso(row.created_at) ?? undefined },
    );
    await db.query(
      `UPDATE feedback_issue SET files_written = $1, screenshots = $2, attachments = $3, body = $4, updated_at = $5 WHERE number = $6`,
      [true, JSON.stringify(written.screenshots), JSON.stringify(written.attachments), written.body, isoNow(now), row.number],
    );
    return { ...toIssue(row), body: written.body, screenshots: written.screenshots, attachments: written.attachments };
  }

  return {
    kind: 'sql',
    files,
    destination: options.destination ?? `${db.dialect === 'postgres' ? 'Postgres' : 'SQLite'} table feedback_issue, with ${options.dir}/NNNN-slug.md`,
    migrate: () => migrate(db),

    async create(draft) {
      await init();
      const { row, repeat } = await db.transaction(async (tx) => {
        if (tx.dialect === 'postgres') await tx.exec('LOCK TABLE feedback_issue IN SHARE ROW EXCLUSIVE MODE');
        if (draft.clientId) {
          const hit = await tx.query<Row>('SELECT * FROM feedback_issue WHERE client_id = $1', [draft.clientId]);
          if (hit[0]) return { row: hit[0], repeat: true };
        }
        const [{ next } = { next: 1 }] = await tx.query<{ next: number | string }>('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM feedback_issue');
        const number = Number(next);
        const id = padId(number);
        const at = isoNow(now);
        const inserted = await tx.query<Row>(
          `INSERT INTO feedback_issue (number, id, client_id, title, body, kind, priority, status, reporter, page, labels, context,
             screenshots, attachments, location, created_at, updated_at, files_written)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $11, '[]', '[]', $12, $13, $13, $14) RETURNING *`,
          [number, id, draft.clientId ?? null, draft.title, draft.body, draft.kind, draft.priority, draft.reporter, draft.page,
            JSON.stringify(draft.labels), jsonParam(draft.context), `${id}-${slugify(draft.title)}.md`, at, false],
        );
        return { row: inserted[0]!, repeat: false };
      });
      if (!truthy(row.files_written)) {
        // A new row, or one whose files a crash never wrote: write them now.
        return { ...(await writeFiles(row, draft)), ...(repeat ? { repeat: true } : {}) };
      }
      return { ...toIssue(row), repeat: true };
    },

    async list(filter?: IssueFilter) {
      await init();
      const where: string[] = [];
      const params: unknown[] = [];
      const inList = (col: string, values?: string[]) => {
        if (!values?.length) return;
        where.push(`${col} IN (${values.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`);
      };
      inList('status', filter?.status);
      inList('kind', filter?.kind);
      inList('priority', filter?.priority);
      const rows = await db.query<Row>(
        `SELECT * FROM feedback_issue ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY number DESC`, params);
      // Text search in JS: the same semantics on both databases, and the list is small.
      return filterIssues(rows.map(toIssue), filter?.q ? { q: filter.q } : undefined);
    },

    async get(id) {
      await init();
      const rows = await db.query<Row>('SELECT * FROM feedback_issue WHERE id = $1', [id]);
      return rows[0] ? toIssue(rows[0]) : null;
    },

    async update(id, patch: IssuePatch) {
      await init();
      const current = await db.query<Row>('SELECT * FROM feedback_issue WHERE id = $1', [id]);
      if (!current[0]) throw new Error(`No such issue: ${id}`);
      const p = statusPatch({ status: current[0].status }, patch, now);
      const rows = await db.query<Row>(
        `UPDATE feedback_issue SET status = COALESCE($1, status), priority = COALESCE($2, priority), labels = COALESCE($3, labels),
           closed_at = CASE WHEN $4 THEN $5 ELSE closed_at END, updated_at = $6, kind = COALESCE($8, kind) WHERE id = $7 RETURNING *`,
        [p.status ?? null, p.priority ?? null, p.labels ? JSON.stringify(p.labels) : null,
          'closedAt' in p, p.closedAt ?? null, isoNow(now), id, p.kind ?? null],
      );
      // The markdown follows, keeping every line the store does not manage. A missing file is not an error: the row is the record.
      await files.patchFile(id, p).catch(() => undefined);
      return toIssue(rows[0]!);
    },

    readAttachment: (path) => readAttachmentFrom(files.root, path),
  };
}
