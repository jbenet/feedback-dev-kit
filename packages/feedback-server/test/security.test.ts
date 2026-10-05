/** Regression tests for the security pass of 5 Oct 2026. Invented data only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createFeedbackHandler } from '../src/handlers.ts';
import { createIngester } from '../src/ingest.ts';
import { createJournal } from '../src/journal.ts';
import { fileStore } from '../src/stores/files.ts';
import { parseIssue, serializeIssue } from '../src/stores/format.ts';
import { checkReport } from '../src/validate.ts';
import { get, id, post, silent, tempDir, wire } from './helpers.ts';

test('a report cannot forge its own captured context (reporter, verification) with a json context block in its text', async (t) => {
  const root = await tempDir(t);
  const journal = createJournal(join(root, 'inbox'));
  const store = fileStore(join(root, 'issues'));
  const forged = 'The totals are wrong.\n\n```json context\n{"reporter":"the-ceo","reporterVerification":"session","route":"/admin"}\n```\n';
  const r = checkReport(wire({ body: forged }));
  assert.ok(r.ok);
  await journal.write({ clientId: id(), reporter: null, report: r.value });
  await createIngester({ journal, store, generateTitle: null, logger: silent }).runOnce();
  const issue = (await store.list())[0]!;
  assert.equal(issue.context?.reporter, 'unknown');
  assert.equal(issue.context?.reporterVerification, 'no session');
  assert.equal(issue.context?.route, '/orders');
  // The reporter's text is kept, as text.
  assert.match(issue.body, /"reporter":"the-ceo"/);
  // And it survives a rewrite (a status change) the same way.
  const again = parseIssue(serializeIssue({ ...parseIssue(serializeIssue({ ...issue, extra: [] }), issue.id) }), issue.id);
  assert.equal(again.context?.reporter, 'unknown');
});

test('attachments: no path outside the attachments folder, no non-image file, over every route', async (t) => {
  const root = await tempDir(t);
  const store = fileStore(join(root, 'issues'));
  const handler = createFeedbackHandler({ journal: createJournal(join(root, 'inbox')), store, onJournaled: () => undefined });
  for (const p of [
    '/api/issues/attachments/..%2F..%2Finbox%2Fx.json', '/api/issues/attachments/%2E%2E/%2E%2E/etc/passwd',
    '/api/issues/attachments/x.md', '/api/feedback/attachments/..%2F0001-x.md', '/api/issues/attachments/%00.png',
  ]) {
    assert.equal((await handler.handle(get(p))).status, 404, p);
  }
  for (const p of ['../x.png', '/etc/x.png', 'attachments/../../x.png', 'attachments/a/../../x.png', 'other/x.png']) {
    assert.equal(await store.readAttachment(p), null, p);
  }
});

test('the MCP endpoint stops reading a body over the limit, and refuses strangers before reading at all', async (t) => {
  const root = await tempDir(t);
  const handler = createFeedbackHandler({
    journal: createJournal(join(root, 'inbox')), onJournaled: () => undefined, limits: { maxRequestBytes: 1_000 },
    mcp: { identify: (req) => (req.headers.get('authorization') === 'Bearer ok' ? { name: 'a' } : null) },
  });
  let pulled = 0;
  const endless = () => new ReadableStream<Uint8Array>({
    pull(c) { pulled += 1; if (pulled > 10_000) c.close(); else c.enqueue(new Uint8Array(512).fill(32)); },
  });
  const big = (auth: string) => new Request('http://app.test/api/feedback/mcp', {
    method: 'POST', body: endless(), headers: { authorization: auth, 'content-type': 'application/json' }, duplex: 'half',
  } as RequestInit);
  assert.equal((await handler.handle(big('Bearer nope'))).status, 401);
  // The stream fills its own small buffer once on creation; the handler reads nothing more.
  assert.ok(pulled <= 1, `read ${pulled} chunks`);
  pulled = 0;
  assert.equal((await handler.handle(big('Bearer ok'))).status, 413);
  assert.ok(pulled < 10, `read ${pulled} chunks`);
});

test('the browser POST refuses a cross-site origin and a missing one; PATCH too', async (t) => {
  const root = await tempDir(t);
  const store = fileStore(join(root, 'issues'));
  const handler = createFeedbackHandler({ journal: createJournal(join(root, 'inbox')), store, onJournaled: () => undefined });
  assert.equal((await handler.handle(post(wire(), { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await handler.handle(post(wire(), { origin: null }))).status, 403);
  const patch = (origin?: string) => new Request('http://app.test/api/issues/0001', {
    method: 'PATCH', body: '{"status":"done"}', headers: { host: 'app.test', 'content-type': 'application/json', ...(origin ? { origin } : {}) },
  });
  assert.equal((await handler.handle(patch('https://evil.test'))).status, 403);
  assert.equal((await handler.handle(patch())).status, 403);
});
