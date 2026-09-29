/**
 * The server side of the example: @jbenet/feedback-server, wired for Next.js.
 *
 * Imported straight from the workspace's source (../../packages/feedback-server/src) so the
 * example always runs against the code beside it. In your app, depend on the package and import
 * `@jbenet/feedback-server` and `@jbenet/feedback-server/next` instead.
 *
 * Reports are journaled under FEEDBACK_DATA (default .data/) and filed as markdown files by the
 * ingester, which runs in this process. No model is called for titles here (generateTitle: null),
 * so a title is the first line of the report; set one up per packages/feedback-server/README.md.
 */
import { join, resolve } from 'node:path';
import { createFeedbackHandler, type FeedbackHandler } from '../../../packages/feedback-server/src/handlers.ts';
import { startIngester } from '../../../packages/feedback-server/src/ingest.ts';
import { fileStore, type FileStore } from '../../../packages/feedback-server/src/stores/files.ts';
import { DEMO_USER_COOKIE, demoUser } from './users';

const root = resolve(process.env.FEEDBACK_DATA ?? join(process.cwd(), '.data'));
export const journalDir = join(root, 'inbox');
export const issuesDir = join(root, 'issues');

interface Wired { store: FileStore; handler: FeedbackHandler }
const g = globalThis as typeof globalThis & { __feedbackExample?: Wired };

/** One store, one handler and one ingester per server process, however often Next loads this module. */
export function feedback(): Wired {
  if (g.__feedbackExample) return g.__feedbackExample;
  const store = fileStore({ dir: issuesDir, destination: `Markdown files in ${issuesDir}` });
  startIngester({ journal: journalDir, store, generateTitle: null, everyMs: 5_000 });
  const handler = createFeedbackHandler({
    journal: journalDir,
    store,
    // Who is filing comes from the session — here, the demo's user cookie — never from the body.
    resolveReporter: (req) => {
      const cookie = req.headers.get('cookie') ?? '';
      const handle = new RegExp(`(?:^|;\\s*)${DEMO_USER_COOKIE}=([^;]+)`).exec(cookie)?.[1];
      return demoUser(handle ? decodeURIComponent(handle) : null).handle;
    },
  });
  g.__feedbackExample = { store, handler };
  return g.__feedbackExample;
}
