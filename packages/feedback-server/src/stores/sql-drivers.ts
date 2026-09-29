/**
 * Two tiny adapters that give the SQL store one async interface over SQLite and Postgres. The store
 * writes Postgres-style `$1` placeholders; the SQLite adapter rewrites them. Neither driver is
 * imported here: you pass your own connection, so the package has no hard dependency on either.
 */

export interface SqlDriver {
  readonly dialect: 'sqlite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Run `work` in one transaction. SQLite takes the write lock at BEGIN (IMMEDIATE). */
  transaction<T>(work: (tx: SqlDriver) => Promise<T>): Promise<T>;
}

/** The part of better-sqlite3's Database (or node:sqlite's DatabaseSync) this uses. */
export interface SqliteLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): unknown;
}

/** `$1 … $n` to `?`, with the parameters reordered to match (a `$n` may repeat). */
function positional(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  const ordered: unknown[] = [];
  const out = sql.replace(/\$(\d+)/g, (_m, n: string) => {
    ordered.push(params[Number(n) - 1]);
    return '?';
  });
  return { sql: out, params: ordered };
}

/** SQLite has no booleans or dates: store 1/0 and ISO strings. */
const sqliteValue = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v === undefined ? null : v);

/** A serial queue: one SQLite connection runs one transaction at a time, and nothing interleaves with it. */
function queue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * better-sqlite3 (`new Database(path)`) or node:sqlite (`new DatabaseSync(path)`). Turn on WAL for a
 * file database: `db.pragma('journal_mode = WAL')` / `db.exec('PRAGMA journal_mode = WAL')`.
 */
export function sqliteDriver(db: SqliteLike): SqlDriver {
  const serial = queue();
  const direct = (): SqlDriver => ({
    dialect: 'sqlite',
    async query<T>(sql: string, params: unknown[] = []) {
      const p = positional(sql, params);
      const stmt = db.prepare(p.sql);
      const values = p.params.map(sqliteValue);
      // A statement that returns no rows cannot be .all()'d in better-sqlite3.
      if (/^\s*(select|with|pragma)\b/i.test(p.sql) || /\breturning\b/i.test(p.sql)) return stmt.all(...values) as T[];
      stmt.run(...values);
      return [] as T[];
    },
    async exec(sql: string) { db.exec(sql); },
    transaction: (work) => work(direct()),
  });
  const inner = direct();
  return {
    dialect: 'sqlite',
    query: (sql, params) => serial(() => inner.query(sql, params)),
    exec: (sql) => serial(() => inner.exec(sql)),
    transaction: (work) => serial(async () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = await work(inner);
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    }),
  };
}

/** The part of pg's Pool / Client (or PGlite) this uses. */
export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  /** PGlite: several statements in one call (its query() takes one). pg runs them through query(). */
  exec?(sql: string): Promise<unknown>;
}
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgQueryable & { release(err?: unknown): void }>;
}

/**
 * pg's Pool (preferred: a transaction takes its own client) or one Client / PGlite (transactions are
 * then serialized in this process, since one connection can hold one transaction).
 */
export function pgDriver(db: PgQueryable | PgPoolLike): SqlDriver {
  const serial = queue();
  const pooled = typeof (db as PgPoolLike).connect === 'function' && typeof (db as { release?: unknown }).release !== 'function'
    // pg.Client also has connect(), but it opens the connection rather than lending one; tell them apart.
    && (db as { totalCount?: unknown }).totalCount !== undefined;
  const on = (conn: PgQueryable): SqlDriver => ({
    dialect: 'postgres',
    async query<T>(sql: string, params: unknown[] = []) { return (await conn.query(sql, params)).rows as T[]; },
    async exec(sql: string) { if (typeof conn.exec === 'function') await conn.exec(sql); else await conn.query(sql); },
    transaction: (work) => work(on(conn)),
  });
  const base = on(db);
  const single = (work: () => Promise<unknown>) => serial(work);
  return {
    dialect: 'postgres',
    query: (sql, params) => (pooled ? base.query(sql, params) : single(() => base.query(sql, params)) as never),
    exec: (sql) => (pooled ? base.exec(sql) : single(() => base.exec(sql)) as Promise<void>),
    async transaction<T>(work: (tx: SqlDriver) => Promise<T>): Promise<T> {
      const run = async (conn: PgQueryable) => {
        await conn.query('BEGIN');
        try {
          const out = await work(on(conn));
          await conn.query('COMMIT');
          return out;
        } catch (err) {
          await conn.query('ROLLBACK').catch(() => undefined);
          throw err;
        }
      };
      if (!pooled) return single(() => run(db)) as Promise<T>;
      const client = await (db as PgPoolLike).connect();
      try { return await run(client); } finally { client.release(); }
    },
  };
}
