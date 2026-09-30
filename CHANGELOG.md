# Changelog

Both packages share one version.

## Unreleased

- **GitHub issue filing in the example.** Set `FEEDBACK_GITHUB_REPO=owner/name` and the example files
  reports as GitHub issues (`githubStore`) instead of markdown files, mirrored in `.data/github`, with
  pictures kept on the server and linked from the issue. The token is `FEEDBACK_GITHUB_TOKEN` (a
  fine-grained token for that one repository, Issues read/write). `FEEDBACK_GITHUB_LABEL` changes the
  base label (default `feedback`); `FEEDBACK_APP_URL` the address the picture links use.
- `githubStore`: `token` may be a function, asked before each request; `destination` sets the sentence
  the issues pages show.
- `githubStore` sync: an issue reopened on GitHub comes back as open. GitHub keeps the `status:done`
  label on reopen, and sync used to read it and leave the mirror at done.

## 0.1.2 — 29 Sep 2026

- Line breaks (Shift+Enter) are stored as plain newlines, not tiptap-markdown's `\` + newline, so the
  Markdown tab and reopened drafts no longer show a backslash at each break.
- Tooltips in the sheet show at once on hover and keyboard focus (CSS `data-tip`), instead of the
  browser's delayed `title` tooltip.
- Wording: the automatic capture is labelled "Automatic capture may not be exact."; after "Misaligned?"
  the hint says "Click the **Whole Page** or **Pick a Part** to take a screenshot in your browser."

## 0.1.1 (29 Sep 2026, unreleased)

The feedback sheet, per Juan's review of 0.1.0.

**`@jbenet/feedback-react`**

- The panel's header is its own heading, "Feedback" (larger than the other labels); the "What went
  wrong?" heading and its intro paragraph are gone — the fields speak for themselves.
- The explanation that used to sit under **Whole page** / **Pick a part** as a paragraph is now a
  `(?)` tooltip beside them, shown on hover or keyboard focus.
- The description field's label is "Enter any feedback:" (`aria-label="Enter any feedback"`), not
  "What happened"; its placeholder has no blank line before "Markdown works…". The field gets a
  visible focus ring in the theme's accent colour the instant the cursor is inside it.
- The line explaining what the chosen priority means, under Kind/Priority, is gone; each priority's
  meaning is still in its own option in the Priority dropdown.
- **The default theme is PLC green** (`--fbk-accent: #1E8F5E`, a dark green rail), not PL LabOS
  tools' clay. Re-skin with `--fbk-*` CSS variables, in a stylesheet or `FeedbackProvider`'s `theme`
  prop, same as before.
- `<html suppressHydrationWarning>` is now documented as required: the kit sets `--app-h` on `<html>`
  before React hydrates.

## 0.1.0 (29 Sep 2026, unreleased)

The first version, extracted from PL LabOS tools.

**`@jbenet/feedback-react`**

- `FeedbackButton` with Alt+F (Option+F), `FeedbackDrawer` with no title field, automatic redraw
  screenshots, **Whole page** and **Pick a part** (the browser's screen capture, falling back to the
  redraw), the region picker for mouse, finger and pen, the annotation editor with an icon toolbar,
  a WYSIWYG markdown field with dropped and pasted images, per-page drafts, the offline outbox,
  `FeedbackStatus`, `KeyboardShortcuts`, and the issues pages with local search and a status control.
- **Misaligned? Tell us** under each automatic capture, recorded as `context.capture.misaligned`.
- Configuration through `FeedbackProvider`; theming through `--fbk-*` CSS variables.
- Built to `dist/` (ES modules, one per source file, keeping `'use client'`; declarations; the
  stylesheet). The TypeScript source ships too, as `@jbenet/feedback-react/source`.

**`@jbenet/feedback-server`**

- `createFeedbackHandler`: `POST /api/feedback` journals each report to disk (fsynced, atomic,
  idempotent on the client id) before answering 202; 400/403/413/422/429/500 with a reason. Status by
  client id, the issues reads, PATCH, attachments, and a token-protected export. `resolveReporter` and
  `authorize` hooks.
- The ingester: files journaled reports off the request, with backoff, refusals, `identify`, and
  titles by Claude when configured, else the first sentence, else the first line, else "Untitled".
- Stores: markdown files, files plus SQLite or Postgres, files plus GitHub Issues (pictures kept local
  by default; two-way status sync).
- Adapters: `nextRoutes` (Next.js App Router) and `toNodeListener` (plain Node).
- Built to `dist/` (ES modules and declarations) for Node 20 or later.

**Example and tests**

- `examples/next-app`: an invented bakery wiring both packages from their builds, with a demo
  "sign in as" guarding the issue reads and PATCH.
- End-to-end tests in Chromium and WebKit; unit tests for the server and for the client's capture
  fallbacks. What cannot be tested headless is listed in `docs/REBUILD.md` §15.
