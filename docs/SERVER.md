# The server side

What the server does with a report, why it is built this way, and how to run it against files, a
database, or GitHub Issues. The client side is in [REBUILD.md](REBUILD.md). The package is
`packages/feedback-server`; its README names the functions. This document is the contract they
implement.

Contents:

1. [The shape of it](#1-the-shape-of-it)
2. [API](#2-api)
3. [Journal first, file later](#3-journal-first-file-later)
4. [The journal on disk](#4-the-journal-on-disk)
5. [The ingester](#5-the-ingester)
6. [Titles](#6-titles)
7. [Stores](#7-stores)
8. [The issue file format](#8-the-issue-file-format)
9. [The export endpoint](#9-the-export-endpoint)
10. [Security](#10-security)
11. [The GitHub variant](#11-the-github-variant)
12. [Database or GitHub?](#12-database-or-github)

---

## 1. The shape of it

```
browser outbox ──POST /api/feedback──▶ validate ──▶ journal/<clientId>.json (+ pictures) ──202──▶ browser
                                                        │
                        kick after the response, at start-up, every 10 s
                                                        ▼
                                                    ingester ──▶ reporter lookup ──▶ title ──▶ store.create
                                                        │                                       │
                                     journal/filed/<clientId>.json ◀── moved when the store confirms
                                                                             │
                                          files (+ SQL row, audit)  or  GitHub issue (+ local mirror)
```

The request path touches the disk and nothing else. Everything slow or fallible (the database, the
identity lookup, an LLM title, GitHub's API) runs afterwards in the ingester, which retries.

## 2. API

All routes are relative to a configurable base. Next.js route handlers and a plain Node
`(req, res)` adapter are both provided.

### 2.1 `POST /api/feedback` — file a report

Request (JSON; see [REBUILD.md §2.1](REBUILD.md#21-post-baseapifeedback) for every field):

```json
{
  "clientId": "3f0a2c9e-6b1d-4b8e-9d2e-0c1f5a7b8e21",
  "body": "The Late tile counts an order that is still proofing.\n\n![late-tile.png](attachment:1)",
  "kind": "bug",
  "priority": "P2",
  "page": "/orders",
  "context": {
    "route": "/orders", "url": "https://app.example/orders?state=late",
    "filters": { "state": "late" },
    "client": { "userAgent": "…", "viewport": "1440×900", "pixelRatio": 2, "touch": false }
  },
  "screenshots": ["data:image/png;base64,…"],
  "images": [{ "name": "invented-chart.png", "dataUrl": "data:image/png;base64,…" }],
  "imageOffset": 1
}
```

Also accepted: `client_id` for `clientId`; an optional `title` (kept as given, for agents filing
through the API); and `attachments: [{ kind, name, dataUrl }]` as one list in token order instead of
`screenshots` + `images`.

Responses:

| Status | Body | When |
|---|---|---|
| 202 | `{ "journaled": true, "clientId": "…", "repeat": false }` | Written to the journal. |
| 202 | `{ "journaled": true, "clientId": "…", "repeat": true, "id": "0024" }` | A resend of a report already journaled (`id` present once filed). |
| 400 | `{ "error": "…" }` | Not JSON, malformed client id, no words, wrong image type. |
| 403 | `{ "error": "…" }` | Origin not allowed, or this server does not file ([§10](#10-security)). |
| 413 | `{ "error": "…" }` | The request, one picture (over 12,000,000 base64 characters), all pictures (over 40,000,000), more than 20 pictures, the body or the context is too large. |
| 422 | `{ "error": "…", "clientId": "…", "state": "refused" }` | This client id was refused for good earlier (the ingester set it aside in `refused/`); resending it cannot help. |
| 429 | `{ "error": "Too many reports in a minute. …", "clientId": "…" }`, `retry-after: 60` | Over the per-reporter rate limit ([§10](#10-security)). A resend of a client id the journal already knows is never limited. |
| 500 | `{ "error": "The server could not save it: … It is still in your browser and will be sent again." }` | The disk write failed. |

The browser's outbox treats 422 like any other 4xx (kept, marked refused, waits for Retry now) and 429
like a 5xx (retried on its clock).

A missing client id (an old client) gets one generated; a malformed one is refused, never replaced,
because it names a file.

**Validation** (before anything is written, so a refusal is immediate and says why):

- There must be words: a non-empty body (or title). "Say what happened."
- Screenshots must be `data:image/png;base64,…`. Dropped images may be PNG, JPEG, GIF or WebP. Nothing
  else, and no SVG (it can carry script).
- Per picture at most 12,000,000 base64 characters (~9 MB); all pictures together at most 40,000,000
  (~30 MB, GUESS).
- `kind` and `priority` outside their sets fall back to `bug` and `P2`; `page` defaults to `/`;
  `context` must be an object; `imageOffset` a non-negative integer no larger than the attachment count.
- A backslash at the end of a line is removed (a typed newline in a terminal, not text).

**Reporter.** Taken from the session by a host-supplied `resolveReporter(req)`, never from the body.
The route stores what it returns (a user id, a handle, or null) in the journal entry. Any lookup that
needs the database happens in the ingester.

### 2.2 `GET /api/feedback?clientId=…` — where a report stands

Reads the journal only; answers even while the database is busy.

```json
{ "state": "journaled" }
{ "state": "filed", "id": "0024", "location": "0024-the-late-tile-counts-an-order-that-is-still-proofing.md" }
{ "state": "refused", "error": "…" }
```

`location` is where the store put the issue: a file name relative to the issues folder, or a URL (the
GitHub store's `html_url`).

404 `{ "state": "unknown" }` when the id was never seen.

### 2.3 Issues

| Route | Returns |
|---|---|
| `GET /api/issues` | `{ issues: Issue[], destination: string, store: string }`, newest first. `destination` is the store's sentence saying where issues go; `store` its kind (`files`, `sql`, `github`). Optional `status`, `kind`, `priority` (comma lists) and `q` (case-insensitive substring over id, title, body, reporter and page). The issues page loads everything once and filters locally. |
| `GET /api/issues/:id` | `{ issue: Issue }` or 404. |
| `PATCH /api/issues/:id` | Body `{ status?, priority?, kind?, labels? }` → `{ issue }`. Same-origin only (the Origin check of §10). Sets `closed_at` when status becomes `done`, clears it on reopen, keeps unmanaged frontmatter lines. Guard it with the host's own authorisation (`authorize`, below): only people who triage should change status. |
| `GET /api/issues/attachments/<path>` | The image bytes with its content type and `cache-control: no-store`. The path is normalised and re-rooted under the store; `..`, NUL and non-image extensions are 404. |

`Issue` is defined in [REBUILD.md §12.1](REBUILD.md#121-data). The same reads are also served under
`/api/feedback/issues…` and `/api/feedback/attachments/…`, so one catch-all route can carry everything.

**Who may read and change issues.** The handler takes an `authorize(req, action)` hook, called for
`action` `'read'` (list and detail), `'attachment'` (pictures) and `'update'` (PATCH). It returns `true`,
`false` (403) or a `Response` of its own (say, a 401). **Without it, every issue read is open to anyone
who can reach the server**, so a real app must supply one from its session, as it must supply
`resolveReporter`. The export endpoint is separate: it takes a bearer token ([§9](#9-the-export-endpoint)).
`examples/next-app` shows both hooks with a demo "sign in as" cookie, which is not authentication.

### 2.4 `GET /api/feedback/export?since=…` — see [§9](#9-the-export-endpoint).

## 3. Journal first, file later

PL LabOS tools learned this on 27 Sep 2026. The live server is one Node process. During a large import
its event loop was busy for minutes, or it was restarting, and the feedback box could not file: the
person reporting the problem was the one person who could not report it. The first fix kept reports in
the browser and resent them. The owner's answer was that this was not enough: "it should journal to
the server. the page may die or close forever." A separate journal process was ruled out: "no
additional servers, mess to deploy."

So:

- **The web server may be busy with database work.** The route must not touch the database, the auth
  layer or anything that queues behind them. In PL LabOS tools a property test walks the route's static
  imports and fails if one reaches the database, the modules or auth. Keep that test.
- **The page may die.** Once the server answers 202, the report must be on disk, fsynced. The browser
  then forgets it, and the tab can close.
- **Numbering, titles and database rows can wait.** The ingester does them seconds later and retries
  for as long as it takes. The issue number is shown to the reporter when it exists (the client polls
  the journal).

Measured in PL LabOS tools with the database held by a 25 s transaction: five POSTs with a 182 KB
screenshot were answered in 5–28 ms, the journal file was on disk at once, the issue was filed a
second later, and its database row appeared when the hold ended. With the server frozen (SIGSTOP), the
report waited in the browser and filed once, about a second after SIGCONT.

## 4. The journal on disk

```
<journal>/<clientId>.json                        journaled, not yet filed
<journal>/files/<clientId>.<nonce>/N-kind.ext    its pictures, decoded
<journal>/filed/<clientId>.json                  filed: issue id, location, title, times; no pictures
<journal>/refused/<clientId>.json                can never be filed; kept whole, with the reason
```

A journal entry:

```json
{
  "v": 1,
  "clientId": "3f0a2c9e-6b1d-4b8e-9d2e-0c1f5a7b8e21",
  "receivedAt": "2026-09-29T20:02:28.947Z",
  "reporter": "u_17",
  "request": {
    "title": "", "body": "…", "kind": "bug", "priority": "P2", "page": "/orders",
    "context": { "…": "…" }, "imageOffset": 1,
    "attachments": [
      { "kind": "screenshot", "contentType": "image/png", "file": "files/3f0a…/1-screenshot.png", "bytes": 182311, "sha256": "…" }
    ]
  }
}
```

PL LabOS tools kept the pictures inline as data URLs in the entry. The kit decodes them to files beside it,
so an entry stays small to read and list.

**Atomic writes.** A write is either absent or complete:

1. Write the pictures into a fresh folder no entry names yet, fsync each file.
2. Write the entry to a dot-prefixed temporary in the same folder (`open(..., 'wx')`), fsync it.
3. Commit it into place with a hard link (or `rename`), then fsync the folder, so the directory entry
   itself is durable. Some platforms do not allow opening a folder for fsync; that step is best effort.
4. Readers skip dot-files, so a half-written temporary is never taken for a report. Stray folders and
   temporaries are swept later.

**Idempotency.** The client id is the file name. A write for an id that is journaled, filed or refused
writes nothing and says which. Concurrent sends of one id in one process share one write; across
processes the hard link lets exactly one win.

Clocks: `receivedAt` is the server's time and orders the inbox. The client's clock is never used for
anything.

## 5. The ingester

A loop in the same process as the web server (in Next.js, started from `instrumentation.ts`
`register()`, lazily imported and never awaited, so a slow disk cannot hold start-up):

- **When it runs:** right after each journal write (`setImmediate` after the response), once at
  start-up (to file whatever a restart left behind), and every 10 s (GUESS) on an `unref`'d interval.
- **One pass at a time** per process. A kick during a pass sets a flag and the pass runs once more.
  Keep this state on `globalThis`: Next.js may load the module twice in one process (the route and
  instrumentation), and two ingesters would race for numbers.
- **Per entry, oldest first:**
  1. Resolve the reporter (a host hook, `identify(reporter)`). A failed lookup leaves the entry in the
     journal for the next pass. `unknown` only when a successful lookup finds nobody.
  2. Generate the title ([§6](#6-titles)).
  3. `store.create(draft)` with the client id. The store dedupes on it.
  4. Write `filed/<clientId>.json`, then remove the entry. A crash between the two is a resend, which the
     store answers with the issue it already filed.
- **Failures:** a store that throws `RefusedError` (can never succeed) moves the entry to `refused/`
  with the reason; a `RetryLaterError` (a rate limit) waits at least as long as asked; anything else
  stays in the journal and is retried on the next pass, logged once per entry, not on every pass.
- **Numbering:** stores that number (files, SQL) take the next number inside a per-store lock, so two
  creates at once cannot take the same one, and a resend racing the first write finds it. Only one
  server may number a given store. In PL LabOS tools, development checkouts refuse to file at all for this
  reason.
- **Attachments:** handed to the store as bytes with a kind and content type. The store names the files
  (`0024-screenshot.png`, `0024-screenshot-2.png`, `0024-image-1.jpg`) and rewrites the body's
  `attachment:N` tokens to their paths using `imageOffset`. A caller can never choose a path.
- **The database row** (PL LabOS tools writes one to `platform.feedback`, plus an audit entry) is best
  effort, written after the issue file with a budget of 2 minutes (GUESS) for a busy database. The file
  is the record; the row records that somebody complained, with the context, and survives a
  `git checkout` the way the file survives a database reset.

## 6. Titles

The client never asks for a title. The ingester makes one:

1. **An LLM title** when a model is configured (a host hook; the package has an optional Anthropic
   adapter). Input: the body, the page, the kind, and the screenshots as images. Ask for one plain
   sentence fragment under 80 characters that names what is wrong, not "Bug report"; no trailing full
   stop, no quotes, no invented detail. Time-box it (GUESS: 15 s) and treat any failure as "no title".
   The title is generated once, at filing, and stored; it is not regenerated when the body is edited.
   Anything sent to a model leaves your server: see [§10](#10-security).
2. **The fallback**, always available, from the body (`titleFrom` in `title.ts`):
   - Take the first line that contains a letter or digit, skipping code fences and image lines, with
     list markers, `>` and `#` stripped. Remove image syntax, keep link text, drop `*_\``, collapse
     spaces.
   - Take its first sentence if that sentence is at least 12 characters. Strip trailing punctuation.
   - Over 80 characters: drop parenthetical asides; still over, cut at the last clause boundary
     (`, `, `; `, ` — `, `: `) if it is at least 32 characters in, else at a word boundary with `…`.
   - Capitalise the first letter.
3. **The first line.** When that finds nothing (a body that is only an image, say), the first line
   with a letter or digit in it, image syntax reduced to its alt text, cleaned like a model's title
   (one line, no markdown, at most 80 characters): `![late-tile.png](attachment:1)` is titled
   `late-tile.png`. Only when even that is empty is the title "Untitled". The route refuses a report
   whose body has no words unless it carries a title, so steps 3 and "Untitled" are reached only by
   entries journaled some other way; the report still files.

A title a sender typed (API callers) is kept as given, joined onto one line.

## 7. Stores

One interface; the ingester and the issues routes know nothing else.

```ts
interface FeedbackStore {
  readonly kind: string;
  readonly destination: string;   // a sentence shown in the UI: where issues go
  create(draft: IssueDraft): Promise<Issue & { repeat?: boolean }>;   // dedupes on draft.clientId
  list(filter?: IssueFilter): Promise<Issue[]>;
  get(id: string): Promise<Issue | null>;
  update(id: string, patch: { status?; priority?; labels? }): Promise<Issue>;
  readAttachment(path: string): Promise<{ bytes: Uint8Array; contentType } | null>;
  sync?(): Promise<{ updated: number }>;   // pull changes made elsewhere (GitHub)
}
```

| Store | Record | Numbering | Pictures |
|---|---|---|---|
| **Files** | `NNNN-slug.md` per issue ([§8](#8-the-issue-file-format)) | next integer, zero-padded to 4, in a lock | `attachments/NNNN-screenshot.png` beside the issues |
| **Files + SQL** (SQLite or Postgres) | the file, plus a row per issue for querying | same | files |
| **Files + GitHub** | a GitHub issue, plus a local mirror file named by the GitHub number | GitHub's | `attachments/<clientId>/report-screenshot.png`, `report-image-1.jpg` in the mirror (saved before GitHub gives a number); see [§11.3](#113-screenshots) |

Files are the default because a coding agent reads them natively (no token, no webhook), the
complaint and its fix travel in one pull request, and they survive a database reset. If issue text may
contain confidential data, keep the folder out of git (PL LabOS tools files real-data issues under a
git-ignored data folder and only demo issues in the repository).

## 8. The issue file format

Markdown with a small frontmatter block, read and written by hand (no YAML library), so field order
and the comments survive and a person can edit it:

````markdown
---
id: "0024"
title: Harbor Deli shows as late while its order is still proofing
status: open          # open | triaged | agent-ready | in-progress | done
kind: bug             # bug | request | question | chore
priority: P2          # P0 blocking | P1 serious | P2 normal | P3 someday
reporter: robin
page: /
created: 2026-09-29T20:02:29.311Z
labels: []
screenshots: [attachments/0024-screenshot.png]
attachments: [attachments/0024-screenshot.png]
client_id: ee5e7937-b1d8-43bc-9dfa-5bbf84365fb0
---

Harbor Deli shows as late while its order is still proofing.

![Screenshot](attachments/0024-screenshot.png)

```json context
{
  "route": "/",
  "url": "http://localhost:3172/",
  "filters": {},
  "client": { "userAgent": "…", "viewport": "1440×900", "pixelRatio": 2, "touch": false },
  "journaledAt": "2026-09-29T20:02:28.947Z",
  "reporter": "robin",
  "reporterVerification": "session"
}
```
````

(From `examples/next-app`; invented.)

Rules:

- **Managed fields**, in this order: `id` (always quoted), `title`, `status`, `kind`, `priority` (each
  of the three padded and followed by its comment), `reporter`, `page`, `created` (UTC ISO with
  milliseconds, so two issues filed in one second still sort and export apart; files written by hand
  without them read fine), `closed_at` (when done), `labels` (a `[a, b]` list), `screenshots` and `attachments`
  (lists, omitted when empty).
- **Unmanaged lines** (`client_id:`, `assignee:`, `branch:`, `fixed_in:`, anything a person adds) are
  kept verbatim, in order, after the managed fields, through every rewrite. Changing a status must never
  drop them, and a second rewrite must change nothing.
- **Quoting:** a scalar is written with `JSON.stringify` when the plain value would not read back as
  itself: empty, a leading digit, space, `[`, `{` or quote, any `:`, `#`, `"`, `\`, a line break, or a
  trailing space. The reader unquotes with `JSON.parse` (stripping outer quotes alone left backslashes
  in titles like `Fix: the "rail"`). Comments after `status`, `kind`, `priority` are stripped on read.
- **Body:** the markdown, then one `![Screenshot](path)` line per screenshot (for people reading the
  file; the app strips these and shows the screenshots in their own section), then the context as a
  fenced block with the info string `json context`.
- **Legacy:** `screenshot:` / `attachment:` (singular) are read as one-item lists; status `review` reads
  as `done`.
- **Fixed in:** `fixed_in: N30` when written; otherwise the first `**…(N30)` in the body (the closing
  note convention, e.g. `**Done (N30).** …`).
- **File name:** `NNNN-` plus a slug of the title (lowercase, non-alphanumerics to `-`, at most 48
  characters, `issue` when empty). The number is the next integer after the highest existing id.

## 9. The export endpoint

`GET /api/feedback/export?since=2026-09-28T00:00:00Z` returns every issue created strictly after
`since`: `{ "items": Issue[] }`, `cache-control: no-store`. It writes nothing.

- Disabled (404) unless `FEEDBACK_EXPORT_TOKEN` is set.
- `Authorization: Bearer <token>`, compared in constant time (`timingSafeEqual` on equal-length
  buffers); anything else is 401.
- `since` must be an ISO timestamp with a timezone (`Z` or `±hh:mm`); otherwise 400.
- It is for pulling feedback from a deployed instance to where the agents work (PL LabOS tools' plan pulls
  every 60 s and files each item through the local journal). Items include bodies and context, which can
  be sensitive: keep the token in a secret store and rotate it.

## 10. Security

- **Origin.** Refuse a POST whose `Origin` does not match the app's own host (compare with the `Host`
  header, not the URL the framework passes, which may be the bound address) or a configured allow-list.
  This blocks cross-site form posts filling your queue.
- **Authentication.** The feedback route should require the app's session like any other route. The
  reporter comes from the session only.
- **Sizes.** Limit the request body before parsing (the pictures cap plus a margin), and the per-picture
  and total sizes as above. Refuse with 413 and a reason.
- **Types.** Only the four raster image types, checked against the data URL's declared type; decode
  base64 strictly. Never accept SVG or HTML. Serve attachments with their real content type and
  `X-Content-Type-Options: nosniff`.
- **Paths.** The client id is `^[A-Za-z0-9-]{8,64}$` and nothing else, because it names files. Stores
  name attachment files; the body can only refer to `attachment:N`. The attachment route normalises and
  re-roots paths and refuses `..` and NUL.
- **Rendering.** Render bodies to React elements, never raw HTML.
- **Rate.** A per-user limit on POSTs (GUESS: 30 a minute) protects the disk; resends of a known client
  id are free because they write nothing.
- **No secrets in reports.** The client captures the URL, query string and user agent: strip known
  secret parameters (`token`, `key`, `code`, `password`, …) from `context.url` and `context.filters`
  before journaling. Mark sensitive regions `nocapture` so the automatic screenshot leaves them out; the
  exact screen capture cannot redact.
- **Screenshots contain whatever was on screen.** Treat the journal, the issues folder and attachments
  as being as sensitive as the app's most sensitive page. Do not commit them to a public repository, do
  not send them to a model or service that trains on inputs, and be deliberate before sending them to
  any third party (an LLM title, GitHub).
- **Single numbering authority.** A server that is not the filing server answers 403 with a sentence,
  so two servers never hand out the same number.

## 11. The GitHub variant

Files → GitHub Issues: the ingester files each report as an issue in a repository you choose, and keeps a
local mirror file per issue (in the format above, named by the GitHub number) so the issues page never
spends GitHub's rate limit.

### 11.1 Token

- A **fine-grained personal access token** or a **GitHub App** installation token, limited to the one
  repository.
- Permissions: **Issues: read and write**, **Metadata: read**. Add **Contents: read and write** only if
  screenshots are uploaded to a repository ([§11.3](#113-screenshots)), and then only for that
  repository.
- Classic tokens need the `repo` scope for a private repository, which grants far more; avoid them.
- Read from `FEEDBACK_GITHUB_TOKEN` (then `GITHUB_TOKEN`); never log it, never send it to the browser.

### 11.2 Creating an issue

- `POST /repos/{owner}/{repo}/issues` with `title`, `body` and `labels`. Send
  `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`.
- The body: the report's markdown, the screenshots (as links or a count), the context in a fenced
  `json` block inside a `<details>`, and a hidden marker `<!-- feedback-kit client_id: … -->`.
- **Idempotency.** Before creating, look in the mirror, then list the repository's issues updated since
  the report arrived (minus a clock-skew allowance) and look for the marker. Use the listing endpoint,
  not search: search is eventually consistent, so an issue created a moment before a crash might not be
  found, and the retry would file a duplicate.
- **Reporter.** GitHub will show the token's owner as the author. Put the reporter in the body ("Filed
  by …") and, if you map users, as an assignee or mention only with their consent.

### 11.3 Screenshots

GitHub has no API for the private user-attachment uploads the web UI uses
(`user-images.githubusercontent.com`), so there are three honest options:

| Mode | How | Visible to | Trade-off |
|---|---|---|---|
| `local` (default) | Pictures stay on your server; the issue links to your attachment route | whoever can pass your app's auth | GitHub readers without app access see broken links, which is the point |
| `repo` | `PUT /repos/{owner}/{assets}/contents/{path}/{clientId}/report-screenshot.png` (and `report-image-N.ext`) into a **private** repository you name (`path` defaults to `feedback`), linked from the issue | collaborators of that repository | Needs Contents: write. The store checks the repository is private and keeps the pictures local if it is public (unless `allowPublic`). **A dropped image the body no longer shows is never uploaded**: only what the report shows leaves your server. A picture committed to git **stays in its history** after the issue is closed or deleted; removing it takes a history rewrite. |
| `none` | Pictures stay local; the issue says how many there are | nobody on GitHub | Safest; the issue alone is often too thin to act on |

**Privacy warning.** A screenshot shows whatever was on the reporter's screen: names, amounts, private
notes, other people's data. An issue body is readable by everyone who can read the repository, which for
a public repository is everyone. PL LabOS tools decided against GitHub issues for its real data for exactly
this reason: automatic redaction cannot be trusted (names appear as first names, firm names and inside
screenshots), one miss publishes confidential data to a third party, and a redacted issue is too thin to
act on. Use GitHub for apps whose screens carry nothing confidential, or with pictures kept `local`.

### 11.4 Labels

Every issue gets the base label (`feedback` by default) plus:

| Field | Label | Notes |
|---|---|---|
| kind | `kind:bug`, `kind:request`, `kind:question`, `kind:chore` | set at creation |
| priority | `priority:P0` … `priority:P3` | replaced on change |
| status | `status:open`, `status:triaged`, `status:agent-ready`, `status:in-progress` | `done` closes the issue with `state_reason: completed` |

Create the labels on first use (a 422 means they exist). Labels someone adds on GitHub are kept; a
labels patch replaces the free labels but never the managed ones.

### 11.5 Two-way status sync

- **Out:** `update()` PATCHes the issue: labels, and `state` (`closed` for done, `open` otherwise).
- **In:** `sync()` lists the repository's issues carrying the base label (`labels=feedback`), updated
  since the last sync (`since=`, `sort=updated&direction=asc`, 100 a page, following the `Link` header's
  `rel="next"`), skips pull requests, and for each: closed → `done` (recording `closed_at`);
  open → its `status:*` label, else, if the mirror said done, `open` (a reopen), else unchanged. Priority
  comes back from its label. Run it from the ingester's timer (GUESS: every 60 s) or a webhook
  (`issues` events, verified with the webhook secret's HMAC).
- Conflicts: the most recent change wins, by GitHub's `updated_at` against the mirror's.

### 11.6 Rate limits

- The REST API allows 5,000 requests an hour for a token (15,000 for some App installations); issue
  creation also has **secondary limits** on content-creating requests. Space creates about 1 s apart and
  never run them concurrently.
- On 403/429 with `x-ratelimit-remaining: 0` or `retry-after`: wait `retry-after` seconds, else until
  `x-ratelimit-reset`. Short waits (up to 60 s) inline; longer ones as a `RetryLaterError` so the
  ingester backs off without blocking other work. The report is safe in the journal meanwhile.
- The issues page reads the mirror, never GitHub.

## 12. Database or GitHub?

| | Files + database (SQLite/Postgres) | Files + GitHub Issues |
|---|---|---|
| Where the data lives | your server and database | GitHub (plus the local mirror) |
| Confidential screens | stay inside your boundary | leave it unless pictures stay `local`; bodies always leave |
| Numbering | yours, sequential, one filing server | GitHub's |
| Status changes | issues page or editing the file | issues page, or GitHub (synced back) |
| Agents read issues | as files, no token | via the mirror files, or GitHub's API/CLI with a token |
| Discussion, assignment, linking PRs | build it yourself | GitHub's |
| Search | local, in the page | local in the page; GitHub's search too |
| Rate limits | none | 5,000/h plus secondary limits; creates spaced |
| Works offline / during an outage | yes | journal and mirror yes; filing waits for GitHub |
| Setup | a folder (and a database URL) | a token with Issues: write, a repository, labels |
| Good for | apps showing private data; single-team tools | open-source or internal tools with nothing sensitive on screen |
