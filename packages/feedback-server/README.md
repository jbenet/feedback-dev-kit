# @jbenet/feedback-server

The server half of feedback-kit: a feedback endpoint that writes each report to disk before it
answers, a background ingester that files the reports, and three places to file them — markdown files,
files plus SQLite or Postgres, or files plus GitHub Issues. TypeScript, Node 20 or later, no runtime
dependencies. The database drivers and the Anthropic SDK are optional peer dependencies.

The design and the reasons behind it are in [docs/SERVER.md](../../docs/SERVER.md). This README covers
the API and setup.

```
POST /api/feedback ─▶ validate ─▶ journal/<clientId>.json (+ pictures) ─▶ 202
                                        │  kick · start-up · every 10 s
                                        ▼
                                   ingester ─▶ identify ─▶ title ─▶ store.create ─▶ journal/filed/
```

## Install

```sh
npm install @jbenet/feedback-server
npm install better-sqlite3          # only for the SQLite store
npm install pg                      # only for the Postgres store
npm install @anthropic-ai/sdk       # only for LLM titles
```

## Quick start (Next.js, files store)

```ts
// lib/feedback.ts
import { createFeedbackHandler, fileStore, startIngester } from '@jbenet/feedback-server';
import { getSession } from './auth';                 // yours

const journal = 'data/issues/inbox';
const store = fileStore({ dir: 'data/issues' });

export const feedback = createFeedbackHandler({
  journal,
  store,
  // From your session: fast, and never a database round trip. Never from the request body.
  resolveReporter: (req) => getSession(req.headers.get('cookie'))?.handle ?? null,
  authorize: (req) => Boolean(getSession(req.headers.get('cookie'))),   // for the issue reads and PATCH
});
export const startFeedbackIngester = () => startIngester({ journal, store });
```

```ts
// app/api/feedback/[[...path]]/route.ts   (the same three lines in app/api/issues/[[...path]]/route.ts)
import { nextRoutes } from '@jbenet/feedback-server/next';
import { feedback } from '@/lib/feedback';
export const { GET, POST, PATCH } = nextRoutes(feedback);
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
```

```ts
// instrumentation.ts — Next calls register() once per server process. Never await: a slow disk or a
// busy database must not hold the start.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  void import('./lib/feedback').then((m) => m.startFeedbackIngester()).catch(() => undefined);
}
```

With plain Node:

```ts
import { createServer } from 'node:http';
import { toNodeListener } from '@jbenet/feedback-server/node';
createServer(toNodeListener(feedback, { fallback: yourApp })).listen(3000);
startFeedbackIngester();
```

## HTTP API

| Route | What |
|---|---|
| `POST /api/feedback` | Journal a report. 202 `{ journaled: true, clientId, repeat, id? }` once it is on disk. |
| `GET /api/feedback?clientId=…` | `{ state: 'journaled' }`, `{ state: 'filed', id, location }`, `{ state: 'refused', error }`, or 404 `{ state: 'unknown' }`. Reads the journal only. |
| `GET /api/feedback/export?since=<ISO with zone>` | `{ items: Issue[] }` created after `since`. `Authorization: Bearer $FEEDBACK_EXPORT_TOKEN`; 404 when unset, 401 when wrong, 400 for a bad `since`. |
| `GET /api/issues` | `{ issues: Issue[], destination, store }`, newest first. Optional `status`, `kind`, `priority` (comma lists), `q`. |
| `GET /api/issues/:id` | `{ issue }` or 404. |
| `PATCH /api/issues/:id` | `{ status?, priority?, kind?, labels? }` → `{ issue }`. Same-origin only. Records `closed_at` on done and clears it on reopen. |
| `GET /api/issues/attachments/<path>` | The picture, with its type, `nosniff` and `no-store`. Anything outside `attachments/`, or not a PNG/JPEG/GIF/WebP, is 404. |

The issue routes are also served under `/api/feedback/issues…` and `/api/feedback/attachments/…`, so
one catch-all route can carry everything. Paths are set by `basePath` and `issuesPath`.

**POST body.** This is the PL LabOS tools request without the title:
`{ clientId, body, kind?, priority?, page, context, screenshots: [pngDataUrl], images: [{ name?, dataUrl }], imageOffset }`.
The server also accepts `client_id`, an optional `title` (from agents filing through the API), and
`attachments: [{ kind, name?, dataUrl }]` in place of `screenshots` plus `images`. See
[REBUILD.md §2](../../docs/REBUILD.md#2-the-wire-contract).

**POST answers.**

| Status | When |
|---|---|
| 202 | Journaled, or already known (`repeat: true`, plus `id` once filed). |
| 400 | The body is not JSON, the client id is malformed, there are no words, or a picture has the wrong type. |
| 403 | The Origin is not this server's, or this server does not file (`accept: false`). |
| 413 | The request, one picture, all pictures, the picture count, the body, or the context is too large. |
| 422 | This client id was refused for good (`{ error, state: 'refused' }`). |
| 429 | Over the per-reporter rate limit. Resending a known client id is always free. |
| 500 | The disk write failed. The report is still in the browser, which resends it. |

## Options

### `createFeedbackHandler(options)`

| Option | Default | |
|---|---|---|
| `journal` | required | A `Journal` or its folder. |
| `store` | none | Needed for the issue reads, PATCH and the export. |
| `resolveReporter(req)` | none | Returns the reporter's handle or id from your session (a cookie, a header your auth proxy sets; nothing that waits on a database). **Supply it**: without it every issue is filed as `unknown`. A throw counts as null, so a report is never lost to a session lookup. |
| `origin` | same origin | `{ allowed: ['https://app.example'], allowMissing }`, or `false` for non-browser clients behind other auth. Compares against the `Host` header. `X-Forwarded-Host` is never trusted. |
| `limits` | see `DEFAULT_LIMITS` | 48 MB request, 12 M base64 characters per picture, 40 M for all pictures, 20 pictures, 60,000 body characters, 64 KB context. Every value is a GUESS. |
| `rateLimit` | `{ perMinute: 30 }` | New reports per reporter, in memory. Anonymous senders are keyed by `x-real-ip` / `x-forwarded-for`, which a client can set, so put a real limit in your proxy. |
| `accept` | `true` | `false` (or a function) answers 403 with `refusalMessage`. Use this on every server that must not file: only one server may hand out numbers. |
| `exportToken` | `$FEEDBACK_EXPORT_TOKEN` | |
| `authorize(req, action)` | allow all | `action` is `'read'`, `'update'` or `'attachment'`. Return true, false (403) or your own Response (a 401, say). Issues can hold anything a reporter saw: **supply this**, as you supply `resolveReporter`, or every issue and picture is readable by anyone who can reach the server. The example's is a demo "sign in as" cookie, which is not authentication. |
| `onSuspicious` | `'flag'` | `'refuse'` answers 422 when the report matches the prompt-injection patterns ([Prompt injection](#prompt-injection)); the browser keeps it and shows the reason. `'flag'` leaves it to the ingester. |
| `onJournaled(clientId)` | kick the ingester | |

### `startIngester(options)` / `createIngester(options)`

`startIngester` starts one ingester per journal folder per process; a second call returns the first.
`createIngester` returns one without timers, for tests and workers (`runOnce()`, `kick()`, `start()`,
`stop()`, `retries()`).

| Option | Default | |
|---|---|---|
| `journal`, `store` | required | |
| `generateTitle` | Claude if `FEEDBACK_TITLE_API_KEY` or `ANTHROPIC_API_KEY` is set | `(input, signal) => Promise<string \| null>`. `null` turns it off. The fallback is the first sentence (80 characters at most); failing that, the first line with a letter in it (an image's name); failing that, "Untitled". |
| `titleTimeoutMs` | 15 s | |
| `identify(selector, entry)` | none | Resolves the captured reporter off the request, for example with a database lookup. Throw on a failed lookup: the entry stays journaled and is retried. Return null only when the lookup worked and found nobody; the issue is then filed as `unknown`. |
| `everyMs` | 10 s | Passes also run at start-up and after each journal write. |
| `backoff(attempts)` | 2 s, 10 s, 30 s, 2 min, then every 5 min | Per entry. A store's `RetryLaterError` waits at least as long as it asks and pauses the pass. |
| `syncEveryMs` | 60 s | For stores with `sync()` (GitHub). |
| `screen` | none | An extra prompt-injection screen, `(input, signal) => Promise<{ action, reasons }>`; `anthropicScreen()` reads the pictures too. The patterns always run. |
| `onSuspicious` | `'flag'` | `'refuse'` sets a suspicious report aside in `refused/` instead of filing it flagged. |
| `suspiciousLabel` | `suspicious` | |
| `screenTimeoutMs` | 20 s | A screen that fails or times out flags the report. |
| `onFiled(issue, entry)` | none | Use it to notify a channel or start an agent. |

### Titles

```ts
import { anthropicTitle } from '@jbenet/feedback-server';
startIngester({ journal, store, generateTitle: anthropicTitle({ model: 'claude-haiku-4-5' }) });
```

- Environment: `FEEDBACK_TITLE_API_KEY` (read first) or `ANTHROPIC_API_KEY`, and `FEEDBACK_TITLE_MODEL`
  (default `claude-haiku-4-5`).
- It sends the body, the page, the kind and the first screenshot. Turn the screenshot off with
  `includeScreenshot: false` or `FEEDBACK_TITLE_SCREENSHOT=0`.
- **All of that leaves your server.** Leave the key unset when reports may hold data that must not go to
  a third party.
- The title is made once per report, kept across retries, and cleaned: one line, no quotes, 80
  characters at most.
- A title the sender typed is kept as given, and no model is called.
- It runs in the ingester, never on the request.

### Prompt injection

A report is written by whoever can reach the box and read by people and agents. Every report is
**neutralized** before filing (invisible characters removed; HTML comments, which GitHub hides, shown as
text) and **screened** by patterns for the usual shapes of an injection: asks to ignore instructions,
role changes, chat markup, commands to run, requests to send secrets, text addressed to an AI.

```ts
import { anthropicScreen } from '@jbenet/feedback-server';
startIngester({ journal, store, screen: anthropicScreen() });   // also reads text in screenshots
```

- **Flagged** (default): the issue gets the `suspicious` label, a warning at the top of its body, the
  reasons in `context.screening`, and a first-sentence title (no model reads it for a title).
- **Refused** (`onSuspicious: 'refuse'` on the ingester, or a screen that says so): set aside in
  `refused/` with the reasons. On the handler, `onSuspicious: 'refuse'` answers 422 at once instead.
- The patterns are heuristics. They also flag some honest reports that talk about prompts, which is
  why the default flags and a person decides.
- `anthropicScreen()` sends the text and up to four pictures to Anthropic's API (`FEEDBACK_SCREEN_API_KEY`,
  then `ANTHROPIC_API_KEY`; `FEEDBACK_SCREEN_MODEL`, default `claude-haiku-4-5`). Without a key it says
  nothing and the patterns decide.
- `neutralize()`, `screenText()` and `patternScreen()` are exported for readers: an agent reading the
  queue checks again, since an issue can be edited after filing. How agents treat issues is in
  [docs/TRIAGE.md §10](../../docs/TRIAGE.md#10-untrusted-input-prompt-injection).

## Stores

Every store implements `FeedbackStore` (`create`, `list`, `get`, `update`, `readAttachment`, optional
`sync`) and dedupes on the client id. A store throws `RefusedError` for a report that can never be
filed, and `RetryLaterError(ms)` to ask for a wait. Any other throw is retried. A report is never
dropped.

### Files (the PL LabOS tools format)

```ts
const store = fileStore({ dir: 'data/issues' });
```

Each issue is `NNNN-slug.md`: a hand-written frontmatter, the markdown body, one `![Screenshot]` line
per screenshot, and a `json context` block. Pictures go in `attachments/NNNN-screenshot.png` and
`NNNN-image-1.jpg`. Lines the store does not manage (`client_id:`, `assignee:`, `branch:`,
`fixed_in:`) survive every rewrite. `status: review` reads as done. Numbers come from reading the
folder inside a per-process lock, so **exactly one process may file into a folder**. Keep the folder
out of git if issues may hold confidential data.

### Files + SQL (SQLite or Postgres)

```ts
import Database from 'better-sqlite3';
import pg from 'pg';
import { sqlStore, sqliteDriver, pgDriver } from '@jbenet/feedback-server/sql';

const db = new Database('data/feedback.db');
db.pragma('journal_mode = WAL');
const store = sqlStore({ db: sqliteDriver(db), dir: 'data/issues' });
// or
const store = sqlStore({ db: pgDriver(new pg.Pool({ connectionString: process.env.DATABASE_URL })), dir: 'data/issues' });
```

- `sqliteDriver` takes better-sqlite3 or `node:sqlite`'s `DatabaseSync`. `pgDriver` takes a `pg.Pool`,
  one `pg.Client`, or PGlite.
- Migrations (`MIGRATIONS`, recorded in `feedback_migrations`) run on first use. Call `migrate(driver)`
  yourself and pass `autoMigrate: false` if you manage schema elsewhere. The tables are
  `feedback_issue` and `feedback_migrations`: text and JSON on SQLite; `jsonb`, `timestamptz` and CHECK
  constraints on Postgres.
- The database gives out the numbers, under a table lock, and `client_id` is UNIQUE. Several
  ingesters can share one database.
- The markdown and pictures are still written, after the row commits. A crash between the two leaves
  `files_written = false`, and the retry writes them.

### Files + GitHub Issues

```ts
import { githubStore } from '@jbenet/feedback-server/github';
const store = githubStore({
  repo: 'acme/app',
  dir: 'data/issues',                                  // the local mirror
  attachments: { mode: 'local', baseUrl: 'https://app.example/api/issues' },
});
```

- **Token.** Set `FEEDBACK_GITHUB_TOKEN` in the server's environment (`GITHUB_TOKEN` is read too).
  Least privilege: create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
  (or a GitHub App installation token) for this one repository with **Issues: read and write**;
  Metadata: read comes with it. Add Contents: read and write only for `repo` pictures, and only on
  the assets repository. Avoid classic tokens: `repo` scope reaches every repository you can. The
  `token` option overrides the environment, as a string or a function asked before each request (for
  a GitHub App's rotating token). With no token, reports wait in the journal.
- **Issues.** Each report becomes an issue with the labels `feedback`, `kind:*`, `priority:*` and
  `status:*`, created on first use. The reporter, page and captured context go in the body, with a
  hidden `<!-- feedback-kit client_id: … -->` marker. A body over 65,536 characters is cut with a note;
  the mirror keeps it whole.
- **Idempotency.** Before creating, the store checks the mirror, then lists the repository's issues
  updated since the report arrived, minus 10 minutes for clock skew, and looks for the marker. It uses
  the listing endpoint, not search: search lags, and a retry after a crash would file a duplicate.
- **The mirror.** A files-format copy of each issue, named by the GitHub number. The issues page reads
  it and never spends rate limit. Its pictures are in `attachments/<clientId>/report-screenshot.png`,
  which differs from the files store, because the pictures are saved before GitHub assigns a number.
- **Status.** `update()` sets the labels and closes the issue on done. `sync()`, run from the
  ingester every 60 s, pulls changes back: closed means done, an open issue takes its `status:*` label,
  and a done issue reopened on GitHub becomes open. Its cursor is GitHub's own `updated_at`, never this
  server's clock.
- **Rate limits.** Content-creating requests are spaced 1 s apart. On a 403 or 429, `retry-after` wins,
  then `x-ratelimit-reset` measured against GitHub's `Date` header, clamped to 1 s – 15 min. Waits up to
  60 s are taken inline; longer ones become a `RetryLaterError` that the ingester's backoff honours.

**Pictures and privacy.** A screenshot shows whatever was on the reporter's screen: names, amounts,
private notes, other people's data. Anyone who can read the issues repository can read the issue
body, which for a public repository means everyone. A file committed to a repository stays in its git
history after the issue is closed or deleted. Choose the mode deliberately:

| `attachments.mode` | Pictures | Readable by |
|---|---|---|
| `local` (default) | Stay on your server. With `baseUrl`, the issue links to your `/api/issues/attachments/…` route, which requires your app's own auth. | People who can sign in to your app |
| `repo` | Uploaded to `path/<clientId>/` in `repo`, on `branch` (made on first use with no shared history, when it does not exist) or the default branch. Uses the REST contents API with the token (Contents: read and write), no git checkout. Only pictures the body still shows are uploaded; images removed from the text stay local. | Whoever can read that repository, and its history forever |
| `none` | Stay on your server. The issue says only how many there are. | Nobody on GitHub |
| `custom` | Handed to your `upload(picture)`, which stores it anywhere and returns the URL the issue embeds (or null to keep that one local). Only pictures the body still shows are handed over. | Whoever can open the URL you return |

The report text always goes to GitHub. Do not use this store for apps whose screens or reports carry
confidential data.

**Getting pictures to GitHub another way.** The kit uses `repo` because it works with the issue token
alone. GitHub's web interface puts dragged-in pictures on `github.com/user-attachments/…`, but that
upload has no public API and only accepts a signed-in browser session, not a token, so a server
cannot use it. To send pictures somewhere else — your own bucket or CDN, a GitHub release asset
(`POST https://uploads.github.com/repos/{owner}/{repo}/releases/{id}/assets`, also Contents: write), an
image host — pass `custom` and do the upload yourself:

```ts
import { githubStore, type PictureUpload } from '@jbenet/feedback-server/github';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const store = githubStore({
  repo: 'acme/app',
  dir: 'data/issues',
  attachments: {
    mode: 'custom',
    // Called once per picture the report shows. Return the URL the issue embeds, or null to keep
    // the picture on your server. Throwing retries the whole report later, so a report is never
    // filed with pictures half sent.
    upload: async (p: PictureUpload) => {
      const key = `feedback/${p.clientId}/${p.name}`;
      await s3.send(new PutObjectCommand({ Bucket: 'acme-feedback', Key: key, Body: p.bytes, ContentType: p.contentType }));
      return `https://feedback-cdn.acme.example/${key}`;
    },
  },
});
```

`p` carries `clientId`, `name` (as in the local mirror, `report-screenshot.png`), `kind`
(`screenshot` or `image`), `contentType` and `bytes`. Keep uploads idempotent by that key: a report
that fails later is sent again with the same client id and names. The example app picks the mode
from `FEEDBACK_GITHUB_PICTURES` in `examples/next-app/lib/feedback.ts`; add a branch there for yours.

## The journal

```
<journal>/<clientId>.json                        journaled, not yet filed
<journal>/files/<clientId>.<nonce>/N-kind.ext    its pictures, decoded, written before the entry
<journal>/filed/<clientId>.json                  filed: issue id, location, title; no pictures
<journal>/refused/<clientId>.json (+ files/)     never fileable, kept whole with the reason
```

- **The request path never touches the database.** It checks the Origin and sizes, validates, writes
  one entry and answers. The reason: the database, the auth layer and the event loop are what is busy
  when a report matters most. A test walks `handlers.ts`'s static imports and fails if one reaches a
  store or a package.
- **Crash safety.** Each write goes to a temporary, is fsynced, and is committed by hard link (the first
  writer wins; rename where links are unsupported), then the folder is fsynced. The pictures are
  fsynced before the entry that names them exists. A kill at any moment leaves either nothing (the
  browser resends) or a whole entry with all its pictures. Stray temporaries and orphaned picture
  folders are swept after an hour.
- **Duplicate client ids** write nothing. Concurrent sends in one process share one write; across
  processes, the hard link lets exactly one win. The client id is `^[A-Za-z0-9-]{8,64}$` because it names
  a file.
- **Clocks.** `receivedAt` is the server's time and orders the inbox. Backoff uses a monotonic clock.
  An issue's `created` is when it was filed, with milliseconds, so an export cursor never skips a
  report that waited in the journal.
- **Filing.** The record goes to `filed/` first, then the entry is removed. A crash between the two
  makes the next pass file again, and the store answers with the issue it already has.

## Environment variables

| Variable | Read by | |
|---|---|---|
| `FEEDBACK_EXPORT_TOKEN` | `createFeedbackHandler` | Enables `GET /api/feedback/export` with this bearer token. Unset: 404. |
| `FEEDBACK_TITLE_API_KEY`, then `ANTHROPIC_API_KEY` | `anthropicTitle`, the default `generateTitle` | Titles by Claude. Unset: no model is called. |
| `FEEDBACK_TITLE_MODEL` | `anthropicTitle` | Default `claude-haiku-4-5`. |
| `FEEDBACK_TITLE_SCREENSHOT` | `anthropicTitle` | `0` keeps the screenshot out of the title request. |
| `FEEDBACK_SCREEN_API_KEY`, then `ANTHROPIC_API_KEY`; `FEEDBACK_SCREEN_MODEL` | `anthropicScreen` | The model screen, when you pass it as `screen`. |
| `FEEDBACK_GITHUB_TOKEN`, then `GITHUB_TOKEN` | `githubStore` | The token for the issues repository. |

(`FEEDBACK_DATA` belongs to the example app, not the package: the folder it journals and files into.)

## Build

`npm run build` writes `dist/`: one ES module per source file (tsup) and its declarations (tsc). The
package's exports point there; `src/` ships too, for reading and source maps. Node 20 or later.

## Tests

```sh
npm test                                   # node:test on the TypeScript sources (Node ≥ 22.18)
PG_TEST_URL=postgres://… npm test          # also against a real, throwaway Postgres
```

The tests cover:

- journal atomicity under 20 concurrent writes;
- a child process SIGKILLed mid-write;
- crash debris and the sweep;
- idempotency before and after filing;
- ingest retries, backoff, rate-limit pauses, refusals and identify failures;
- titles;
- prompt injection: the patterns against attacks and honest reports, neutralizing, flag and refuse, the model screen;
- every store on better-sqlite3, `node:sqlite`, PGlite and optionally real Postgres;
- the GitHub store against a mocked fetch;
- size and origin refusals;
- both adapters.

All data in them is invented.
