# Changelog

Both packages share one version.

## Unreleased

- **Security pass** (5 Oct 2026):
  - A report could forge its own captured context (reporter, verification, page) by writing a
    `json context` block in its text. The reader now takes the last block, and the writer never lets
    the body carry one.
  - The MCP endpoint read a whole request body before checking its size; it now stops at the limit.
  - Issue pages: markdown links are only `http(s):`, `mailto:`, same-site and anchors (no
    `javascript:` or `//elsewhere`); pictures load only from the issue's own attachments or
    `trustedImageOrigins` (no remote tracking pixels, no `attachments/../..` paths); kinds are CSS
    classes only from the allowed four.
  - The automatic screenshot masks password, card, one-time-code and new-password fields, and blurs
    `data-private` elements. The filed address has no fragment and no secret-looking query values.
- **Feedback over MCP** ([docs/MCP.md](docs/MCP.md)): a convention for apps and their agents to give
  each other feedback. Four tools (`feedback_submit`, `feedback_status`, `feedback_list`,
  `feedback_get`); `createFeedbackHandler({ mcp: { identify } })` serves them at
  `POST /api/feedback/mcp` (MCP Streamable HTTP, stateless, no dependencies); `feedbackTools()` puts
  them on an MCP server you already run; `sendFeedback()` reports to another app from code. Reports
  from other apps go through the same journal, filing and injection screen as the box's. The example
  serves the endpoint (tokens in `FEEDBACK_MCP_CALLERS`) and `/.well-known/feedback.json`.
- **Annotator** (issue #10): a **Select** tool (move or delete a mark, or just leave another tool),
  **stroke widths** beside the colors, dark tooltips that are never hidden under the picture, and
  "Color" in US spelling.
- **Filed screen** (issues #14, #15): numbers read `#12` in one right-aligned column, so titles line up
  whether numbered or not; nothing on the screen moves or resizes when the number arrives.
- **The filed screen** (issue #7). File no longer closes the box: it stays open on where the report
  stands ("Sending…", "Saved on the server · being filed", "Kept in this browser…", "Refused…",
  "Filed as issue N"), with **Give more feedback** (⌘/Ctrl+Enter) for another report from the same
  page, **Open the issue**, and **Close**. From the second report, a list of everything filed while
  the box was open. File still returns at once; `enqueue()` takes an optional `clientId`.
- **Card alignment** (issue #8): card bodies on the issues pages had no padding, so their content sat
  against the card's left edge instead of under its heading; they now line up. The issue velocity
  chart is also drawn at its card's width, so it fills the card on a wide screen.
- **Prompt injection** (issue #6). The ingester neutralizes every report (invisible characters removed,
  HTML comments shown as text) and screens it by patterns; a hit is filed with the `suspicious` label and
  a warning on top, or refused with `onSuspicious: 'refuse'` (the handler then answers 422 with the reason,
  which the reporter sees). `screen: anthropicScreen()` adds a model that also reads the screenshots.
  docs/TRIAGE.md §10 says how agents read the queue: as untrusted data, skipping `suspicious` issues.
- **GitHub issue filing in the example.** Set `FEEDBACK_GITHUB_REPO=owner/name` and the example files
  reports as GitHub issues (`githubStore`) instead of markdown files, mirrored in `.data/github`, with
  pictures linked from this server (`FEEDBACK_GITHUB_PICTURES=link`, the default), uploaded to a
  GitHub branch and shown in the issue (`upload`), or only counted (`none`). The token is `FEEDBACK_GITHUB_TOKEN` (a
  fine-grained token for that one repository, Issues read/write). `FEEDBACK_GITHUB_LABEL` changes the
  base label (default `feedback`); `FEEDBACK_APP_URL` the address the picture links use.
- `githubStore`: `token` may be a function, asked before each request; `destination` sets the sentence
  the issues pages show.
- `githubStore` `custom` pictures: `upload(picture)` sends each picture wherever you choose and returns
  the URL the issue embeds. The README says why GitHub's own drag-and-drop upload cannot be used
  from a server (no API; it needs a browser session).
- `githubStore` `repo` pictures: a `branch` that does not exist is created on first use, with no parent
  (one README commit), so pictures never share history with the code. The private-repository check
  (`allowPublic`) is gone: the repository you name is the one used.
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
