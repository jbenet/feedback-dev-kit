import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeedbackHandler } from '../src/handlers.ts';
import { createJournal } from '../src/journal.ts';
import { createIngester } from '../src/ingest.ts';
import { fileStore } from '../src/stores/files.ts';
import { JPEG, PNG, get, id, post, silent, tempDir, wire } from './helpers.ts';

async function setup(t: { after(fn: () => unknown): void }, extra: Parameters<typeof createFeedbackHandler>[0] extends infer O ? Partial<O> : never = {}) {
  const root = await tempDir(t);
  const journal = createJournal(join(root, 'inbox'));
  const store = fileStore(join(root, 'issues'));
  const handler = createFeedbackHandler({
    journal, store, resolveReporter: (req) => req.headers.get('x-test-user'), onJournaled: () => undefined, ...extra,
  });
  const ingester = createIngester({ journal, store, generateTitle: null, logger: silent });
  return { root, journal, store, handler, ingester };
}

test('POST journals a report, answers 202 with the client id, and a resend is a repeat', async (t) => {
  const { handler, journal, ingester } = await setup(t);
  const body = wire({ screenshots: [PNG], images: [{ name: 'chart.png', dataUrl: PNG }], imageOffset: 1 });
  const res = await handler.handle(post(body, { headers: { 'x-test-user': 'ada' } }));
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { journaled: true, clientId: body.clientId, repeat: false });
  const entry = await journal.read(body.clientId as string);
  assert.ok(entry?.ok);
  assert.equal(entry.entry.reporter, 'ada');
  assert.equal(entry.entry.request.attachments.length, 2);

  const again = await handler.handle(post(body));
  assert.deepEqual(await again.json(), { journaled: true, clientId: body.clientId, repeat: true });

  await ingester.runOnce();
  const filed = await handler.handle(post(body));
  assert.deepEqual(await filed.json(), { journaled: true, clientId: body.clientId, repeat: true, id: '0001' });
  const status = await handler.handle(get(`/api/feedback?clientId=${body.clientId}`));
  const st = await status.json();
  assert.equal(st.state, 'filed');
  assert.equal(st.id, '0001');
  assert.match(st.location, /^0001-the-totals-row-on-the-invented-orders-page-count\.md$/);
});

test('the reporter comes from the session, never from the body, and server-only context keys are dropped', async (t) => {
  const { handler, journal } = await setup(t);
  const body = wire({ reporter: 'mallory', context: { user: 'mallory', reporterVerification: 'verified', journaledAt: '1999', route: '/x' } });
  await handler.handle(post(body, { headers: { 'x-test-user': 'ada' } }));
  const r = await journal.read(body.clientId as string);
  assert.ok(r?.ok);
  assert.equal(r.entry.reporter, 'ada');
  assert.deepEqual(r.entry.request.context, { route: '/x' });
  // A session lookup that throws never costs the report.
  const { handler: h2, journal: j2 } = await setup(t, { resolveReporter: () => { throw new Error('session store down'); } });
  const b2 = wire();
  assert.equal((await h2.handle(post(b2))).status, 202);
  assert.equal(((await j2.read(b2.clientId as string)) as { entry: { reporter: unknown } }).entry.reporter, null);
});

test('refusals: malformed id, bad JSON, no words, wrong picture types — with the right status and nothing written', async (t) => {
  const { handler, root } = await setup(t);
  const cases: Array<[unknown, number]> = [
    [wire({ clientId: '../../etc/passwd' }), 400],
    ['{"body": "cut off', 400],
    ['[1,2]', 400],
    [wire({ body: '   \\\n ' }), 400],
    [wire({ screenshots: [JPEG] }), 400],
    [wire({ images: [{ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }] }), 400],
    [wire({ images: [{ dataUrl: 'data:text/html;base64,PGgxPg==' }] }), 400],
  ];
  for (const [body, status] of cases) {
    const res = await handler.handle(post(body));
    assert.equal(res.status, status, JSON.stringify(body).slice(0, 80));
    assert.equal(typeof (await res.json()).error, 'string');
  }
  assert.deepEqual((await readdir(join(root, 'inbox')).catch(() => [])).filter((n) => n.endsWith('.json')), []);
});

test('size limits: the request, one picture, all pictures, their count, the body — 413 before anything is written', async (t) => {
  const { handler, root } = await setup(t, {
    limits: { maxRequestBytes: 5_000, maxImageBase64: 1_000, maxTotalBase64: 1_500, maxAttachments: 3, maxBodyChars: 500 },
  });
  const pic = (n: number) => `data:image/png;base64,${'A'.repeat(n)}`;
  const cases: Array<[Record<string, unknown> | string, number]> = [
    [wire({ body: `Invented. ${'x'.repeat(6_000)}` }), 413],
    [wire({ screenshots: [pic(1_200)] }), 413],
    [wire({ screenshots: [pic(800), pic(800)] }), 413],
    [wire({ images: Array.from({ length: 4 }, () => ({ dataUrl: PNG })) }), 413],
    [wire({ body: `Invented. ${'x'.repeat(600)}` }), 413],
  ];
  for (const [body, status] of cases) assert.equal((await handler.handle(post(body))).status, status);
  // A declared length over the limit is refused without reading the body.
  const declared = post(wire(), { headers: { 'content-length': '999999' } });
  assert.equal((await handler.handle(declared)).status, 413);
  assert.deepEqual((await readdir(join(root, 'inbox')).catch(() => [])).filter((n) => n.endsWith('.json')), []);
});

test('origin: same origin passes; missing, cross-site and sibling origins are refused; an allow-list admits', async (t) => {
  const { handler } = await setup(t);
  assert.equal((await handler.handle(post(wire()))).status, 202);
  assert.equal((await handler.handle(post(wire(), { origin: null }))).status, 403);
  assert.equal((await handler.handle(post(wire(), { origin: 'http://evil.test' }))).status, 403);
  assert.equal((await handler.handle(post(wire(), { origin: 'http://app.test:8080' }))).status, 403);
  assert.equal((await handler.handle(post(wire(), { origin: 'https://app.test' }))).status, 403);
  assert.equal((await handler.handle(post(wire(), { headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403);
  // Forwarded-host is not trusted.
  assert.equal((await handler.handle(post(wire(), { origin: 'http://evil.test', headers: { 'x-forwarded-host': 'evil.test' } }))).status, 403);
  const { handler: proxied } = await setup(t, { origin: { allowed: ['https://app.test'] } });
  assert.equal((await proxied.handle(post(wire(), { origin: 'https://app.test' }))).status, 202);
});

test('a server that does not file answers 403 with a sentence; the rate limit answers 429 but resends stay free', async (t) => {
  const { handler } = await setup(t, { accept: false, refusalMessage: 'This is a development copy; the live server files.' });
  const res = await handler.handle(post(wire()));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /development copy/);

  const { handler: limited } = await setup(t, { rateLimit: { perMinute: 2 } });
  const first = wire();
  const user = { 'x-test-user': 'ada' };
  assert.equal((await limited.handle(post(first, { headers: user }))).status, 202);
  assert.equal((await limited.handle(post(wire(), { headers: user }))).status, 202);
  const third = await limited.handle(post(wire(), { headers: user }));
  assert.equal(third.status, 429);
  assert.equal(third.headers.get('retry-after'), '60');
  assert.equal((await limited.handle(post(first, { headers: user }))).status, 202);
  assert.equal((await limited.handle(post(wire(), { headers: { 'x-test-user': 'grace' } }))).status, 202);
});

test('credentials in the captured URL and filters are removed before journaling', async (t) => {
  const { handler, journal } = await setup(t);
  const body = wire({ context: { url: 'http://app.test/login?next=/x&token=abc123&api_key=k#access_token=z', filters: { stage: 'a', code: 'oauth-code' } } });
  await handler.handle(post(body));
  const r = await journal.read(body.clientId as string);
  assert.ok(r?.ok);
  const ctx = r.entry.request.context as { url: string; filters: Record<string, string> };
  assert.doesNotMatch(ctx.url, /abc123|=k\b|access_token=z/);
  assert.match(ctx.url, /next=%2Fx/);
  assert.deepEqual(ctx.filters, { stage: 'a', code: '[removed]' });
});

test('export: 404 without a token, 401 on a wrong one, 400 on a bad since, filed issues after since', async (t) => {
  const { handler: off } = await setup(t, { exportToken: undefined });
  const saved = process.env.FEEDBACK_EXPORT_TOKEN;
  delete process.env.FEEDBACK_EXPORT_TOKEN;
  assert.equal((await off.handle(get('/api/feedback/export?since=2026-01-01T00:00:00Z'))).status, 404);
  if (saved !== undefined) process.env.FEEDBACK_EXPORT_TOKEN = saved;

  const { handler, ingester } = await setup(t, { exportToken: 'invented-token' });
  await handler.handle(post(wire()));
  await ingester.runOnce();
  const auth = { authorization: 'Bearer invented-token' };
  assert.equal((await handler.handle(get('/api/feedback/export?since=2026-01-01T00:00:00Z', { authorization: 'Bearer nope' }))).status, 401);
  assert.equal((await handler.handle(get('/api/feedback/export?since=2026-01-01T00:00:00Z'))).status, 401);
  assert.equal((await handler.handle(get('/api/feedback/export?since=yesterday', auth))).status, 400);
  assert.equal((await handler.handle(get('/api/feedback/export?since=2026-01-01T00:00:00', auth))).status, 400);
  const res = await handler.handle(get('/api/feedback/export?since=2000-01-01T00:00:00Z', auth));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await res.json()).items.length, 1);
  const later = await handler.handle(get(`/api/feedback/export?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, auth));
  assert.equal((await later.json()).items.length, 0);
});

test('issues: list, detail, PATCH and pictures under /api/issues and /api/feedback/issues; traversal is 404', async (t) => {
  const { handler, ingester } = await setup(t);
  await handler.handle(post(wire({ screenshots: [PNG] })));
  await handler.handle(post(wire({ body: 'A second invented request.', kind: 'request', priority: 'P1' })));
  await ingester.runOnce();

  for (const base of ['/api/issues', '/api/feedback/issues']) {
    const list = await (await handler.handle(get(base))).json();
    assert.equal(list.issues.length, 2);
    assert.equal(typeof list.destination, 'string');
    const filtered = await (await handler.handle(get(`${base}?kind=request&priority=P1,P0`))).json();
    assert.deepEqual(filtered.issues.map((i: { id: string }) => i.id), ['0002']);
    const q = await (await handler.handle(get(`${base}?q=TOTALS`))).json();
    assert.deepEqual(q.issues.map((i: { id: string }) => i.id), ['0001']);
    const one = await (await handler.handle(get(`${base}/0001`))).json();
    assert.equal(one.issue.screenshots[0], 'attachments/0001-screenshot.png');
    assert.equal((await handler.handle(get(`${base}/9999`))).status, 404);
  }
  for (const path of ['/api/issues/attachments/0001-screenshot.png', '/api/feedback/attachments/0001-screenshot.png']) {
    const pic = await handler.handle(get(path));
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get('content-type'), 'image/png');
    assert.equal(pic.headers.get('x-content-type-options'), 'nosniff');
  }
  for (const path of ['/api/issues/attachments/..%2F0001-the-totals.md', '/api/issues/attachments/%2E%2E/%2E%2E/etc/passwd', '/api/issues/attachments/x.svg']) {
    assert.equal((await handler.handle(get(path))).status, 404, path);
  }

  const patch = (body: unknown, origin = 'http://app.test') => new Request('http://app.test/api/issues/0001', {
    method: 'PATCH', headers: { host: 'app.test', origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await handler.handle(patch({ status: 'done' }, 'http://evil.test'))).status, 403);
  assert.equal((await handler.handle(patch({ status: 'shipped' }))).status, 400);
  const done = await (await handler.handle(patch({ status: 'done', kind: 'chore', priority: 'P3' }))).json();
  assert.equal(done.issue.status, 'done');
  assert.equal(done.issue.kind, 'chore');
  assert.ok(done.issue.closedAt);
  const reopened = await (await handler.handle(patch({ status: 'open' }))).json();
  assert.equal(reopened.issue.closedAt, null);
});

test('authorize guards reads, updates and pictures', async (t) => {
  const { handler } = await setup(t, { authorize: (req) => req.headers.get('x-test-user') === 'ada' });
  assert.equal((await handler.handle(get('/api/issues'))).status, 403);
  assert.equal((await handler.handle(get('/api/issues', { 'x-test-user': 'ada' }))).status, 200);
  assert.equal((await handler.handle(get('/api/issues/attachments/0001-screenshot.png'))).status, 403);
});

test('the POST route loads nothing that opens or waits on a store or database', () => {
  // Capital OS keeps this as a property: the journal must answer while the database is busy.
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const seen = new Set<string>();
  const todo = [join(src, 'handlers.ts')];
  const packages = new Set<string>();
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
      const spec = m[1]!;
      if (spec.startsWith('.')) {
        const next = join(dirname(f), spec);
        if (existsSync(next)) todo.push(next);
      } else packages.add(spec);
    }
  }
  const files = [...seen].map((f) => relative(src, f));
  assert.deepEqual(files.filter((f) => f.startsWith('stores')), []);
  assert.deepEqual([...packages].filter((p) => !p.startsWith('node:')), []);
});

void id;
