# feedback-kit example (Next.js)

A small app with invented data — orders, reports, settings — wiring both packages:
`@jbenet/feedback-react` for the box and the issues pages, `packages/feedback-server` (imported from
source) for the journal, the ingester and a markdown-file store.

```sh
npm install                       # at the repo root (npm workspaces)
npm run build -w examples/next-app
FEEDBACK_DATA=/tmp/fbk PORT=3172 npm run start -w examples/next-app
```

Reports are journaled under `FEEDBACK_DATA` (default `.data/`, git-ignored) and filed as markdown in
`FEEDBACK_DATA/issues`. Titles are the first line of the report here (no model is called).

- `app/layout.tsx` — fonts (self-hosted), the stylesheet, the rail with `FeedbackButton` and `FeedbackStatus`.
- `components/Providers.tsx` — `FeedbackProvider` with the router's pathname and the user's name.
- `lib/feedback.ts` — the server: `createFeedbackHandler`, `startIngester`, `fileStore`.
- `app/api/feedback/[[...path]]` — every feedback endpoint; `app/api/issues/[[...path]]` — the issues reads.
- `app/issues` — the list (data from the store, on the server) and the detail (fetched by the component).

## End-to-end tests

```sh
npx playwright install chromium   # once
npm run e2e -w examples/next-app  # builds and starts the app on PORT (default 3172) in a temp data folder
# or against a running server:
BASE_URL=http://localhost:3172 FEEDBACK_DATA=/tmp/fbk npx playwright test
```

They open a page, press Alt+F, type markdown, drop a file, add a region screenshot with the mouse
and with a finger, file with ⌘/Ctrl+Enter, see the report journaled and then listed and searchable
on the issues page, change its status, keep a draft through a reload, replay the outbox after the
server comes back, check that no title field exists, and check the annotation toolbar on a phone.
