import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFrom, sanitizeTitle, continuations } from '../src/title.ts';
import { anthropicTitle, splitKind, type MessagesClient } from '../src/ai-title.ts';
import { PNG_B64 } from './helpers.ts';

test('the fallback title is the first sentence, cut at a clause, never over 80 characters', () => {
  assert.equal(titleFrom('## The export button does nothing. I clicked it twice.'), 'The export button does nothing');
  assert.equal(titleFrom('```\n![shot](attachment:1)\n- the [rail](http://x) is *hard* to read'), 'The rail is hard to read');
  assert.equal(titleFrom('\\\n  \n'), '');
  assert.equal(titleFrom('Short. Then more.'), 'Short. Then more');
  const long = 'The orders totals row on the invented page counts returned loaves, which makes the headline number wrong for everyone';
  const t = titleFrom(long);
  assert.ok(t.length <= 80, t);
  assert.equal(t, 'The orders totals row on the invented page counts returned loaves');
  const words = titleFrom('a'.repeat(30) + ' ' + 'b'.repeat(30) + ' ' + 'c'.repeat(30));
  assert.ok(words.length <= 80 && words.endsWith('…'), words);
  assert.equal(continuations('one \\\ntwo\\'), 'one\ntwo');
});

test('sanitizeTitle keeps one clean line', () => {
  assert.equal(sanitizeTitle('"Totals row double-counts."\nMore'), 'Totals row double-counts');
  assert.equal(sanitizeTitle('Title: **Search** loses focus'), 'Search loses focus');
  assert.equal(sanitizeTitle('   '), '');
  assert.equal(sanitizeTitle(42), '');
  assert.ok(sanitizeTitle('x '.repeat(100)).length <= 80);
});

test('anthropicTitle sends the body, page and first screenshot to the configured model', async () => {
  const calls: Array<{ body: Record<string, unknown>; options?: { signal?: AbortSignal } }> = [];
  const client: MessagesClient = {
    messages: {
      async create(body, options) {
        calls.push({ body, options });
        return { content: [{ type: 'text', text: 'Totals row double-counts returned loaves' }], stop_reason: 'end_turn' };
      },
    },
  };
  const generate = anthropicTitle({ client, model: 'claude-haiku-4-5' });
  const ac = new AbortController();
  const title = await generate({
    clientId: 'x', body: 'Invented body.', page: '/orders', kind: 'bug', priority: 'P2', context: {},
    attachments: [{ kind: 'screenshot', contentType: 'image/png', bytes: Buffer.from(PNG_B64, 'base64') }],
  }, ac.signal);
  assert.equal(title, 'Totals row double-counts returned loaves');
  const { body, options } = calls[0]!;
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.equal(options?.signal, ac.signal);
  const content = (body.messages as Array<{ content: Array<{ type: string; source?: { data: string }; text?: string }> }>)[0]!.content;
  assert.equal(content[0]!.type, 'image');
  assert.equal(content[0]!.source!.data, PNG_B64);
  assert.match(content[1]!.text!, /Page: \/orders/);
  assert.match(content[1]!.text!, /Invented body\./);

  const noShots = anthropicTitle({ client, includeScreenshot: false });
  await noShots({ clientId: 'x', body: 'b', page: '/', kind: 'bug', priority: 'P2', context: {}, attachments: [{ kind: 'screenshot', contentType: 'image/png', bytes: new Uint8Array(4) }] }, ac.signal);
  assert.equal((calls[1]!.body.messages as Array<{ content: unknown[] }>)[0]!.content.length, 1);
});

test('anthropicTitle gives no title on a refusal, or with no key and no client', async () => {
  const refusing: MessagesClient = { messages: { create: async () => ({ content: [], stop_reason: 'refusal' }) } };
  const input = { clientId: 'x', body: 'b', page: '/', kind: 'bug' as const, priority: 'P2' as const, context: {}, attachments: [] };
  assert.equal(await anthropicTitle({ client: refusing })(input, new AbortController().signal), null);
  const saved = [process.env.ANTHROPIC_API_KEY, process.env.FEEDBACK_TITLE_API_KEY];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FEEDBACK_TITLE_API_KEY;
  try {
    assert.equal(await anthropicTitle()(input, new AbortController().signal), null);
  } finally {
    if (saved[0] !== undefined) process.env.ANTHROPIC_API_KEY = saved[0];
    if (saved[1] !== undefined) process.env.FEEDBACK_TITLE_API_KEY = saved[1];
  }
});

test('splitKind takes a kind only from an exact first-line match, else it is all title', () => {
  assert.deepEqual(splitKind('request\nSort the weekly table by returns'), { title: 'Sort the weekly table by returns', kind: 'request' });
  assert.deepEqual(splitKind('Kind: Question.\nWhich oven is each batch in'), { title: 'Which oven is each batch in', kind: 'question' });
  // Not one of the four, or no second line: no kind, and the text is the title.
  assert.deepEqual(splitKind('P0\nEverything is down'), { title: 'P0\nEverything is down' });
  assert.deepEqual(splitKind('urgent bug\nEverything is down'), { title: 'urgent bug\nEverything is down' });
  assert.deepEqual(splitKind('bug'), { title: 'bug' });
  assert.deepEqual(splitKind(null), { title: null });
});

test('anthropicTitle asks for the kind only when the sender named none', async () => {
  const systems: string[] = [];
  const client: MessagesClient = {
    messages: {
      async create(body) {
        systems.push(String(body.system));
        return { content: [{ type: 'text', text: 'chore\nRegion chips use a different grey on Reports' }], stop_reason: 'end_turn' };
      },
    },
  };
  const generate = anthropicTitle({ client });
  const input = { clientId: 'x', body: 'The chips are a different grey.', page: '/reports', priority: 'P2' as const, context: {}, attachments: [] };
  assert.deepEqual(await generate(input, new AbortController().signal), { title: 'Region chips use a different grey on Reports', kind: 'chore' });
  assert.match(systems[0]!, /Line 1, the kind/);
  assert.equal(typeof await generate({ ...input, kind: 'bug' }, new AbortController().signal), 'string');
  assert.doesNotMatch(systems[1]!, /Line 1, the kind/);
});
