/**
 * The server side of the example: @jbenet/feedback-server, wired for Next.js.
 *
 * Reports are journaled under FEEDBACK_DATA (default .data/) and filed as markdown files by the
 * ingester, which runs in this process. No model is called for titles here (generateTitle: null),
 * so a title is the first sentence of the report; set one up per packages/feedback-server/README.md.
 */
import { join, resolve } from 'node:path';
import { createFeedbackHandler, fileStore, startIngester, type FeedbackHandler, type FileStore } from '@jbenet/feedback-server';
import { userFromCookieHeader } from './users';

// Data lives outside the build; tell Turbopack's file tracing not to follow these paths.
const root = resolve(/* turbopackIgnore: true */ process.env.FEEDBACK_DATA ?? join(/* turbopackIgnore: true */ process.cwd(), '.data'));
export const journalDir = join(root, 'inbox');
export const issuesDir = join(root, 'issues');

interface Wired { store: FileStore; handler: FeedbackHandler }
const g = globalThis as typeof globalThis & { __feedbackExample?: Wired };

/** One store, one handler and one ingester per server process, however often Next loads this module. */
export function feedback(): Wired {
  if (g.__feedbackExample) return g.__feedbackExample;
  // Shown on the issues pages. Named, not spelled out: an absolute path says more about the machine than the issues.
  const store = fileStore({ dir: issuesDir, destination: `Markdown files in ${process.env.FEEDBACK_DATA ? '$FEEDBACK_DATA' : '.data'}/issues` });
  startIngester({ journal: journalDir, store, generateTitle: null, everyMs: 5_000 });
  const handler = createFeedbackHandler({
    journal: journalDir,
    store,
    // Who is filing comes from the session (here, the demo's sign-in cookie), never from the body.
    // Signed out, a report still files, as "unknown": a complaint is never lost to a login.
    resolveReporter: (req) => userFromCookieHeader(req.headers.get('cookie'))?.handle ?? null,
    // The issue reads, the pictures and status changes are for signed-in people only. Issues hold
    // whatever a reporter saw; a real app checks its own session and roles here.
    // `action` is 'read', 'attachment' or 'update'; every signed-in demo user may do all three.
    authorize: (req) => userFromCookieHeader(req.headers.get('cookie'))
      ? true
      : Response.json({ error: 'Sign in to see issues' }, { status: 401, headers: { 'cache-control': 'no-store' } }),
  });
  g.__feedbackExample = { store, handler };
  return g.__feedbackExample;
}
