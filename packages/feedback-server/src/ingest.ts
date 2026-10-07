/**
 * The ingester: files what the journal holds, off the request path.
 *
 * One pass at a time per journal (a kick during a pass asks for one more pass). It runs right after
 * each journal write (the handler kicks it), when the server starts (whatever a restart left), and on
 * a timer. Each entry is named (generateTitle, else the first sentence), its reporter resolved
 * (identify, optional), and handed to the store, which dedupes on the client id — so an entry filed
 * twice, after a crash between the store's write and the journal's move, is still one issue. A filed
 * entry moves to filed/; one that fails stays and is retried with backoff; one the store refuses
 * (RefusedError) moves to refused/ with the reason and is never retried.
 *
 * Only one ingester runs per journal folder in a process, even when a framework loads this module
 * twice (Next does: once for the route, once for instrumentation): startIngester keeps it on globalThis.
 */
import { performance } from 'node:perf_hooks';
import { defaultGenerateTitle, type GenerateTitle } from './ai-title.ts';
import { createJournal, type Journal } from './journal.ts';
import { flagNote, neutralize, patternScreen, type ScreenInput, type ScreenReport, type ScreenVerdict } from './injection.ts';
import { sanitizeTitle, titleFrom } from './title.ts';
import { RefusedError, RetryLaterError, type FeedbackStore, type Issue, type IssueDraft, type JournalEntry } from './types.ts';

export interface Reporter {
  handle: string;
  /** How the handle was established, recorded in the issue's context. */
  verification: string;
}

export interface IngesterOptions {
  journal: Journal | string;
  store: FeedbackStore;
  /** Undefined: Claude when ANTHROPIC_API_KEY is set, else none. null: never call a model. */
  generateTitle?: GenerateTitle | null;
  /** GUESS: a title is worth a few seconds of waiting, not a stuck queue. */
  titleTimeoutMs?: number;
  /**
   * Resolve the selector captured at request time (resolveReporter) into a verified reporter, off the
   * request — e.g. a database lookup of the session's user. Throw when the lookup fails: the entry
   * stays journaled and is retried, because a failed lookup is not evidence that nobody sent it.
   * Return null only when a successful lookup found no such user: the issue is filed as 'unknown'.
   * Without it, the captured selector is used as the handle.
   */
  identify?: (selector: string | null, entry: JournalEntry) => Promise<Reporter | null>;
  /** GUESS (PL LabOS tools): often enough that a missed kick costs seconds. Default 10 s. */
  everyMs?: number;
  /** Delay after the nth failure of one entry. Default 2 s, 10 s, 30 s, 2 min, then every 5 min (GUESS). */
  backoff?: (attempts: number) => number;
  /** How often to call store.sync() when the store has one. Default 60 s (GUESS); 0 turns it off. */
  syncEveryMs?: number;
  /** How often to sweep crash debris from the journal. Default 1 h. */
  sweepEveryMs?: number;
  /**
   * Prompt injection (injection.ts). Every report is neutralized (invisible characters removed,
   * hidden HTML comments shown) and screened by patterns. `screen` adds a screen of your own, e.g.
   * anthropicScreen(), which also reads the pictures. A hit is flagged — the `suspiciousLabel` and a
   * warning at the top of the issue, and no model is asked for its title — unless onSuspicious is
   * 'refuse' (or your screen says refuse): then it is set aside in refused/ with the reasons.
   */
  screen?: ScreenReport | null;
  onSuspicious?: 'flag' | 'refuse';
  /** Default 'suspicious'. */
  suspiciousLabel?: string;
  /** GUESS: a screen is worth a few seconds, like a title. A screen that fails or times out flags the report. */
  screenTimeoutMs?: number;
  /** After an issue is filed (notify a channel, kick an agent). Errors are logged and ignored. */
  onFiled?: (issue: Issue, entry: JournalEntry) => unknown;
  logger?: Pick<Console, 'warn' | 'info'>;
  /** Monotonic milliseconds for backoff; a wall-clock step never stalls or floods retries. */
  clock?: () => number;
}

export interface IngestResult { filed: number; refused: number; failed: number; waiting: number }

export interface Ingester {
  readonly journal: Journal;
  /** One pass now, or one more after the running one. Never throws. */
  runOnce(): Promise<IngestResult>;
  /** Ask for a pass soon (after the current tick), without waiting for it. */
  kick(): void;
  /** Start the timers; the first pass runs at once. Idempotent. */
  start(): Ingester;
  stop(): void;
  /** Per-entry retry state, for a status page. */
  retries(): Array<{ clientId: string; attempts: number; nextInMs: number; lastError: string }>;
}

const BACKOFF = [2_000, 10_000, 30_000, 120_000];
export const defaultBackoff = (attempts: number) => BACKOFF[Math.max(0, Math.floor(attempts) - 1)] ?? 300_000;

export function createIngester(options: IngesterOptions): Ingester {
  const journal = typeof options.journal === 'string' ? createJournal(options.journal) : options.journal;
  const { store } = options;
  const log = options.logger ?? console;
  const clock = options.clock ?? (() => performance.now());
  const backoff = options.backoff ?? defaultBackoff;
  const generate = options.generateTitle === undefined ? defaultGenerateTitle() : options.generateTitle;
  const titleTimeout = options.titleTimeoutMs ?? 15_000;

  const retry = new Map<string, { attempts: number; nextAt: number; lastError: string }>();
  /** A generated title, kept so a retry does not pay for (or change) it again. */
  const titles = new Map<string, string>();
  const screened = new Map<string, ScreenVerdict>();
  const screen = options.screen ?? null;
  const onSuspicious = options.onSuspicious ?? 'flag';
  const suspiciousLabel = options.suspiciousLabel ?? 'suspicious';
  const screenTimeout = options.screenTimeoutMs ?? 20_000;
  let pausedUntil = 0;
  let running: Promise<IngestResult> | null = null;
  let again = false;
  const timers: Array<ReturnType<typeof setInterval>> = [];

  async function titleOf(entry: JournalEntry, draft: Omit<IssueDraft, 'title'>, flagged: boolean): Promise<string> {
    const given = neutralize(entry.request.title).text.trim();
    if (given) return given;
    const cached = titles.get(entry.clientId);
    if (cached) return cached;
    const bodyText = draft.body;
    let title = '';
    // A flagged report is not handed to a model: the first sentence names it.
    if (generate && !flagged) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), titleTimeout);
      try {
        title = sanitizeTitle(await generate({
          clientId: entry.clientId, body: bodyText, page: entry.request.page, kind: entry.request.kind,
          priority: entry.request.priority, context: entry.request.context, attachments: draft.attachments ?? [],
        }, ac.signal));
      } catch (err) {
        log.warn(`[feedback] title generation failed for ${entry.clientId}; using the first sentence: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    // The first sentence; else the first line with a letter in it (an image's name, say); else "Untitled".
    title ||= titleFrom(bodyText) || sanitizeTitle(bodyText.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')) || 'Untitled';
    titles.set(entry.clientId, title);
    return title;
  }

  async function reporterOf(entry: JournalEntry): Promise<Reporter> {
    if (!options.identify) {
      return entry.reporter ? { handle: entry.reporter, verification: 'session' } : { handle: 'unknown', verification: 'no session' };
    }
    const who = await options.identify(entry.reporter, entry);
    return who ?? { handle: 'unknown', verification: 'no user resolved' };
  }

  /** The patterns, then the app's own screen. A screen that throws or times out flags: never file unscreened, never drop. */
  async function screenOf(input: ScreenInput, title: string): Promise<ScreenVerdict> {
    const found = patternScreen({ body: `${title}\n${input.body}`, context: input.context });
    const reasons = [...found.reasons];
    let refuse = false;
    if (screen) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), screenTimeout);
      try {
        const v = await screen(input, ac.signal);
        if (v.action !== 'file') reasons.push(...v.reasons.filter((x) => !reasons.includes(x)));
        refuse = v.action === 'refuse';
      } catch (err) {
        reasons.push('the screen could not run');
        log.warn(`[feedback] screening failed for ${input.clientId}; flagging it: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    if (!reasons.length) return { action: 'file', reasons };
    return { action: refuse || onSuspicious === 'refuse' ? 'refuse' : 'flag', reasons };
  }

  async function fileOne(entry: JournalEntry): Promise<Issue> {
    const reporter = await reporterOf(entry);
    const { attachments, missing } = await journal.attachments(entry);
    const r = entry.request;
    const cleaned = neutralize(r.body.trim());
    const context = {
      ...r.context, journaledAt: entry.receivedAt, reporter: reporter.handle, reporterVerification: reporter.verification,
      ...(missing ? { missingAttachments: missing } : {}),
    };
    const verdict = screened.get(entry.clientId) ?? await screenOf(
      { clientId: entry.clientId, body: r.body, page: r.page, kind: r.kind, context: r.context, attachments }, r.title);
    // Kept, like a title, so a retry neither pays again nor changes its mind.
    screened.set(entry.clientId, verdict);
    if (verdict.action === 'refuse') throw new RefusedError(`Refused as a possible prompt injection: ${verdict.reasons.join('; ')}`);
    const flagged = verdict.action === 'flag';
    const body = cleaned.text || '(no description given)';
    const base: Omit<IssueDraft, 'title'> = {
      body: flagged ? `${flagNote(verdict.reasons)}\n${body}` : body,
      kind: r.kind, priority: r.priority, reporter: reporter.handle, page: r.page,
      labels: flagged ? [suspiciousLabel] : [],
      context: {
        ...context,
        ...(cleaned.changes.length || flagged ? { screening: { ...(flagged ? { flagged: verdict.reasons } : {}), ...(cleaned.changes.length ? { neutralized: cleaned.changes } : {}) } } : {}),
      },
      attachments, tokenOffset: r.imageOffset, clientId: entry.clientId, receivedAt: entry.receivedAt,
    };
    return store.create({ ...base, title: await titleOf(entry, { ...base, body }, flagged) });
  }

  async function pass(): Promise<IngestResult> {
    const result: IngestResult = { filed: 0, refused: 0, failed: 0, waiting: 0 };
    for (const id of await journal.pending()) {
      const now = clock();
      if (now < pausedUntil) break;
      const due = retry.get(id);
      if (due && due.nextAt > now) continue;
      const read = await journal.read(id);
      if (!read) continue; // filed by another pass a moment ago
      if (!read.ok) {
        await journal.markRefused(id, read.reason);
        result.refused += 1;
        log.warn(`[feedback] ${id} set aside in refused/: ${read.reason}`);
        continue;
      }
      const entry = read.entry;
      try {
        const issue = await fileOne(entry);
        await journal.markFiled(entry, { id: issue.id, location: issue.location, title: issue.title });
        retry.delete(id);
        titles.delete(id);
        screened.delete(id);
        result.filed += 1;
        if (options.onFiled) {
          try { await options.onFiled(issue, entry); } catch (err) { log.warn(`[feedback] onFiled failed for ${issue.id}: ${err instanceof Error ? err.message : String(err)}`); }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof RefusedError) {
          await journal.markRefused(id, message, entry);
          retry.delete(id);
          screened.delete(id);
          result.refused += 1;
          log.warn(`[feedback] refused ${id}: ${message}`);
          continue;
        }
        result.failed += 1;
        const attempts = (due?.attempts ?? 0) + 1;
        const wait = Math.max(backoff(attempts), err instanceof RetryLaterError ? err.retryAfterMs : 0);
        retry.set(id, { attempts, nextAt: clock() + wait, lastError: message });
        // Once per entry and message, not every pass: a stuck store must not flood the log.
        if (due?.lastError !== message) log.warn(`[feedback] ${id} stays journaled; retry ${attempts} in ${Math.round(wait / 1000)} s: ${message}`);
        // The store asked everyone to wait (a rate limit), not just this entry.
        if (err instanceof RetryLaterError) pausedUntil = clock() + err.retryAfterMs;
      }
    }
    result.waiting = (await journal.pending()).length;
    return result;
  }

  const ingester: Ingester = {
    journal,
    runOnce() {
      if (running) {
        again = true;
        return running;
      }
      const run = (async () => {
        let last: IngestResult = { filed: 0, refused: 0, failed: 0, waiting: 0 };
        try {
          do {
            again = false;
            last = await pass();
          } while (again);
        } catch (err) {
          log.warn(`[feedback] ingest pass failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return last;
      })();
      running = run;
      void run.finally(() => { if (running === run) running = null; });
      return run;
    },
    kick() {
      setImmediate(() => { void ingester.runOnce(); });
    },
    start() {
      if (timers.length > 0) return ingester;
      const every = (ms: number, fn: () => void) => {
        if (ms <= 0) return;
        const t = setInterval(fn, ms);
        t.unref?.();
        timers.push(t);
      };
      every(options.everyMs ?? 10_000, () => { void ingester.runOnce(); });
      if (store.sync) {
        every(options.syncEveryMs ?? 60_000, () => {
          void store.sync!().catch((err) => log.warn(`[feedback] sync failed: ${err instanceof Error ? err.message : String(err)}`));
        });
      }
      every(options.sweepEveryMs ?? 3_600_000, () => { void journal.sweep().catch(() => undefined); });
      // What a restart left in the journal files now, with no request needed.
      ingester.kick();
      return ingester;
    },
    stop() {
      for (const t of timers.splice(0)) clearInterval(t);
    },
    retries() {
      const now = clock();
      return [...retry].map(([clientId, r]) => ({ clientId, attempts: r.attempts, nextInMs: Math.max(0, r.nextAt - now), lastError: r.lastError }));
    },
  };
  return ingester;
}

const registry = ((globalThis as typeof globalThis & { __feedbackKitIngesters?: Map<string, Ingester> })
  .__feedbackKitIngesters ??= new Map<string, Ingester>());

/**
 * The ingester for this journal, started once per process. Call it from Next's instrumentation.ts
 * `register()`, a worker's main, or next to your HTTP server. A second call returns the first ingester.
 */
export function startIngester(options: IngesterOptions): Ingester {
  const dir = typeof options.journal === 'string' ? options.journal : options.journal.dir;
  const existing = registry.get(dir);
  if (existing) return existing;
  const ingester = createIngester(options).start();
  registry.set(dir, ingester);
  return ingester;
}

/** The running ingester for a journal folder, if any (the handler uses it to kick after a write). */
export const ingesterFor = (dir: string): Ingester | undefined => registry.get(dir);

/** Stop and forget every registered ingester (tests, hot reload). */
export function stopIngesters(): void {
  for (const i of registry.values()) i.stop();
  registry.clear();
}
