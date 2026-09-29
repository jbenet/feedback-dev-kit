/**
 * The feedback outbox: a report is never lost because the server was down.
 *
 * File keeps the report here, then posts it at once with a 3 s timeout. The server journals it and
 * answers 202; from then on it is safe on the server, and this browser only watches for its issue
 * number. Only when the request cannot reach the server — a restart, the network — does the report
 * stay here, "only on this device", and a sender keeps resending with a backoff (journal.ts), and
 * at once when the page loads, the network comes back, the tab is shown again, or any request to
 * this origin succeeds. The server dedupes on the client id.
 *
 * Storage: IndexedDB, one record per report, pictures and all. When IndexedDB is unavailable or
 * hangs (older Safari can leave `open` pending forever), the words go to localStorage without the
 * pictures and the entry says so. Every access is allowed to fail; a failed bookkeeping write only
 * means a report may be sent once more, which the server answers with the issue it already filed.
 *
 * Client only. One outbox per page: configure it once (the FeedbackButton does, from its provider).
 */
import {
  classify, due, entryTitle, sendTimeout, settle,
  type FeedbackRequest, type JournalEntry, type SendOutcome,
} from './journal';
import { newRequestKey } from './request-key';

/** GUESS: a working IndexedDB opens in milliseconds; past this it is treated as unavailable. */
const OPEN_TIMEOUT_MS = 2_000;
/** A kick (a live request, the tab shown again) does not resend an entry tried this recently. */
const KICK_GAP_MS = 3_000;
/** How long a filed report's number stays on show. */
const FILED_SHOWN_MS = 8_000;
/** How often a report saved on the server is asked about, and for how long. GUESS. */
const POLL_EVERY_MS = 3_000;
const POLL_FOR_MS = 10 * 60_000;

let settings = { submitUrl: '/api/feedback', prefix: 'feedbackkit' };
const dbName = () => `${settings.prefix}-outbox`;
const lsKey = () => `${settings.prefix}.feedback.outbox`;
const STORE = 'entries';

/**
 * Where reports go and what the storage is called. Call before `startOutbox`; a later call only
 * changes the URL (the storage is already open under its name).
 */
export function configureOutbox(next: { submitUrl?: string; prefix?: string }) {
  settings = {
    submitUrl: next.submitUrl ?? settings.submitUrl,
    prefix: started ? settings.prefix : next.prefix ?? settings.prefix,
  };
}

/** Filed a moment ago: an issue id; `error` if the server refused it after all. */
export interface FiledNote { clientId: string; id: string | null; title: string; at: number; error?: string }

/** Journaled on the server, waiting to be filed there. Not stored: it is safe on the server. */
export interface ServerNote { clientId: string; title: string; at: number }

export interface OutboxState {
  entries: JournalEntry[];
  /** Client ids being sent right now. */
  sending: string[];
  /** Saved on the server, not yet filed. */
  onServer: ServerNote[];
  /** Filed in the last few seconds, newest last. */
  filed: FiledNote[];
  /** The report just saved from the box, until its first send ends. */
  justSaved: string | null;
}

const EMPTY: OutboxState = { entries: [], sending: [], onServer: [], filed: [], justSaved: null };
let state: OutboxState = EMPTY;
const listeners = new Set<() => void>();
const set = (patch: Partial<OutboxState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const snapshot = () => state;
export const serverSnapshot = () => EMPTY;

// ---------------------------------------------------------------- storage

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error('IndexedDB did not open')); }, OPEN_TIMEOUT_MS);
    try {
      const req = window.indexedDB.open(dbName(), 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'clientId' }); };
      req.onsuccess = () => {
        clearTimeout(timer);
        if (settled) { req.result.close(); return; }
        settled = true;
        resolve(req.result);
      };
      req.onerror = () => { clearTimeout(timer); if (!settled) { settled = true; reject(req.error); } };
      req.onblocked = () => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error('IndexedDB is blocked')); } };
    } catch (err) {
      clearTimeout(timer);
      settled = true;
      reject(err);
    }
  });
}

/**
 * One transaction, opened and closed each time: a connection held across a long background
 * stretch is what Safari drops ("Connection to Indexed Database server lost"). The work is plain
 * callbacks, not promises, so the transaction stays active between a read and the write after it
 * on every engine. It resolves when the transaction commits, with whatever `keep` was given.
 */
async function transact<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore, keep: (v: T) => void) => void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let out: T | undefined;
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      act(tx.objectStore(STORE), (v) => { out = v; });
    });
  } finally {
    db.close();
  }
}

function readLocal(): JournalEntry[] {
  try {
    const raw = window.localStorage.getItem(lsKey());
    const list = raw ? (JSON.parse(raw) as JournalEntry[]) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.clientId === 'string' && e.request) : [];
  } catch { return []; }
}
function writeLocal(list: JournalEntry[]) {
  if (list.length) window.localStorage.setItem(lsKey(), JSON.stringify(list));
  else window.localStorage.removeItem(lsKey());
}

// One storage operation at a time, so a late bookkeeping write cannot overtake a removal.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.catch(() => undefined);
  return result;
}

const storage = {
  all: () => serial(async () => {
    let kept: JournalEntry[] = [];
    try {
      kept = (await transact<JournalEntry[]>('readonly', (s, keep) => {
        const all = s.getAll();
        all.onsuccess = () => keep(all.result as JournalEntry[]);
      })) ?? [];
    } catch { /* none readable */ }
    const seen = new Set(kept.map((e) => e.clientId));
    return [...kept, ...readLocal().filter((e) => !seen.has(e.clientId))]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }),
  /** Keeps a new entry, or throws when there is nowhere to keep it. */
  add: (entry: JournalEntry) => serial(async () => {
    try {
      await transact('readwrite', (s) => { s.put(entry); });
      return entry;
    } catch {
      const words: JournalEntry = { ...entry, textOnly: true, request: { ...entry.request, screenshots: [], images: [] } };
      writeLocal([...readLocal().filter((e) => e.clientId !== entry.clientId), words]);
      return words;
    }
  }),
  /** Changes an entry that is still there; one another tab has filed is not brought back. */
  update: (clientId: string, change: (e: JournalEntry) => JournalEntry) => serial(async () => {
    try {
      await transact('readwrite', (s) => {
        const got = s.get(clientId);
        got.onsuccess = () => { if (got.result) s.put(change(got.result as JournalEntry)); };
      });
    } catch { /* bookkeeping only */ }
    try {
      const local = readLocal();
      if (local.some((e) => e.clientId === clientId)) writeLocal(local.map((e) => (e.clientId === clientId ? change(e) : e)));
    } catch { /* bookkeeping only */ }
  }),
  remove: (clientId: string) => serial(async () => {
    try { await transact('readwrite', (s) => { s.delete(clientId); }); } catch { /* sent again, answered with the same issue */ }
    try { writeLocal(readLocal().filter((e) => e.clientId !== clientId)); } catch { /* likewise */ }
  }),
};

// ---------------------------------------------------------------- tabs

let channel: BroadcastChannel | null = null;
const tellOtherTabs = () => { try { channel?.postMessage('changed'); } catch { /* one tab */ } };

async function refresh() {
  const entries = await storage.all();
  set({ entries, justSaved: state.justSaved && entries.some((e) => e.clientId === state.justSaved) ? state.justSaved : null });
  return entries;
}

// ---------------------------------------------------------------- the sender

/** The page's own fetch, before the success hook below wraps it: the sender's sends are not kicks. */
let plainFetch: typeof fetch | null = null;
const lastTried = new Map<string, number>();
let pumping = false;
let again: boolean | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

async function sendOne(entry: JournalEntry): Promise<SendOutcome> {
  const body = JSON.stringify({ ...entry.request, clientId: entry.clientId });
  const patience = sendTimeout(body.length);
  const ctrl = new AbortController();
  const stop = setTimeout(() => ctrl.abort(), patience);
  try {
    const res = await (plainFetch ?? fetch)(settings.submitUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'include',
      // A small report outlives the tab being closed mid-send. Browsers cap keepalive bodies at 64 KB.
      keepalive: body.length < 60_000,
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* an HTML error page, or cut off */ }
    return classify(entry.clientId, res.status, json);
  } catch {
    return classify(entry.clientId, null, null, ctrl.signal.aborted
      ? `No answer within ${patience / 1000} s`
      : 'Could not reach the server');
  } finally {
    clearTimeout(stop);
  }
}

function showFiled(note: FiledNote) {
  set({ filed: [...state.filed.filter((f) => f.clientId !== note.clientId), note], onServer: state.onServer.filter((n) => n.clientId !== note.clientId) });
  setTimeout(() => set({ filed: state.filed.filter((f) => f !== note) }), FILED_SHOWN_MS);
}

/**
 * Reports saved on the server, asked about until they are filed: the issue id is shown for a few
 * seconds. GET {submit}?clientId= reads the journal only. Given up quietly after ten minutes — the
 * report is safe on the server either way.
 */
let polling: ReturnType<typeof setTimeout> | null = null;
function poll() {
  if (polling || !state.onServer.length) return;
  polling = setTimeout(async () => {
    polling = null;
    const now = Date.now();
    for (const n of state.onServer) {
      if (now - n.at > POLL_FOR_MS) { set({ onServer: state.onServer.filter((x) => x !== n) }); continue; }
      const ctrl = new AbortController();
      const stop = setTimeout(() => ctrl.abort(), 3_000);
      try {
        const sep = settings.submitUrl.includes('?') ? '&' : '?';
        const res = await (plainFetch ?? fetch)(`${settings.submitUrl}${sep}clientId=${encodeURIComponent(n.clientId)}`, { cache: 'no-store', credentials: 'include', signal: ctrl.signal });
        const json = await res.json() as { state?: string; id?: string | null; error?: string };
        if (json.state === 'filed') showFiled({ clientId: n.clientId, id: json.id ?? null, title: n.title, at: Date.now() });
        else if (json.state === 'refused') showFiled({ clientId: n.clientId, id: null, title: n.title, at: Date.now(), error: json.error ?? 'refused' });
      } catch { /* asked again next time */ } finally { clearTimeout(stop); }
    }
    poll();
  }, POLL_EVERY_MS);
}

async function attempt(entry: JournalEntry): Promise<SendOutcome> {
  lastTried.set(entry.clientId, Date.now());
  set({ sending: [...state.sending, entry.clientId] });
  const outcome = await sendOne(entry);
  if (outcome.kind === 'filed' || outcome.kind === 'journaled') {
    // Safe on the server: this browser no longer needs to keep it.
    await storage.remove(entry.clientId);
    const title = entryTitle(entry);
    if (outcome.id) showFiled({ clientId: entry.clientId, id: outcome.id, title, at: Date.now() });
    else {
      set({ onServer: [...state.onServer.filter((n) => n.clientId !== entry.clientId), { clientId: entry.clientId, title, at: Date.now() }] });
      poll();
    }
  } else {
    const now = Date.now();
    await storage.update(entry.clientId, (e) => settle([e], e.clientId, outcome, now)[0]!);
  }
  set({
    sending: state.sending.filter((id) => id !== entry.clientId),
    justSaved: state.justSaved === entry.clientId ? null : state.justSaved,
  });
  tellOtherTabs();
  await refresh();
  return outcome;
}

/** Send what is due; `kicked` sends every entry that is not refused and not tried a moment ago. */
async function pump(kicked: boolean) {
  if (pumping) { again = Boolean(again) || kicked; return; }
  pumping = true;
  try {
    let kick = kicked;
    for (;;) {
      again = null;
      const entries = await refresh();
      const now = Date.now();
      for (const e of entries) {
        if (state.sending.includes(e.clientId) || !due(e, now, kick)) continue;
        if (kick && e.nextAt > now && now - (lastTried.get(e.clientId) ?? 0) < KICK_GAP_MS) continue;
        await attempt(e);
      }
      if (again === null) break;
      kick = again;
    }
  } catch { /* the next kick or tick tries again */ } finally {
    pumping = false;
    schedule();
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  const waiting = state.entries.filter((e) => !e.refused);
  if (!waiting.length) return;
  const next = Math.min(...waiting.map((e) => e.nextAt));
  timer = setTimeout(() => void pump(false), Math.max(1_000, next - Date.now()));
}

let lastKick = 0;
function kick() {
  lastKick = Date.now();
  void pump(true);
}

let started = false;
/** Starts the sender once per page. Safe to call from every component that files. */
export function startOutbox() {
  if (started || typeof window === 'undefined') return;
  started = true;
  plainFetch = window.fetch.bind(window);
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(dbName()) : null;
    if (channel) channel.onmessage = () => { void refresh().then(schedule); };
  } catch { channel = null; }
  window.addEventListener('storage', (e) => { if (e.key === lsKey()) void refresh().then(schedule); });
  window.addEventListener('online', kick);
  window.addEventListener('pageshow', (e) => { if (e.persisted) kick(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
  // Any request to this origin that succeeds says the server is answering again. Wrapped once, and
  // only watched: the request and its response pass through untouched.
  const w = window as typeof window & { __feedbackKitOutboxFetch?: boolean };
  if (!w.__feedbackKitOutboxFetch) {
    w.__feedbackKitOutboxFetch = true;
    const original = window.fetch;
    window.fetch = async function watched(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const res = await original.call(this ?? window, input, init);
      try {
        if (res.ok && state.entries.some((e) => !e.refused) && Date.now() - lastKick > KICK_GAP_MS
          && new URL(res.url || String(input), window.location.href).origin === new URL(settings.submitUrl, window.location.href).origin) kick();
      } catch { /* only watched */ }
      return res;
    } as typeof fetch;
  }
  kick();
}

/** Send everything waiting now, as when the network comes back. */
export const flushOutbox = () => { if (started) kick(); };

// ---------------------------------------------------------------- what the page calls

/**
 * File one report: keep it in this browser, then send it at once and wait for that one answer (3 s,
 * longer for big pictures). `onServer` says whether the server accepted it; if not, it stays here
 * and is resent. Throws only when this browser could keep nothing and the server was not reached.
 */
export async function enqueue(request: FeedbackRequest): Promise<{ entry: JournalEntry; onServer: boolean }> {
  startOutbox();
  const entry: JournalEntry = {
    clientId: newRequestKey(),
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextAt: 0,
    lastError: null,
    refused: false,
    request,
  };
  let kept: JournalEntry | null = null;
  try { kept = await storage.add(entry); } catch { /* nowhere in this browser: the server is the only place */ }
  if (kept) {
    set({ entries: [...state.entries.filter((e) => e.clientId !== kept!.clientId), kept], justSaved: kept.clientId });
    tellOtherTabs();
  }
  const outcome = await attempt(kept ?? entry);
  const onServer = outcome.kind === 'journaled' || outcome.kind === 'filed';
  if (!onServer && !kept) throw new Error(`the server was not reached (${outcome.kind === 'refused' || outcome.kind === 'retry' ? outcome.error : ''}) and this browser has no storage`);
  if (!onServer) schedule();
  return { entry: kept ?? entry, onServer };
}

/** Send this one now, even one the server refused. */
export async function retryNow(clientId: string) {
  lastTried.delete(clientId);
  await storage.update(clientId, (e) => ({ ...e, refused: false, nextAt: 0 }));
  tellOtherTabs();
  await pump(true);
}

/** Drop a report that will not be filed. The caller confirms first. */
export async function discardEntry(clientId: string) {
  await storage.remove(clientId);
  tellOtherTabs();
  await refresh();
  schedule();
}
