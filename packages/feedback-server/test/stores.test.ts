import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileStore } from '../src/stores/files.ts';
import { parseIssue, serializeIssue } from '../src/stores/format.ts';
import { sqlStore, migrate, sqliteDriver, pgDriver, type SqlDriver } from '../src/stores/sql.ts';
import type { FeedbackStore, IssueDraft } from '../src/types.ts';
import { PNG_B64, id, tempDir } from './helpers.ts';

const png = () => new Uint8Array(Buffer.from(PNG_B64, 'base64'));
const draft = (overrides: Partial<IssueDraft> = {}): IssueDraft => ({
  title: 'Totals row double-counts returned loaves', body: 'Invented. See ![chart](attachment:1).',
  kind: 'bug', priority: 'P2', reporter: 'ada', page: '/orders', labels: [], context: { route: '/orders' },
  attachments: [{ kind: 'screenshot', contentType: 'image/png', bytes: png() }, { kind: 'image', contentType: 'image/png', bytes: png(), name: 'chart.png' }],
  tokenOffset: 1, clientId: id(), ...overrides,
});

/** The behaviour every store owes: numbering, dedupe, pictures, updates. */
async function contract(store: FeedbackStore) {
  const a = draft();
  const first = await store.create(a);
  assert.equal(first.id, '0001');
  assert.equal(first.repeat, undefined);
  assert.deepEqual(first.screenshots, ['attachments/0001-screenshot.png']);
  assert.deepEqual(first.attachments, ['attachments/0001-screenshot.png', 'attachments/0001-image-1.png']);
  assert.match(first.body, /!\[chart\]\(attachments\/0001-image-1\.png\)/);
  const again = await store.create({ ...a, title: 'A resend with another title' });
  assert.equal(again.id, '0001');
  assert.equal(again.repeat, true);

  // Concurrent creates never share a number; concurrent resends never make a second issue.
  const same = draft();
  const many = await Promise.all([...Array.from({ length: 6 }, () => store.create(draft({ attachments: [] }))), store.create(same), store.create(same)]);
  assert.equal(new Set(many.map((i) => i.id)).size, 7);
  assert.equal((await store.list()).length, 8);

  const pic = await store.readAttachment('attachments/0001-screenshot.png');
  assert.equal(pic?.contentType, 'image/png');
  assert.equal(await store.readAttachment('../secret.png'), null);
  assert.equal(await store.readAttachment('attachments/../../x.png'), null);
  assert.equal(await store.readAttachment('attachments/0001-screenshot.svg'), null);

  const done = await store.update('0001', { status: 'done', priority: 'P1', kind: 'request' });
  assert.equal(done.status, 'done');
  assert.equal(done.priority, 'P1');
  assert.equal(done.kind, 'request');
  assert.ok(done.closedAt);
  assert.equal((await store.update('0001', { status: 'triaged' })).closedAt, null);
  assert.deepEqual((await store.list({ status: ['triaged'] })).map((i) => i.id), ['0001']);
  assert.deepEqual((await store.list({ q: 'TOTALS', kind: ['request'] })).map((i) => i.id), ['0001']);
  assert.equal((await store.get('0001'))?.clientId, a.clientId);
  assert.equal(await store.get('9999'), null);
}

test('files store: the PL LabOS tools format, numbering, dedupe, pictures and updates', async (t) => {
  const dir = await tempDir(t);
  const store = fileStore(dir);
  await contract(store);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  assert.equal(names[0], '0001-totals-row-double-counts-returned-loaves.md');
  const text = await readFile(join(dir, names[0]!), 'utf8');
  assert.match(text, /^---\nid: "0001"\ntitle: Totals row double-counts returned loaves\nstatus: triaged {7}# open/);
  assert.match(text, /\nclient_id: [0-9a-f-]{36}\n/);
  assert.match(text, /```json context\n\{\n {2}"route": "\/orders"\n\}\n```/);
});

test('frontmatter: unmanaged lines survive a status change; review reads as done; a second rewrite changes nothing', async (t) => {
  const dir = await tempDir(t);
  const file = [
    '---', 'id: "0042"', 'title: "Fix: the \\"rail\\" overlaps"', 'status: review        # open | …', 'kind: bug', 'priority: P1',
    'reporter: ada', 'page: /today', 'created: 2026-09-01T10:00:00Z', 'labels: [ui, rail]',
    'screenshot: attachments/0042-screenshot.png', 'assignee: grace', 'branch: fix/rail', 'client_id: 0f8c1a2e-invented', '---', '',
    '**Done (N30).** The rail no longer overlaps.', '', '![Screenshot](attachments/0042-screenshot.png)', '',
  ].join('\n');
  await writeFile(join(dir, '0042-fix-the-rail.md'), file);
  const store = fileStore(dir);
  const before = await store.get('0042');
  assert.equal(before?.status, 'done');
  assert.equal(before?.title, 'Fix: the "rail" overlaps');
  assert.equal(before?.fixedIn, 'N30');
  assert.deepEqual(before?.screenshots, ['attachments/0042-screenshot.png']);
  assert.equal(before?.clientId, '0f8c1a2e-invented');
  await store.update('0042', { status: 'in-progress' });
  const text = await readFile(join(dir, '0042-fix-the-rail.md'), 'utf8');
  assert.match(text, /\nassignee: grace\nbranch: fix\/rail\nclient_id: 0f8c1a2e-invented\n---/);
  const parsed = parseIssue(text, '0042');
  assert.equal(serializeIssue(parseIssue(serializeIssue(parsed), '0042')), serializeIssue(parsed));
  assert.equal(parsed.title, 'Fix: the "rail" overlaps');
});

async function sqlSuite(t: { after(fn: () => unknown): void }, db: SqlDriver) {
  const dir = await tempDir(t);
  assert.deepEqual(await migrate(db), ['0001_feedback_issue']);
  assert.deepEqual(await migrate(db), []);
  const store = sqlStore({ db, dir });
  await contract(store);
  // The markdown is written too, in the files format.
  assert.ok((await readdir(dir)).includes('0001-totals-row-double-counts-returned-loaves.md'));
  const fromFile = await store.files.get('0001');
  assert.equal(fromFile?.status, 'triaged');

  // A crash after the row committed but before its files: the retry writes them, once.
  const d = draft();
  const made = await store.create(d);
  await db.query('UPDATE feedback_issue SET files_written = $1 WHERE id = $2', [false, made.id]);
  await rm(join(dir, made.location));
  await rm(join(dir, 'attachments', `${made.id}-screenshot.png`));
  const retried = await store.create({ ...d, title: 'A regenerated title that must not win' });
  assert.equal(retried.id, made.id);
  assert.equal(retried.repeat, true);
  assert.ok((await readdir(dir)).includes(made.location));
  assert.equal((await store.files.get(made.id))?.title, made.title);
  assert.ok(await store.readAttachment(`attachments/${made.id}-screenshot.png`));
  const rows = await db.query<{ n: number | string }>('SELECT COUNT(*) AS n FROM feedback_issue');
  assert.equal(Number(rows[0]!.n), 9);
}

test('SQL store on SQLite (better-sqlite3)', async (t) => {
  const { default: Database } = await import('better-sqlite3');
  const raw = new Database(':memory:');
  t.after(() => raw.close());
  await sqlSuite(t, sqliteDriver(raw));
});

test('SQL store on SQLite (node:sqlite)', async (t) => {
  let DatabaseSync: (new (p: string) => { prepare(s: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown }; exec(s: string): void; close(): void }) | undefined;
  try { ({ DatabaseSync } = await import('node:sqlite') as never); } catch { /* older Node */ }
  if (!DatabaseSync) return t.skip('node:sqlite is not available');
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  await sqlSuite(t, sqliteDriver(raw));
});

test('SQL store on Postgres semantics (PGlite)', async (t) => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  t.after(() => pg.close());
  await sqlSuite(t, pgDriver(pg));
});

test('SQL store on a real Postgres (PG_TEST_URL, a throwaway database)', async (t) => {
  const url = process.env.PG_TEST_URL;
  if (!url) return t.skip('set PG_TEST_URL to run against a real Postgres');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url });
  t.after(() => pool.end());
  await pool.query('DROP TABLE IF EXISTS feedback_issue; DROP TABLE IF EXISTS feedback_migrations');
  await sqlSuite(t, pgDriver(pool));
});
