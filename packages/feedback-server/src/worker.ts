/**
 * One agent at a time works the feedback queue (docs/TRIAGE.md §8). A filing wakes a worker only when
 * none is running; while one is, new issues queue for it, and it hears of them by long-polling the
 * worker endpoint. A worker retires when the queue stays empty or it has run for maxAgeMs, and the
 * next filing wakes a fresh one, so no context lives forever and no two agents edit the same code.
 *
 *   const worker = createWorkerDispatch({ file: '.data/worker.json', wake: routineWake({ url, token }) });
 *   startIngester({ journal, store, onFiled: worker.onFiled });
 *   createFeedbackHandler({ journal, store, worker });   // serves GET/DELETE {base}/worker
 *
 * The lease is a small JSON file, so processes on one machine share it; the long-poll wakes on filings
 * in this process (where the ingester runs) and otherwise returns at its timeout, which is no worse.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { writeAtomic } from './fsutil.ts';
import type { Issue } from './types.ts';

export interface WorkerOptions {
  /** The lease file, e.g. `.data/worker.json`. */
  file: string;
  /** Start a fresh worker (routineWake, or your own). A throw leaves no lease: the next filing tries again. */
  wake: (issue: Issue) => Promise<void>;
  /** A worker not heard from in this long is gone. Default 30 minutes (GUESS: longer than one fix). */
  leaseMs?: number;
  /** A woken worker has this long to check in before another filing wakes a new one. Default 10 minutes. */
  wakeGraceMs?: number;
  /** After this, a worker is told to retire once it finishes what it holds. Default 3 hours. */
  maxAgeMs?: number;
  /** Longest long-poll. Default 9 minutes, under a 10-minute shell timeout. */
  maxWaitMs?: number;
  now?: () => number;
  logger?: Pick<Console, 'warn' | 'info'>;
}

export interface WorkerState {
  worker: { id: string; startedAt: number; seenAt: number } | null;
  /** When a wake was sent and not yet answered by a check-in. */
  wokenAt: number | null;
  /** The last filing, so a worker that leaves with unseen issues hands them on. */
  filedAt: number | null;
}

export type CheckIn =
  | { ok: true; retire: boolean; startedAt: string }
  | { ok: false; holder: string; seenAt: string };

export interface WorkerDispatch {
  /** For IngesterOptions.onFiled: wake a worker, or leave the issue queued for the running one. */
  onFiled(issue: Issue): Promise<'woken' | 'queued'>;
  /** A worker says it is alive. Another live worker holding the lease answers ok: false: exit. */
  checkIn(id: string): Promise<CheckIn>;
  /** Resolves on the next filing after `since` (ms), or after `ms`; true when something was filed. */
  waitForFiling(since: number, ms: number): Promise<boolean>;
  /** The worker is done. Issues filed since its last check-in wake a successor. */
  release(id: string): Promise<'released' | 'handed-on' | 'not-holder'>;
  state(): Promise<WorkerState>;
  readonly maxWaitMs: number;
  /** The clock the lease uses; cursors handed to the worker come from it. */
  readonly now: () => number;
}

const EMPTY: WorkerState = { worker: null, wokenAt: null, filedAt: null };

export function createWorkerDispatch(options: WorkerOptions): WorkerDispatch {
  const leaseMs = options.leaseMs ?? 30 * 60_000;
  const wakeGraceMs = options.wakeGraceMs ?? 10 * 60_000;
  const maxAgeMs = options.maxAgeMs ?? 3 * 60 * 60_000;
  const maxWaitMs = options.maxWaitMs ?? 9 * 60_000;
  const now = options.now ?? Date.now;
  const log = options.logger ?? console;
  const dir = dirname(options.file);
  const name = basename(options.file);
  const waiters = new Set<() => void>();
  let lastIssue: Issue | null = null;

  // One change at a time in this process: two filings in the same instant send one wake.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  async function read(): Promise<WorkerState> {
    try {
      const s = JSON.parse(await readFile(options.file, 'utf8')) as Partial<WorkerState>;
      return { ...EMPTY, ...s };
    } catch { return { ...EMPTY }; }
  }
  const write = (s: WorkerState) => writeAtomic(dir, name, `${JSON.stringify(s, null, 2)}\n`);
  const live = (s: WorkerState, t: number) => !!s.worker && t - s.worker.seenAt < leaseMs;
  const waking = (s: WorkerState, t: number) => s.wokenAt !== null && t - s.wokenAt < wakeGraceMs;

  /** Send a wake under the lock; on failure, take the mark back so the next filing tries again. */
  async function wake(s: WorkerState, issue: Issue): Promise<void> {
    const t = now();
    await write({ ...s, worker: live(s, t) ? s.worker : null, wokenAt: t });
    try {
      await options.wake(issue);
    } catch (err) {
      log.warn(`[feedback] waking a worker for ${issue.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      await write({ ...(await read()), wokenAt: null });
      throw err;
    }
  }

  return {
    maxWaitMs,
    now,
    state: read,
    onFiled: (issue) => serial(async () => {
      lastIssue = issue;
      const s = await read();
      const t = now();
      s.filedAt = t;
      for (const w of waiters) w();
      if (live(s, t) || waking(s, t)) { await write(s); return 'queued' as const; }
      await wake(s, issue);
      return 'woken' as const;
    }),
    checkIn: (id) => serial(async () => {
      const s = await read();
      const t = now();
      if (live(s, t) && s.worker!.id !== id) return { ok: false as const, holder: s.worker!.id, seenAt: new Date(s.worker!.seenAt).toISOString() };
      const startedAt = s.worker?.id === id && live(s, t) ? s.worker.startedAt : t;
      await write({ ...s, worker: { id, startedAt, seenAt: t }, wokenAt: null });
      return { ok: true as const, retire: t - startedAt >= maxAgeMs, startedAt: new Date(startedAt).toISOString() };
    }),
    waitForFiling: (since, ms) => new Promise<boolean>((resolve) => {
      void read().then((s) => {
        if (s.filedAt !== null && s.filedAt > since) return resolve(true);
        const done = (v: boolean) => { clearTimeout(timer); waiters.delete(hit); resolve(v); };
        const hit = () => done(true);
        const timer = setTimeout(() => done(false), Math.max(0, Math.min(ms, maxWaitMs)));
        waiters.add(hit);
      });
    }),
    release: (id) => serial(async () => {
      const s = await read();
      if (s.worker?.id !== id) return 'not-holder' as const;
      const unseen = s.filedAt !== null && s.filedAt > s.worker.seenAt;
      const cleared: WorkerState = { ...s, worker: null, wokenAt: null };
      await write(cleared);
      if (!unseen || !lastIssue) return 'released' as const;
      try { await wake(cleared, lastIssue); } catch { return 'released' as const; }
      return 'handed-on' as const;
    }),
  };
}

export interface RoutineWakeOptions {
  /** The routine's fire URL, from its API trigger (https://api.anthropic.com/v1/claude_code/routines/<id>/fire). */
  url: string;
  /** The routine's API trigger token. Keep it in your secret store, e.g. FEEDBACK_ROUTINE_TOKEN. */
  token: string;
  /** The fire text. Default: the issue's id and link, never its title or body (a reporter wrote those). */
  text?: (issue: Issue) => string;
  /** The beta header the fire endpoint ships under. */
  beta?: string;
  fetch?: typeof fetch;
}

/** A wake that fires a Claude Code routine (code.claude.com/docs/en/routines): one fresh session per fire. */
export function routineWake(options: RoutineWakeOptions): (issue: Issue) => Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const text = options.text ?? ((i: Issue) => `New feedback filed: ${i.id}${i.url ? ` (${i.url})` : ''}. Work the queue.`);
  return async (issue) => {
    const res = await doFetch(options.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'anthropic-beta': options.beta ?? 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: text(issue) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`the routine answered ${res.status}`);
  };
}
