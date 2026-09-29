# feedback-kit

An in-app feedback module for React apps, extracted from Capital OS (PLC Raise Tools), where it has
filed and tracked every bug report since September 2026. A person presses Alt+F, describes the problem,
and files it. The report arrives with a screenshot of what they were looking at, the page, its filters
and the device. It is saved on the server within milliseconds, even when the app is busy or restarting,
and becomes an issue that a person or a coding agent can pick up.

Two packages:

- **`packages/feedback-react`**: the button and shortcut, the feedback panel, automatic and exact
  screenshots, the region picker (mouse and touch), the annotation editor, a WYSIWYG markdown field
  with drag-and-drop and paste of images, per-page drafts, the offline outbox, the status mark, and the
  issues pages.
- **`packages/feedback-server`**: a journal-first `POST /api/feedback` (written to disk before it
  answers), a background ingester, AI-generated titles, the issues API, and stores for files,
  SQLite/Postgres, and GitHub Issues. Next.js and plain Node adapters.

There is no Title field: titles are generated from the body and screenshots on the server.

## Tour

The feedback panel, with the automatic screenshot of the page behind it (*Capital OS original; the kit
has no title*):

![The feedback panel](docs/screenshots/02-drawer.png)

Pick a part of the page, with a mouse or a finger:

![Region picker after a finger drag](docs/screenshots/10-region-touch.png)

Write in rich text; drop or paste images; the source is markdown:

![The description field](docs/screenshots/07-markdown.png)

When the server cannot be reached, reports wait in the browser and resend themselves:

![The outbox](docs/screenshots/15-outbox-offline.png)

The issues page, with filters (and, in the kit, local search):

![The issues list](docs/screenshots/16-issues.png)

More in [docs/FEATURES.md](docs/FEATURES.md).

## Quick start

`examples/next-app` is a small Next.js app wiring both packages, with end-to-end tests. Start there:

```sh
cd examples/next-app
npm install
npm run dev        # then press Alt+F (Option+F on a Mac)
```

In your own app, the wiring is three steps; the example shows each one in full:

1. Mount the client provider and the feedback button in your layout, and add the issues pages.
2. Add the server routes (`/api/feedback`, `/api/issues/…`), giving them your session's user as the
   reporter and a store (files by default).
3. Start the ingester once per server process (in Next.js, from `instrumentation.ts`).

Also: self-host your fonts (the screenshot can only embed same-origin fonts), and add the class
`nocapture` to anything that must never appear in an automatic screenshot.

## Docs

- [FEATURES.md](docs/FEATURES.md): every feature, with screenshots.
- [REBUILD.md](docs/REBUILD.md): the full specification, precise enough to rebuild the module in any
  React app: components, state machines, the capture pipeline and its pitfalls, the region picker, the
  markdown field, keyboard, the issues pages, accessibility, and acceptance tests.
- [SERVER.md](docs/SERVER.md): the API, the journal, the ingester, the issue file format, the export
  endpoint, security, and the GitHub Issues variant with a comparison.
- [TRIAGE.md](docs/TRIAGE.md): how coding agents triage and fix feedback in the background: four
  classes, roles to outcomes, the feedback-fixer pattern.
- [PACKAGES.md](docs/PACKAGES.md): dependencies, versions, and why.

Screenshots come from the Capital OS demo server and show invented data.
