import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createFeedbackHandler } from '../src/handlers.ts';
import { nextRoutes } from '../src/next.ts';
import { toNodeListener } from '../src/node.ts';
import { fileStore } from '../src/stores/files.ts';
import { post, tempDir, wire } from './helpers.ts';

test('Next adapter: one handler serves GET, POST and PATCH', async (t) => {
  const root = await tempDir(t);
  const routes = nextRoutes(createFeedbackHandler({ journal: join(root, 'inbox'), store: fileStore(join(root, 'issues')), onJournaled: () => undefined }));
  assert.equal((await routes.POST(post(wire()))).status, 202);
  assert.equal((await routes.GET(new Request('http://app.test/api/issues', { headers: { host: 'app.test' } }))).status, 200);
});

test('Node adapter: a real http server journals a POST and falls through for other paths', async (t) => {
  const root = await tempDir(t);
  const handler = createFeedbackHandler({ journal: join(root, 'inbox'), store: fileStore(join(root, 'issues')), onJournaled: () => undefined });
  const server = createServer(toNodeListener(handler, { fallback: (_req, res) => { res.statusCode = 418; res.end(); } }));
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  } catch (err) {
    return t.skip(`cannot listen here: ${(err as Error).message}`);
  }
  t.after(() => new Promise((r) => server.close(r)));
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  const body = wire();
  const res = await fetch(`${origin}/api/feedback`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).clientId, body.clientId);
  assert.equal((await fetch(`${origin}/elsewhere`)).status, 418);
  assert.equal((await fetch(`${origin}/api/feedback?clientId=${body.clientId}`)).status, 200);
});
