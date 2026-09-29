import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { githubStore, rateLimitWait, marker } from '../src/stores/github.ts';
import { RetryLaterError, type IssueDraft } from '../src/types.ts';
import { PNG_B64, id, tempDir } from './helpers.ts';

const png = () => new Uint8Array(Buffer.from(PNG_B64, 'base64'));

interface FakeIssue { number: number; title: string; body: string; labels: Array<{ name: string }>; state: 'open' | 'closed'; html_url: string; updated_at: string; created_at: string }

/** An invented GitHub: issues, labels, contents and repository privacy, with a request log. */
function fakeGitHub(opts: { assetsPrivate?: boolean } = {}) {
  const issues: FakeIssue[] = [];
  const labels = new Set<string>();
  const contents = new Map<string, string>();
  const log: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  let tick = Date.parse('2026-09-29T12:00:00Z');
  const stamp = () => new Date((tick += 1000)).toISOString();
  let limitNext: { status: number; headers: Record<string, string> } | null = null;
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    log.push({ method, path: url.pathname + url.search, ...(body ? { body } : {}) });
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer invented-token');
    if (limitNext) {
      const l = limitNext;
      limitNext = null;
      return reply(l.status, { message: 'API rate limit exceeded' }, l.headers);
    }
    const p = url.pathname;
    let m: RegExpExecArray | null;
    if (method === 'GET' && p === '/repos/acme/assets') return reply(200, { private: opts.assetsPrivate ?? true });
    if (method === 'POST' && p === '/repos/acme/app/labels') {
      if (labels.has(body!.name as string)) return reply(422, { message: 'Validation Failed' });
      labels.add(body!.name as string);
      return reply(201, { name: body!.name });
    }
    if (method === 'GET' && p === '/repos/acme/app/issues') {
      const since = url.searchParams.get('since');
      const label = url.searchParams.get('labels');
      const page = Number(url.searchParams.get('page') ?? 1);
      const all = issues.filter((i) => (!since || i.updated_at >= since) && (!label || i.labels.some((l) => l.name === label)))
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      const per = 2;
      const slice = all.slice((page - 1) * per, page * per);
      const next = page * per < all.length ? `<https://api.github.com${p}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), page: String(page + 1) })}>; rel="next"` : '';
      return reply(200, slice, next ? { link: next } : {});
    }
    if (method === 'POST' && p === '/repos/acme/app/issues') {
      const n = issues.length + 1;
      const at = stamp();
      issues.push({
        number: n, title: body!.title as string, body: body!.body as string, labels: (body!.labels as string[]).map((name) => ({ name })),
        state: 'open', html_url: `https://github.com/acme/app/issues/${n}`, updated_at: at, created_at: at,
      });
      return reply(201, issues[n - 1]);
    }
    if ((m = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(p))) {
      const issue = issues[Number(m[1]) - 1];
      if (!issue) return reply(404, { message: 'Not Found' });
      if (method === 'PATCH') {
        if (body!.labels) issue.labels = (body!.labels as string[]).map((name) => ({ name }));
        if (body!.state) issue.state = body!.state as 'open' | 'closed';
        issue.updated_at = stamp();
      }
      return reply(200, issue);
    }
    if (method === 'PUT' && (m = /^\/repos\/acme\/assets\/contents\/(.+)$/.exec(p))) {
      const path = decodeURIComponent(m[1]!);
      if (contents.has(path)) return reply(422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
      contents.set(path, body!.content as string);
      return reply(201, { content: { path } });
    }
    return reply(404, { message: `fake: no route for ${method} ${p}` });
  };
  return { fetch, issues, labels, contents, log, limit: (l: typeof limitNext) => { limitNext = l; }, stamp };
}

const draft = (overrides: Partial<IssueDraft> = {}): IssueDraft => ({
  title: 'Totals row double-counts returned loaves', body: 'Invented. Kept: ![chart](attachment:1)',
  kind: 'bug', priority: 'P2', reporter: 'ada', page: '/orders', labels: [], context: { route: '/orders' },
  attachments: [
    { kind: 'screenshot', contentType: 'image/png', bytes: png() },
    { kind: 'image', contentType: 'image/png', bytes: png(), name: 'chart.png' },
    { kind: 'image', contentType: 'image/png', bytes: png(), name: 'removed-from-body.png' },
  ],
  tokenOffset: 1, clientId: id(), receivedAt: '2026-09-29T11:59:00Z', ...overrides,
});

const base = (dir: string, gh: ReturnType<typeof fakeGitHub>, extra: Record<string, unknown> = {}) => githubStore({
  repo: 'acme/app', token: 'invented-token', dir, fetch: gh.fetch as typeof fetch, minWriteIntervalMs: 0, sleep: async () => undefined, ...extra,
});

test('creates a labelled issue with a hidden marker, mirrors it locally, and a resend makes nothing new', async (t) => {
  const dir = await tempDir(t);
  const gh = fakeGitHub();
  const store = base(dir, gh, { attachments: { mode: 'local', baseUrl: 'https://app.test/api/issues' } });
  const d = draft();
  const issue = await store.create(d);
  assert.equal(issue.id, '0001');
  assert.equal(issue.url, 'https://github.com/acme/app/issues/1');
  assert.equal(issue.location, 'https://github.com/acme/app/issues/1');
  const made = gh.issues[0]!;
  assert.ok(made.body.includes(marker(d.clientId!)));
  assert.deepEqual(made.labels.map((l) => l.name), ['feedback', 'kind:bug', 'priority:P2', 'status:open']);
  assert.ok(gh.labels.has('priority:P2'));
  // Local mode: links to the app's own authenticated attachment route.
  assert.match(made.body, /!\[chart\]\(https:\/\/app\.test\/api\/issues\/attachments\/.+\/report-image-1\.png\)/);
  assert.match(made.body, /!\[Screenshot\]\(https:\/\/app\.test\/api\/issues\/attachments\/.+\/report-screenshot\.png\)/);
  assert.match(made.body, /<details><summary>Captured context/);
  // Pictures are in the mirror.
  assert.ok(await store.readAttachment(issue.screenshots[0]!));

  const posts = () => gh.log.filter((r) => r.method === 'POST' && r.path.endsWith('/issues')).length;
  const again = await store.create(d);
  assert.equal(again.repeat, true);
  assert.equal(posts(), 1);
  assert.deepEqual((await store.list()).map((i) => i.id), ['0001']);
});

test('a crash after GitHub created the issue but before the mirror: the retry finds it by marker, via the listing', async (t) => {
  const dir = await tempDir(t);
  const gh = fakeGitHub();
  const store = base(dir, gh);
  // Some unrelated issues first, so the marker search pages.
  for (let i = 0; i < 3; i += 1) await store.create(draft({ clientId: id(), attachments: [] }));
  const d = draft({ attachments: [] });
  const made = await store.create(d);
  const file = (await readdir(dir)).find((n) => n.startsWith(`${made.id}-`))!;
  await rm(join(dir, file));
  const retried = await store.create(d);
  assert.equal(retried.id, made.id);
  assert.equal(retried.repeat, true);
  assert.equal(gh.issues.length, 4);
  assert.ok(gh.log.some((r) => r.method === 'GET' && r.path.includes('since=2026-09-29T11%3A49%3A00.000Z')), 'looks back by the skew allowance');
});

test('rate limits: a short wait is taken inline (measured against GitHub\'s clock); a long one becomes RetryLaterError', async (t) => {
  const dir = await tempDir(t);
  const gh = fakeGitHub();
  const waits: number[] = [];
  const store = base(dir, gh, { sleep: async (ms: number) => { waits.push(ms); } });
  // Our clock may be anywhere; GitHub's Date header says reset is 5 s away.
  const serverNow = Date.parse('2030-01-01T00:00:00Z');
  gh.limit({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(serverNow / 1000 + 5), date: new Date(serverNow).toUTCString() } });
  const issue = await store.create(draft({ attachments: [] }));
  assert.equal(issue.id, '0001');
  assert.deepEqual(waits, [6_000]);

  gh.limit({ status: 429, headers: { 'retry-after': '600' } });
  await assert.rejects(store.create(draft({ attachments: [] })), (err: unknown) => err instanceof RetryLaterError && err.retryAfterMs === 600_000);

  assert.equal(rateLimitWait(new Headers({ 'retry-after': '2' })), 2_000);
  assert.equal(rateLimitWait(new Headers()), 60_000);
  assert.equal(rateLimitWait(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1', date: new Date().toUTCString() })), 1_000);
});

test('repo mode uploads only pictures the report shows, to a private repository; a public one keeps them local', async (t) => {
  const dir = await tempDir(t);
  const gh = fakeGitHub({ assetsPrivate: true });
  const store = base(dir, gh, { attachments: { mode: 'repo', repo: 'acme/assets', path: 'feedback', branch: 'main' } });
  const d = draft();
  await store.create(d);
  assert.deepEqual([...gh.contents.keys()].sort(), [
    `feedback/${d.clientId}/report-image-1.png`, `feedback/${d.clientId}/report-screenshot.png`,
  ]);
  assert.match(gh.issues[0]!.body, /https:\/\/github\.com\/acme\/assets\/blob\/main\/feedback\/.+\/report-screenshot\.png\?raw=true/);

  const dir2 = await tempDir(t);
  const pub = fakeGitHub({ assetsPrivate: false });
  const warn = console.warn;
  console.warn = () => undefined;
  t.after(() => { console.warn = warn; });
  const store2 = base(dir2, pub, { attachments: { mode: 'repo', repo: 'acme/assets' } });
  await store2.create(draft());
  assert.equal(pub.contents.size, 0);
  assert.match(pub.issues[0]!.body, /kept on the server/);
  assert.doesNotMatch(pub.issues[0]!.body, /!\[Screenshot\]/);

  const dir3 = await tempDir(t);
  const none = fakeGitHub();
  await base(dir3, none, { attachments: { mode: 'none' } }).create(draft());
  assert.match(none.issues[0]!.body, /3 pictures kept on the server/);
});

test('a body over GitHub\'s limit is cut with a note; the marker survives', async (t) => {
  const dir = await tempDir(t);
  const gh = fakeGitHub();
  const d = draft({ body: `Invented. ${'x'.repeat(70_000)}`, attachments: [] });
  await base(dir, gh).create(d);
  const body = gh.issues[0]!.body;
  assert.ok(body.length <= 65_536);
  assert.match(body, /cut to fit/);
  assert.ok(body.endsWith(marker(d.clientId!)));
  // The mirror keeps the whole report.
  assert.ok(((await base(dir, gh).get('0001'))!.body.length) > 70_000);
});

test('status out (labels, close) and back in (sync, by GitHub\'s own timestamps)', async (t) => {
  const dir = await tempDir(t);
  const gh = fakeGitHub();
  const store = base(dir, gh);
  for (let i = 0; i < 3; i += 1) await store.create(draft({ clientId: id(), attachments: [] }));
  gh.issues[0]!.labels.push({ name: 'needs-design' });
  const done = await store.update('0001', { status: 'done', priority: 'P1' });
  assert.equal(done.status, 'done');
  assert.equal(gh.issues[0]!.state, 'closed');
  assert.deepEqual(gh.issues[0]!.labels.map((l) => l.name).sort(), ['feedback', 'kind:bug', 'needs-design', 'priority:P1', 'status:done']);

  // Changes made on GitHub: 0002 closed, 0003 labelled triaged, 0001 reopened.
  gh.issues[1]!.state = 'closed'; gh.issues[1]!.updated_at = gh.stamp();
  gh.issues[2]!.labels = gh.issues[2]!.labels.filter((l) => !l.name.startsWith('status:')).concat({ name: 'status:triaged' }); gh.issues[2]!.updated_at = gh.stamp();
  gh.issues[0]!.state = 'open'; gh.issues[0]!.labels = gh.issues[0]!.labels.filter((l) => l.name !== 'status:done'); gh.issues[0]!.updated_at = gh.stamp();
  const synced = await store.sync();
  assert.equal(synced.updated, 3);
  assert.equal((await store.get('0001'))?.status, 'open');
  assert.equal((await store.get('0002'))?.status, 'done');
  assert.ok((await store.get('0002'))?.closedAt);
  assert.equal((await store.get('0003'))?.status, 'triaged');
  // The cursor is GitHub's newest updated_at: a second sync asks only for later changes and changes nothing.
  const before = gh.log.length;
  assert.equal((await store.sync()).updated, 0);
  assert.match(gh.log[before]!.path, /since=2026-09-29T12%3A00/);
});

test('no token: the create fails (and is retried by the ingester), never silently dropped', async (t) => {
  const dir = await tempDir(t);
  const saved = [process.env.FEEDBACK_GITHUB_TOKEN, process.env.GITHUB_TOKEN];
  delete process.env.FEEDBACK_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  t.after(() => {
    if (saved[0] !== undefined) process.env.FEEDBACK_GITHUB_TOKEN = saved[0];
    if (saved[1] !== undefined) process.env.GITHUB_TOKEN = saved[1];
  });
  const store = githubStore({ repo: 'acme/app', dir, fetch: (async () => { throw new Error('must not be called'); }) as typeof fetch });
  await assert.rejects(store.create(draft()), /No GitHub token/);
});

test('a token function is asked on each request, so a token that arrives later (or rotates) is used', async (t) => {
  const dir = await tempDir(t);
  const saved = [process.env.FEEDBACK_GITHUB_TOKEN, process.env.GITHUB_TOKEN];
  delete process.env.FEEDBACK_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  t.after(() => {
    if (saved[0] !== undefined) process.env.FEEDBACK_GITHUB_TOKEN = saved[0];
    if (saved[1] !== undefined) process.env.GITHUB_TOKEN = saved[1];
  });
  const gh = fakeGitHub();
  let current: string | undefined;
  const store = base(dir, gh, { token: () => current });
  await assert.rejects(store.create(draft()), /No GitHub token/);
  assert.equal(gh.log.length, 0);
  current = 'invented-token';
  const issue = await store.create(draft());
  assert.equal(issue.id, '0001');
});
