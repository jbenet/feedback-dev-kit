import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJournal, type Journal } from '../src/journal.ts';
import { createIngester, startIngester, stopIngesters, ingesterFor } from '../src/ingest.ts';
import { fileStore } from '../src/stores/files.ts';
import { checkReport } from '../src/validate.ts';
import { RefusedError, RetryLaterError, type FeedbackStore, type IssueDraft } from '../src/types.ts';
import { PNG, id, silent, tempDir, wire } from './helpers.ts';

async function journalWith(journal: Journal, n: number, overrides: Record<string, unknown> = {}) {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = checkReport(wire({ body: `Invented report number ${i + 1} about the orders page.`, ...overrides }));
    assert.ok(r.ok);
    const clientId = id();
    await journal.write({ clientId, reporter: 'ada', report: r.value });
    ids.push(clientId);
  }
  return ids;
}

/** A store that fails on demand, around a real files store. */
function flaky(inner: FeedbackStore, fail: (draft: IssueDraft, call: number) => Error | null) {
  let calls = 0;
  const drafts: IssueDraft[] = [];
  const store: FeedbackStore = {
    ...inner,
    kind: 'flaky',
    destination: inner.destination,
    async create(draft) {
      calls += 1;
      drafts.push(draft);
      const err = fail(draft, calls);
      if (err) throw err;
      return inner.create(draft);
    },
    list: (f) => inner.list(f), get: (i) => inner.get(i), update: (i, p) => inner.update(i, p), readAttachment: (p) => inner.readAttachment(p),
  };
  return { store, drafts, calls: () => calls };
}

test('each journaled report is filed once, in arrival order, and moves to filed/ with its pictures handed over', async (t) => {
  const root = await tempDir(t);
  const journal = createJournal(join(root, 'inbox'));
  const store = fileStore(join(root, 'issues'));
  const ids = await journalWith(journal, 3, { screenshots: [PNG], images: [{ name: 'x.png', dataUrl: PNG }], imageOffset: 1, body: 'See ![x](attachment:1) on the invented page.' });
  const ingester = createIngester({ journal, store, generateTitle: null, logger: silent });
  const result = await ingester.runOnce();
  assert.deepEqual(result, { filed: 3, refused: 0, failed: 0, waiting: 0 });
  const issues = await store.list();
  assert.deepEqual(issues.map((i) => i.id).sort(), ['0001', '0002', '0003']);
  assert.equal((await store.get('0001'))?.clientId, ids[0]);
  const first = (await store.get('0001'))!;
  assert.deepEqual(first.attachments, ['attachments/0001-screenshot.png', 'attachments/0001-image-1.png']);
  assert.match(first.body, /\(attachments\/0001-image-1\.png\)/);
  assert.equal(first.context?.reporter, 'ada');
  assert.equal(first.context?.reporterVerification, 'session');
  assert.ok(first.context?.journaledAt);
  for (const clientId of ids) assert.equal((await journal.status(clientId))?.state, 'filed');
  assert.deepEqual(await readdir(join(root, 'inbox', 'files')), []);
});

test('a crash between the store write and the journal move files nothing twice', async (t) => {
  const root = await tempDir(t);
  const journal = createJournal(join(root, 'inbox'));
  const store = fileStore(join(root, 'issues'));
  const [clientId] = await journalWith(journal, 1);
  const saved = await readFile(join(root, 'inbox', `${clientId}.json`), 'utf8');
  const ingester = createIngester({ journal, store, generateTitle: null, logger: silent });
  await ingester.runOnce();
  // As if the server died after the issue was written but before the entry left the inbox.
  await writeFile(join(root, 'inbox', `${clientId}.json`), saved);
  const second = await ingester.runOnce();
  assert.equal(second.filed, 1);
  assert.equal((await store.list()).length, 1);
  assert.equal((await journal.status(clientId!))?.state, 'filed');
});

test('a failure stays journaled and is retried with backoff; a rate limit pauses the pass', async (t) => {
  const root = await tempDir(t);
  const journal = createJournal(join(root, 'inbox'));
  const inner = fileStore(join(root, 'issues'));
  const [a, b] = await journalWith(journal, 2);
  let now = 0;
  let failing = true;
  const { store, calls } = flaky(inner, () => (failing ? new Error('invented disk error') : null));
  const warnings: string[] = [];
  const ingester = createIngester({
    journal, store, generateTitle: null, clock: () => now, backoff: (n) => n * 1000, logger: { warn: (m: string) => warnings.push(m), info: () => undefined },
  });
  const first = await ingester.runOnce();
  assert.deepEqual(first, { filed: 0, refused: 0, failed: 2, waiting: 2 });
  // Not due yet: nothing is tried.
  await ingester.runOnce();
  assert.equal(calls(), 2);
  now = 1_000;
  await ingester.runOnce();
  assert.equal(calls(), 4);
  assert.equal(ingester.retries().find((r) => r.clientId === a)?.attempts, 2);
  // Logged once per entry and message, not on every pass.
  assert.equal(warnings.length, 2);
  failing = false;
  now = 10_000;
  const recovered = await ingester.runOnce();
  assert.equal(recovered.filed, 2);
  assert.equal((await journal.status(b!))?.state, 'filed');

  // A rate limit: the entry waits at least as long as asked, and the rest of the pass waits too.
  const [c, d] = await journalWith(journal, 2);
  const limited = flaky(inner, (_d, call) => (call === 1 ? new RetryLaterError('invented rate limit', 60_000) : null));
  const ing2 = createIngester({ journal, store: limited.store, generateTitle: null, clock: () => now, logger: silent });
  const r1 = await ing2.runOnce();
  assert.equal(r1.failed, 1);
  assert.equal(limited.calls(), 1);
  now += 30_000;
  await ing2.runOnce();
  assert.equal(limited.calls(), 1);
  now += 31_000;
  await ing2.runOnce();
  assert.equal((await journal.status(c!))?.state, 'filed');
  assert.equal((await journal.status(d!))?.state, 'filed');
});

test('a refusal moves the entry to refused/ with the reason; an unreadable entry is set aside, not retried', async (t) => {
  const root = await tempDir(t);
  const journal = createJournal(join(root, 'inbox'));
  const [a] = await journalWith(journal, 1);
  const { store } = flaky(fileStore(join(root, 'issues')), () => new RefusedError('Invented: the page is gone.'));
  const ingester = createIngester({ journal, store, generateTitle: null, logger: silent });
  const bad = id();
  await mkdir(join(root, 'inbox'), { recursive: true });
  await writeFile(join(root, 'inbox', `${bad}.json`), 'not json at all');
  const r = await ingester.runOnce();
  assert.equal(r.refused, 2);
  assert.deepEqual(await journal.status(a!), { state: 'refused', reason: 'Invented: the page is gone.' });
  assert.equal((await journal.status(bad))?.state, 'refused');
});

test('identify: a failed lookup keeps the report journaled; null files it as unknown', async (t) => {
  const root = await tempDir(t);
  const journal = createJournal(join(root, 'inbox'));
  const store = fileStore(join(root, 'issues'));
  const [a] = await journalWith(journal, 1);
  let db: 'down' | 'up' | 'empty' = 'down';
  const identify = async (selector: string | null) => {
    if (db === 'down') throw new Error('invented: database busy');
    if (db === 'empty') return null;
    return { handle: `${selector}-verified`, verification: 'verified' };
  };
  const ingester = createIngester({ journal, store, identify, generateTitle: null, backoff: () => 0, logger: silent });
  assert.equal((await ingester.runOnce()).failed, 1);
  assert.equal((await journal.status(a!))?.state, 'journaled');
  db = 'up';
  await ingester.runOnce();
  assert.equal((await store.get('0001'))?.reporter, 'ada-verified');
  db = 'empty';
  await journalWith(journal, 1);
  await ingester.runOnce();
  const unknown = (await store.get('0002'))!;
  assert.equal(unknown.reporter, 'unknown');
  assert.equal(unknown.context?.reporterVerification, 'no user resolved');
});

test('titles: generated once and kept across retries, sanitized, and the first sentence when the model fails or is slow', async (t) => {
  const root = await tempDir(t);
  const journal = createJournal(join(root, 'inbox'));
  const inner = fileStore(join(root, 'issues'));
  let generated = 0;
  let fail = true;
  const { store, drafts } = flaky(inner, () => (fail ? new Error('invented') : null));
  const ingester = createIngester({
    journal, store, backoff: () => 0, logger: silent,
    generateTitle: async (input) => { generated += 1; return `"Totals row double-counts returned loaves on ${input.page}."\nextra line`; },
  });
  await journalWith(journal, 1);
  await ingester.runOnce();
  fail = false;
  await ingester.runOnce();
  assert.equal(generated, 1);
  assert.equal(drafts.at(-1)!.title, 'Totals row double-counts returned loaves on /orders');

  const throwing = createIngester({ journal, store: inner, logger: silent, generateTitle: async () => { throw new Error('model down'); } });
  await journalWith(journal, 1, { body: 'Export button does nothing. Clicked it twice on the invented page.' });
  await throwing.runOnce();
  assert.equal((await inner.get('0002'))?.title, 'Export button does nothing');

  const slow = createIngester({
    journal, store: inner, logger: silent, titleTimeoutMs: 50,
    generateTitle: (_i, signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  await journalWith(journal, 1, { body: 'Search box loses focus while typing.' });
  const started = Date.now();
  await slow.runOnce();
  assert.ok(Date.now() - started < 2_000);
  assert.equal((await inner.get('0003'))?.title, 'Search box loses focus while typing');

  // A title the sender typed is kept as given; the model is not asked.
  let asked = false;
  const given = createIngester({ journal, store: inner, logger: silent, generateTitle: async () => { asked = true; return 'x'; } });
  await journalWith(journal, 1, { title: 'Agent-filed: nightly import failed' });
  await given.runOnce();
  assert.equal(asked, false);
  assert.equal((await inner.get('0004'))?.title, 'Agent-filed: nightly import failed');

  // No sentence to take (journaled by other means than the route, which refuses a report with no
  // words): the first line with a letter in it, an image's name included, and only then "Untitled".
  const bare = createIngester({ journal, store: inner, logger: silent, generateTitle: null });
  const base = checkReport(wire());
  assert.ok(base.ok);
  await journal.write({ clientId: id(), reporter: 'ada', report: { ...base.value, body: '![oven-temperatures.png](attachment:1)' } });
  await bare.runOnce();
  assert.equal((await inner.get('0005'))?.title, 'oven-temperatures.png');
  await journal.write({ clientId: id(), reporter: 'ada', report: { ...base.value, body: '---' } });
  await bare.runOnce();
  assert.equal((await inner.get('0006'))?.title, 'Untitled');
});

test('one pass at a time: a kick during a pass runs one more; startIngester is once per journal', async (t) => {
  const root = await tempDir(t);
  const journal = createJournal(join(root, 'inbox'));
  const inner = fileStore(join(root, 'issues'));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let concurrent = 0;
  let maxConcurrent = 0;
  const store: FeedbackStore = {
    ...inner, kind: 'gated', destination: 'test',
    async create(d) { concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent); await gate; concurrent -= 1; return inner.create(d); },
    list: (f) => inner.list(f), get: (i) => inner.get(i), update: (i, p) => inner.update(i, p), readAttachment: (p) => inner.readAttachment(p),
  };
  await journalWith(journal, 1);
  const ingester = createIngester({ journal, store, generateTitle: null, logger: silent });
  const running = ingester.runOnce();
  await journalWith(journal, 1);
  const same = ingester.runOnce();
  assert.equal(same, running);
  release();
  await running;
  assert.equal(maxConcurrent, 1);
  assert.equal((await inner.list()).length, 2);

  t.after(() => stopIngesters());
  const a = startIngester({ journal: join(root, 'other'), store: inner, generateTitle: null, logger: silent, everyMs: 0 });
  const b = startIngester({ journal: join(root, 'other'), store: inner, generateTitle: null, logger: silent, everyMs: 0 });
  assert.equal(a, b);
  assert.equal(ingesterFor(join(root, 'other')), a);
});
