import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createFeedbackHandler } from '../src/handlers.ts';
import { createIngester } from '../src/ingest.ts';
import { createJournal } from '../src/journal.ts';
import { feedbackTools, sendFeedback, type McpCaller } from '../src/mcp.ts';
import { fileStore } from '../src/stores/files.ts';
import { PNG, silent, tempDir } from './helpers.ts';

/** Tokens this invented app issued to the apps allowed to give it feedback. */
const CALLERS: Record<string, McpCaller> = {
  'tok-billing': { name: 'billing-app' },
  'tok-maint': { name: 'maintainer-agent', canRead: true },
};
const identify = (req: Request) => CALLERS[(req.headers.get('authorization') ?? '').replace(/^Bearer /, '')] ?? null;

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await tempDir(t);
  const journal = createJournal(join(root, 'inbox'));
  const store = fileStore(join(root, 'issues'));
  const handler = createFeedbackHandler({
    journal, store, onJournaled: () => undefined,
    mcp: { identify, app: { name: 'orchard-street', version: '1.2.3' }, about: 'An invented bakery app.' },
  });
  const ingester = createIngester({ journal, store, generateTitle: null, logger: silent });
  /** A fetch that reaches the handler without a network. */
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => handler.handle(new Request(input, init))) as typeof globalThis.fetch;
  return { journal, store, handler, ingester, fetch };
}

const URL_ = 'http://app.test/api/feedback/mcp';
const post = (body: unknown, token = 'tok-billing', headers: Record<string, string> = {}) => new Request(URL_, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers },
});

test('the endpoint: initialize, tools/list, submit, filed by the ingester, status names the issue', async (t) => {
  const { handler, ingester, store } = await setup(t);
  const init = await (await handler.handle(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }))).json() as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown } };
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'orchard-street');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal((await handler.handle(post({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202);

  const list = await (await handler.handle(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json() as { result: { tools: Array<{ name: string; description: string; annotations: { readOnlyHint: boolean } }> } };
  assert.deepEqual(list.result.tools.map((x) => x.name), ['feedback_submit', 'feedback_status', 'feedback_list', 'feedback_get']);
  assert.match(list.result.tools[0]!.description, /An invented bakery app\./);
  assert.equal(list.result.tools[0]!.annotations.readOnlyHint, false);

  const clientId = randomUUID();
  const call = (name: string, args: Record<string, unknown>, token?: string) =>
    handler.handle(post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, token)).then((r) => r.json()) as
      Promise<{ result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> } }>;
  const sent = await call('feedback_submit', {
    body: 'The `invoices.list` tool returns totals in cents but documents them in euros. ![the response](attachment:1)',
    kind: 'bug', priority: 'P1', about: 'tool:invoices.list', client_id: clientId,
    context: { request_id: 'req-123', reporter: 'someone-else' }, screenshots: [PNG],
  });
  assert.deepEqual(sent.result.structuredContent, { client_id: clientId, state: 'journaled', repeat: false, id: null });
  // A resend with the same client_id files nothing new.
  assert.equal((await call('feedback_submit', { body: 'again', client_id: clientId })).result.structuredContent?.repeat, true);

  await ingester.runOnce();
  const issue = (await store.list())[0]!;
  assert.equal(issue.reporter, 'mcp:billing-app');
  assert.equal(issue.page, 'tool:invoices.list');
  assert.equal(issue.priority, 'P1');
  assert.equal(issue.attachments.length, 1);
  assert.equal(issue.context?.via, 'mcp');
  assert.equal(issue.context?.caller, 'billing-app');
  // The caller cannot name the reporter through the context.
  assert.equal(issue.context?.reporter, 'mcp:billing-app');

  const status = await call('feedback_status', { client_id: clientId });
  assert.equal(status.result.structuredContent?.state, 'filed');
  assert.equal(status.result.structuredContent?.id, issue.id);

  // Reading is for callers allowed to read.
  assert.equal((await call('feedback_list', {})).result.isError, true);
  const listed = await call('feedback_list', { status: ['open'] }, 'tok-maint');
  assert.equal((listed.result.structuredContent?.issues as unknown[]).length, 1);
  const got = await call('feedback_get', { id: issue.id }, 'tok-maint');
  assert.match(String((got.result.structuredContent?.issue as { body: string }).body), /invoices\.list/);
});

test('the endpoint refuses strangers, foreign browser origins, GET, and bad reports', async (t) => {
  const { handler } = await setup(t);
  assert.equal((await handler.handle(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope'))).status, 401);
  assert.equal((await handler.handle(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'tok-billing', { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await handler.handle(new Request(URL_, { headers: { authorization: 'Bearer tok-billing' } }))).status, 405);
  const empty = await (await handler.handle(post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'feedback_submit', arguments: { body: '   ' } } }))).json() as { result: { isError: boolean } };
  assert.equal(empty.result.isError, true);
  const unknown = await (await handler.handle(post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'feedback_delete_everything', arguments: {} } }))).json() as { error: { code: number } };
  assert.equal(unknown.error.code, -32602);
  // Without `mcp` options there is no endpoint at all.
  const root = await tempDir(t);
  const plain = createFeedbackHandler({ journal: createJournal(join(root, 'inbox')), onJournaled: () => undefined });
  assert.equal((await plain.handle(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status, 404);
});

test('interop: the official MCP SDK client lists and calls the kit endpoint', async (t) => {
  const { fetch, journal } = await setup(t);
  const client = new Client({ name: 'billing-app', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { fetch, requestInit: { headers: { authorization: 'Bearer tok-billing' } } }));
  const { tools } = await client.listTools();
  assert.ok(tools.some((x) => x.name === 'feedback_submit'));
  const clientId = randomUUID();
  const r = await client.callTool({ name: 'feedback_submit', arguments: { body: 'The export button times out on large months.', client_id: clientId } });
  assert.equal((r.structuredContent as { state: string }).state, 'journaled');
  assert.equal((await journal.status(clientId))?.state, 'journaled');
  await client.close();
});

test('interop: feedbackTools on an SDK server, reached by sendFeedback (sessions and event streams)', async (t) => {
  const root = await tempDir(t);
  const journal = createJournal(join(root, 'inbox'));
  const tools = feedbackTools({ journal, onJournaled: () => undefined });
  // An app that already has an MCP server registers the kit's tools on it.
  const server = new Server({ name: 'other-app', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema: inputSchema as { type: 'object' }, annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((x) => x.name === req.params.name);
    if (!tool) throw new Error('unknown tool');
    return tool.call(req.params.arguments ?? {}, { name: 'sdk-caller' }) as never;
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  t.after(() => server.close());
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => transport.handleRequest(new Request(input, init))) as typeof globalThis.fetch;

  const out = await sendFeedback({ url: 'http://other.test/mcp', fetch, from: 'orchard-street', report: { body: 'Your rates endpoint rounds half-cents down.', kind: 'bug' } });
  assert.equal(out.state, 'journaled');
  const s = await journal.status(out.client_id);
  assert.equal(s?.state, 'journaled');
  const read = await journal.read(out.client_id);
  assert.ok(read?.ok);
  assert.equal(read.entry.reporter, 'mcp:sdk-caller');
});
