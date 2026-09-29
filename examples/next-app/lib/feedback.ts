/**
 * The server side of the example: @jbenet/feedback-server, wired for Next.js.
 *
 * Reports are journaled under FEEDBACK_DATA (default .data/) and filed by the ingester, which runs in
 * this process: as markdown files by default, or as GitHub issues when FEEDBACK_GITHUB_REPO is set
 * (see githubToken below for the token). No model is called for titles here (generateTitle: null),
 * so a title is the first sentence of the report; set one up per packages/feedback-server/README.md.
 */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createFeedbackHandler, fileStore, startIngester, type FeedbackHandler, type FeedbackStore } from '@jbenet/feedback-server';
import { githubStore } from '@jbenet/feedback-server/github';
import { userFromCookieHeader } from './users';

// Data lives outside the build; tell Turbopack's file tracing not to follow these paths.
const root = resolve(/* turbopackIgnore: true */ process.env.FEEDBACK_DATA ?? join(/* turbopackIgnore: true */ process.cwd(), '.data'));
export const journalDir = join(root, 'inbox');
export const issuesDir = join(root, 'issues');
/** The GitHub store's local mirror. Its own folder: GitHub's numbers are not the files store's. */
export const githubDir = join(root, 'github');

interface Wired { store: FeedbackStore; handler: FeedbackHandler }
const g = globalThis as typeof globalThis & { __feedbackExample?: Wired };

/** One store, one handler and one ingester per server process, however often Next loads this module. */
export function feedback(): Wired {
  if (g.__feedbackExample) return g.__feedbackExample;
  const store = makeStore();
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

const shownRoot = process.env.FEEDBACK_DATA ? '$FEEDBACK_DATA' : '.data';

/** Markdown files, or GitHub issues when FEEDBACK_GITHUB_REPO names a repository. */
function makeStore(): FeedbackStore {
  const repo = process.env.FEEDBACK_GITHUB_REPO;
  // Shown on the issues pages. Named, not spelled out: an absolute path says more about the machine than the issues.
  if (!repo) return fileStore({ dir: issuesDir, destination: `Markdown files in ${shownRoot}/issues` });
  return githubStore({
    repo,
    destination: `GitHub issues in ${repo}, mirrored in ${shownRoot}/github`,
    dir: githubDir,
    token: githubToken,
    label: process.env.FEEDBACK_GITHUB_LABEL || undefined,
    // Pictures stay on this server; the issue links to them through this app's own (signed-in) route.
    attachments: { mode: 'local', baseUrl: `${appUrl()}/api/issues` },
  });
}

/**
 * FEEDBACK_GITHUB_TOKEN, then GITHUB_TOKEN; failing both, the GitHub CLI's login (`gh auth token`), so
 * the example files issues as whoever ran `gh auth login` on this machine. A deployed app sets a
 * fine-grained token for the one repository instead (packages/feedback-server/README.md).
 * Asked again on each pass until there is one: reports wait in the journal and file once you log in.
 */
let ghToken: string | undefined;
let warnedNoToken = false;
function githubToken(): string | undefined {
  const fromEnv = process.env.FEEDBACK_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  if (ghToken) return ghToken;
  try {
    ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || undefined;
  } catch { /* not installed, or not logged in */ }
  if (!ghToken && !warnedNoToken) {
    warnedNoToken = true;
    console.warn('[feedback] no GitHub token: set FEEDBACK_GITHUB_TOKEN or run `gh auth login`. Reports stay journaled until then.');
  }
  return ghToken;
}

/** Where readers of a GitHub issue reach this app, for the picture links. */
const appUrl = () => (process.env.FEEDBACK_APP_URL ?? `http://localhost:${process.env.PORT ?? 3172}`).replace(/\/$/, '');
