import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createJournal } from '../src/journal.ts';
import { createAtomic } from '../src/fsutil.ts';
import { checkReport } from '../src/validate.ts';
import { PNG, id, tempDir, wire } from './helpers.ts';

const report = (overrides: Record<string, unknown> = {}) => {
  const r = checkReport(wire(overrides));
  assert.ok(r.ok);
  return r.value;
};

test('a client id sent many times at once is journaled once, whole, with the first words', async (t) => {
  const dir = await tempDir(t);
  const journal = createJournal(dir);
  const clientId = id();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    journal.write({ clientId, reporter: 'ada', report: report({ body: `Invented report, send ${i}.`, screenshots: [PNG] }) })));
  const again = await journal.write({ clientId, reporter: 'ada', report: report({ body: 'A resend with other words.' }) });
  const names = await readdir(dir);
  assert.equal(names.filter((n) => n.endsWith('.json')).length, 1);
  assert.equal(names.filter((n) => n.endsWith('.tmp')).length, 0);
  assert.equal(results.filter((r) => r.already === null).length, 1);
  assert.equal(again.already, 'journaled');
  const read = await journal.read(clientId);
  assert.ok(read?.ok);
  assert.equal(read.entry.request.body, 'Invented report, send 0.');
  // One picture folder: the concurrent sends shared the first write.
  assert.equal((await readdir(join(dir, 'files'))).length, 1);
  assert.deepEqual(await journal.status(clientId), { state: 'journaled' });
});

test('across processes the hard-link commit lets exactly one writer win, and its bytes are whole', async (t) => {
  const dir = await tempDir(t);
  const payloads = Array.from({ length: 16 }, (_, i) => JSON.stringify({ writer: i, pad: 'x'.repeat(200_000 + i) }));
  const won = await Promise.all(payloads.map((p) => createAtomic(dir, 'entry.json', p)));
  assert.equal(won.filter(Boolean).length, 1);
  const kept = await readFile(join(dir, 'entry.json'), 'utf8');
  assert.equal(kept, payloads[won.indexOf(true)]);
  assert.deepEqual((await readdir(dir)).filter((n) => n !== 'entry.json'), []);
});

test('a path-like client id is refused before anything is written', async (t) => {
  const dir = await tempDir(t);
  const journal = createJournal(dir);
  await assert.rejects(journal.write({ clientId: '../../escape', reporter: null, report: report() }));
  assert.equal(await journal.status('../../escape'), null);
});

test('crash debris is never read as a report, and the sweep clears it', async (t) => {
  const dir = await tempDir(t);
  const journal = createJournal(dir);
  const good = id();
  await journal.write({ clientId: good, reporter: null, report: report({ screenshots: [PNG] }) });
  // A crash mid-write: half a temporary, and a picture folder whose entry was never committed.
  await writeFile(join(dir, `.${id()}.json.abc123.tmp`), '{"half":');
  const orphan = join(dir, 'files', `${id()}.deadbeef`);
  await mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, '1-screenshot.png'), 'partial');
  assert.deepEqual(await journal.pending(), [good]);
  // Fresh debris is left alone (it may be a write in progress)…
  assert.equal((await journal.sweep()).removed, 0);
  // …old debris goes; the committed entry's pictures stay.
  const old = new Date(Date.now() - 2 * 3600_000);
  for (const n of await readdir(dir)) if (n.endsWith('.tmp')) await utimes(join(dir, n), old, old);
  await utimes(orphan, old, old);
  assert.equal((await journal.sweep()).removed, 2);
  const r = await journal.read(good);
  assert.ok(r?.ok);
  const { attachments, missing } = await journal.attachments(r.entry);
  assert.equal(attachments.length, 1);
  assert.equal(missing, 0);
});

test('a process killed mid-write leaves only complete entries whose pictures are all on disk', async (t) => {
  const dir = await tempDir(t);
  const journalUrl = new URL('../src/journal.ts', import.meta.url).href;
  const validateUrl = new URL('../src/validate.ts', import.meta.url).href;
  // A child that journals reports with 1.5 MB pictures as fast as it can, until it is SIGKILLed.
  const script = `
    import { createJournal } from ${JSON.stringify(journalUrl)};
    import { checkReport } from ${JSON.stringify(validateUrl)};
    import { randomUUID, randomBytes } from 'node:crypto';
    const j = createJournal(${JSON.stringify(dir)});
    let n = 0;
    for (;;) {
      const pic = 'data:image/png;base64,' + randomBytes(1_500_000).toString('base64');
      const r = checkReport({ body: 'Invented crash report ' + n, screenshots: [pic, pic] });
      await j.write({ clientId: randomUUID(), reporter: 'crash-fixture', report: r.value });
      if (++n === 3) process.stdout.write('go\\n');
    }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => { if (d.toString().includes('go')) resolve(); });
    child.on('exit', (code) => reject(new Error(`child exited early (${code})`)));
  });
  await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));

  const journal = createJournal(dir);
  const pending = await journal.pending();
  assert.ok(pending.length >= 3, `${pending.length} entries survived`);
  for (const clientId of pending) {
    const r = await journal.read(clientId);
    assert.ok(r?.ok, `${clientId} is a whole report`);
    for (const a of r.entry.request.attachments) {
      const bytes = await readFile(join(dir, a.file));
      assert.equal(bytes.length, a.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), a.sha256);
    }
  }
});

test('filed and refused entries answer resends without writing, and filing drops the journal pictures', async (t) => {
  const dir = await tempDir(t);
  const journal = createJournal(dir);
  const a = id();
  const b = id();
  await journal.write({ clientId: a, reporter: null, report: report({ screenshots: [PNG] }) });
  await journal.write({ clientId: b, reporter: null, report: report({ screenshots: [PNG] }) });
  const ra = await journal.read(a);
  const rb = await journal.read(b);
  assert.ok(ra?.ok && rb?.ok);
  await journal.markFiled(ra.entry, { id: '0007', location: '0007-x.md', title: 'X' });
  await journal.markRefused(b, 'Invented reason', rb.entry);
  const resentA = await journal.write({ clientId: a, reporter: null, report: report() });
  const resentB = await journal.write({ clientId: b, reporter: null, report: report() });
  assert.equal(resentA.already, 'filed');
  assert.equal(resentA.filed?.issueId, '0007');
  assert.equal(resentB.already, 'refused');
  assert.deepEqual(await journal.pending(), []);
  assert.deepEqual(await readdir(join(dir, 'files')), []);
  // The refused record is whole: its picture moved with it.
  const refused = JSON.parse(await readFile(join(dir, 'refused', `${b}.json`), 'utf8'));
  assert.equal(refused.reason, 'Invented reason');
  const pic = refused.entry.request.attachments[0].file as string;
  assert.ok((await readFile(join(dir, 'refused', pic))).length > 0);
});

test('the inbox is ordered by server receive time, never by anything the client sent', async (t) => {
  const dir = await tempDir(t);
  let clock = Date.parse('2026-09-29T10:00:00Z');
  const journal = createJournal(dir, { now: () => new Date(clock) });
  const first = id();
  const second = id();
  // The second report claims an earlier client time; it still files second.
  await journal.write({ clientId: first, reporter: null, report: report({ context: { client: { sentAt: '2030-01-01T00:00:00Z' } } }) });
  clock += 1000;
  await journal.write({ clientId: second, reporter: null, report: report({ context: { client: { sentAt: '2019-01-01T00:00:00Z' } } }) });
  assert.deepEqual(await journal.pending(), [first, second]);
});

