# feedback-kit example (Next.js)

A small app with invented data (an invented bakery's orders, reports and settings, and two invented
people) wiring both packages as an app would install them: `@jbenet/feedback-react` for the box and
the issues pages, `@jbenet/feedback-server` for the journal, the ingester and a markdown-file store.
They are npm workspaces, so the example uses each package's built `dist/`.

```sh
npm install                                   # at the repo root (npm workspaces)
npm run dev                                   # builds both packages, then next dev on PORT (default 3172)
# or a production build:
npm run build -w examples/next-app
FEEDBACK_DATA=$(mktemp -d) PORT=3172 npm run start -w examples/next-app
```

Reports are journaled under `FEEDBACK_DATA` (default `.data/`, git-ignored) and filed as markdown in
`FEEDBACK_DATA/issues`. Titles are the report's first sentence here (`generateTitle: null`, no model is
called).

**File to GitHub instead.** With `FEEDBACK_GITHUB_REPO` set, reports become GitHub issues in that
repository (the server package's `githubStore`), mirrored locally in `FEEDBACK_DATA/github`, which the
issues pages read. Give the server a token in `FEEDBACK_GITHUB_TOKEN`: a
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) limited
to that one repository, with **Issues: read and write** and nothing else (Metadata: read is added
automatically). The report text, page and captured context go to GitHub.

`FEEDBACK_GITHUB_PICTURES` says where screenshots and dropped images go:

| Value | Pictures | The token also needs |
|---|---|---|
| `link` (default) | Stay on this server. The issue links to them at `FEEDBACK_APP_URL` (default `http://localhost:$PORT`), behind the app's sign-in, so they show only to people who can reach and sign in to the app. | nothing |
| `upload` | Committed to `FEEDBACK_GITHUB_PICTURES_REPO` (default: the issues repository) on the branch `FEEDBACK_GITHUB_PICTURES_BRANCH` (default `feedback-pictures`, created on first use with no shared history), and shown inline in the issue. A public repository is refused, and the pictures stay on the server, unless `FEEDBACK_GITHUB_PICTURES_PUBLIC=1`. | **Contents: read and write** on that repository |
| `none` | Stay on this server; the issue says how many there are. | nothing |

An uploaded picture stays in that branch's git history after the issue is closed. Upload only from
apps whose screens carry nothing confidential, and to a private repository when you can.

```sh
FEEDBACK_GITHUB_REPO=owner/name FEEDBACK_GITHUB_TOKEN=github_pat_… FEEDBACK_GITHUB_PICTURES=upload npm run dev
```

`FEEDBACK_GITHUB_LABEL` replaces the base `feedback` label (useful to keep test issues apart); every
issue also gets `kind:*`, `priority:*` and `status:*`. Status changes on the issues page relabel or
close the GitHub issue, and changes made on GitHub come back within a minute.

**Sign in as.** The rail has a demo "Sign in as" (Robin Vega or Sam Okafor, both invented). It sets a
`demo_user` cookie that the server reads to name the reporter (`resolveReporter`) and to open the issue
reads, pictures and status changes (`authorize`). Signed out, the issues pages and their API answer 401,
and a report still files, as `unknown`. **This is not authentication**: anyone can set the cookie. A
real app supplies both hooks from its own session.

- `app/layout.tsx`: fonts (self-hosted), the stylesheet, the rail with `FeedbackButton`, `FeedbackStatus`
  and the sign-in.
- `components/Providers.tsx`: `FeedbackProvider` with the router's pathname and the user's name.
- `lib/feedback.ts`: the server: `createFeedbackHandler` (with `resolveReporter` and `authorize`),
  `startIngester`, `fileStore` or `githubStore`. `lib/users.ts`: the demo sign-in.
- `app/api/feedback/[[...path]]`: every feedback endpoint; `app/api/issues/[[...path]]`: the issues reads
  (both through `nextRoutes`). `instrumentation.ts` starts the ingester with the server.
- `app/issues`: the list (data from the store, on the server) and the detail (fetched by the component).

## End-to-end tests

```sh
npx playwright install chromium webkit   # once
npm run e2e -w examples/next-app         # builds and starts the app on PORT (default 3172) in a temp data folder
npx playwright test --project=webkit     # one engine (from examples/next-app)
# or against a running server:
BASE_URL=http://localhost:3172 FEEDBACK_DATA=/path/it/writes/to npx playwright test
```

Every test runs in Chromium and in WebKit. They open a page, press Alt+F, type markdown, drop a file,
add a region screenshot with the mouse and with a finger, file with ⌘/Ctrl+Enter, see the report
journaled and then listed and searchable on the issues page, change its status, keep a draft through a
reload, replay the outbox after the server comes back, check that no title field exists, check the
annotation toolbar on a phone, and check that signed out the issue reads and PATCH are closed.

Touch: Chromium gets real touch input through the DevTools protocol; Playwright has no such protocol
for WebKit, so there the same gestures are dispatched as `PointerEvent`s with `pointerType: 'touch'`.
Neither is Safari on an iPad; see [REBUILD.md §15](../../docs/REBUILD.md#15-what-cannot-be-tested-headless).

## Screenshots

`scripts/screenshots.mjs` takes every picture in `docs/screenshots` from this app, after filing a few
invented reports through the API. Run it against a fresh data folder so the numbers start at 0001:

```sh
FEEDBACK_DATA=$(mktemp -d) PORT=3174 npm run start -w examples/next-app &
BASE_URL=http://localhost:3174 node examples/next-app/scripts/screenshots.mjs
```
