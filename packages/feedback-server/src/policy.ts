/**
 * Who gets a fix. Anyone who can reach the feedback box can write to the queue, and agents with commit
 * rights read it, so who filed a report has to decide what an agent may do with it without asking a
 * person (docs/TRIAGE.md §3). The ingester asks the app's policy once per report and stamps the answer
 * on the issue, where every reader sees it and only a person can change it:
 *
 *   trust:implement   an agent may build a no-brainer fix (class A) for it without asking
 *   trust:triage      an agent classifies it, records it and leaves it for a person; it builds nothing
 *
 * The answer is a label (so it shows on GitHub and filters on the issues page) and `context.policy`
 * (with the role and the reason). A flagged report is always `trust:triage`, whatever the policy says.
 * The handler refuses a label change that adds, removes or swaps a `trust:` label, or removes the
 * `suspicious` label, unless authorize(req, 'moderate') allows it; the worker token never may.
 *
 * The default trusts a signed-in person to get a no-brainer fix, and nobody else: a report with no
 * session, an unresolved user, or another app over MCP is triage only. Pass your own to use roles:
 *
 *   policy: async ({ handle }) => (await roleOf(handle)) === 'viewer'
 *     ? { trust: 'triage', role: 'viewer', why: 'viewers are heard, not built for' }
 *     : { trust: 'implement', role: 'member' },
 */
import type { JournalEntry } from './types.ts';

export type Trust = 'implement' | 'triage';
export const TRUSTS: readonly Trust[] = ['implement', 'triage'];

/** The label a trust level is filed under. */
export const trustLabel = (trust: Trust) => `trust:${trust}`;
export const isTrustLabel = (label: string) => /^trust:/.test(label);

/** Who filed it, as the ingester resolved it. `via` is 'mcp' for another app, 'box' for the feedback box. */
export interface Submitter {
  handle: string;
  /** How the handle was established: 'session', 'no session', 'no user resolved', or what identify() said. */
  verification: string;
  via: 'box' | 'mcp';
}

export interface PolicyDecision {
  trust: Trust;
  /** The submitter's role in your app (admin, member, viewer, …), recorded for the triager. */
  role?: string;
  /** One line on why, recorded in context.policy. */
  why?: string;
}

/**
 * Decide per report. Throw when you cannot tell (a role lookup failed): the report stays journaled and
 * is retried, like a failed identify(). Anything other than a PolicyDecision is read as triage.
 */
export type SubmitterPolicy = (submitter: Submitter, entry: JournalEntry) => PolicyDecision | Promise<PolicyDecision>;

const UNVERIFIED = new Set(['no session', 'no user resolved']);

/** Signed-in people may get a no-brainer fix; strangers and other apps are heard and triaged. */
export const defaultPolicy: SubmitterPolicy = (s) => {
  if (s.via === 'mcp') return { trust: 'triage', role: 'app', why: 'filed by another app over MCP' };
  if (s.handle === 'unknown' || UNVERIFIED.has(s.verification)) return { trust: 'triage', role: 'anonymous', why: 'no verified reporter' };
  return { trust: 'implement', role: 'member', why: 'a signed-in reporter' };
};

/** A policy's answer, checked: anything malformed is triage. */
export function checkDecision(d: unknown): PolicyDecision {
  const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const trust: Trust = o.trust === 'implement' ? 'implement' : 'triage';
  const role = typeof o.role === 'string' && o.role.trim() ? o.role.trim().slice(0, 50) : undefined;
  const why = typeof o.why === 'string' && o.why.trim() ? o.why.trim().slice(0, 200) : undefined;
  return { trust, ...(role ? { role } : {}), ...(why ? { why } : {}) };
}
