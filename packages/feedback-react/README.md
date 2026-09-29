# @jbenet/feedback-react

The client half of feedback-kit: the feedback box from PL LabOS tools, for any React 19 app.

- **A button and a shortcut.** `Alt+F` (Option+F on a Mac) anywhere outside text fields and dialogs.
- **A sidebar** that opens straight into typing. No title field — the server writes the title.
- **Screenshots.** One taken automatically when the box opens (the page redrawn, the box itself
  left out), more on demand: the whole page or a part of it, using the browser's screen capture
  for exact pixels where it can. The region picker works with a mouse, a finger or a pen.
  A "Misaligned? Tell us" toggle under an automatic capture records that it did not match the screen.
- **Annotation**: pen, arrow, line, box and text labels on any screenshot or dropped picture,
  from a slim row of icon buttons.
- **A WYSIWYG markdown field** (TipTap): Rich or Markdown source, drop or paste images anywhere
  in it; only the pictures still in the text are sent.
- **Drafts per page** that survive reloads (words in localStorage, pictures in IndexedDB).
- **An offline outbox.** Filing keeps the report in the browser, posts it with a 3 s timeout, and
  resends with a backoff until the server confirms it journaled it. A status line says whether a
  report is only on this device, saved on the server, or filed as issue N.
- **The issues pages**: a list with chip filters and instant local search (`/` to focus), a
  velocity chart, and a detail view with the screenshots, the context, and a status control.

The server half is `@jbenet/feedback-server` (packages/feedback-server). The wire contract is in
`docs/REBUILD.md` §2.

## Install

```sh
npm install @jbenet/feedback-react
```

Peer dependencies: `react` and `react-dom` 19. The package ships ES modules in `dist/` (one file
per source module, so each keeps its `'use client'` directive, and a server component can import
`VIEWPORT_BOOT` as a plain string) with type declarations, plus the stylesheet at
`@jbenet/feedback-react/styles.css`. No bundler configuration is needed.

It also ships its TypeScript source. To compile it with your app instead (to step through it, or to
patch it), import from `@jbenet/feedback-react/source` and `@jbenet/feedback-react/source/styles.css`,
and in Next.js add it to `transpilePackages`:

```ts
// next.config.ts
export default { transpilePackages: ['@jbenet/feedback-react'] };
```

Use one or the other throughout: the two entry points are separate module instances.

Self-host the fonts (same origin), or the automatic screenshot draws text in fallback fonts:

```ts
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource/ibm-plex-sans/400.css';   // and 500, 600
import '@fontsource/ibm-plex-mono/400.css';   // and 500
```

## Use

```tsx
// app/layout.tsx
import '@jbenet/feedback-react/styles.css';
import { FeedbackButton, FeedbackStatus, KeyboardShortcuts, VIEWPORT_BOOT } from '@jbenet/feedback-react';
import { Providers } from './Providers';

export default function Layout({ children }) {
  return (
    <html lang="en">
      <head><script dangerouslySetInnerHTML={{ __html: VIEWPORT_BOOT }} /></head>
      <body>
        <Providers userLabel="Robin Vega">
          <nav>… <FeedbackStatus /> <FeedbackButton variant="rail" /></nav>
          <main>{children}</main>
          <KeyboardShortcuts />
        </Providers>
      </body>
    </html>
  );
}
```

```tsx
// Providers.tsx
'use client';
import { usePathname } from 'next/navigation';
import { FeedbackProvider } from '@jbenet/feedback-react';

export function Providers({ userLabel, children }) {
  return <FeedbackProvider pathname={usePathname()} userLabel={userLabel}>{children}</FeedbackProvider>;
}
```

```tsx
// app/issues/page.tsx and app/issues/[id]/page.tsx ('use client' where a Link is passed)
import { IssuesPage, IssuePage } from '@jbenet/feedback-react';
<IssuesPage />                     // fetches GET /api/issues
<IssuesPage issues={issues} />     // or give it the data
<IssuePage id={id} editable />     // fetches GET /api/issues/:id; the status control PATCHes it
```

`examples/next-app` wires all of it, with the server package, and has end-to-end tests (Chromium and
WebKit). `npm test` here runs the capture fallbacks with the browser stubbed; what cannot be tested
headless is in [REBUILD.md §15](../../docs/REBUILD.md#15-what-cannot-be-tested-headless).

## Configuration — `<FeedbackProvider>`

Every prop is optional; without a provider the defaults apply.

| Prop | Default | What it does |
|---|---|---|
| `base` | `''` (same origin) | Prefix for every endpoint. |
| `endpoints.submit` | `/api/feedback` | POST a report; GET `?clientId=` for its state. |
| `endpoints.issues` | `/api/issues` | GET the list: `{ issues }` (`{ items }` is read too). |
| `endpoints.issue(id)` | `/api/issues/:id` | GET one `{ issue }`; PATCH `{ status?, priority?, labels? }`. |
| `endpoints.attachment(path)` | `/api/issues/attachments/<path>` | A filed picture. Absolute URLs pass through. |
| `userLabel` | none | "Filing as …" in the box. Display only: the server resolves the reporter from the session. |
| `shortcut` | `{ code: 'KeyF', alt: true }` | The open-the-box keys. `code` is the physical key; `mod` is ⌘ on Apple, Ctrl elsewhere. |
| `storagePrefix` | `feedbackkit` | Names of the localStorage keys and IndexedDB databases. |
| `issueHref(id)` | `/issues/<id>` | Where "Filed as issue N" and list rows link. |
| `theme` | `{}` | CSS variable overrides, applied inline on every root the kit draws. `GREEN_THEME` is an example. |
| `destinationNote` | "Filed with the issue on the server." | One sentence under the screenshots. |
| `pathname`, `search` | `window.location` | The page, from your router, so client-side navigation is seen. |

`openFeedback()` opens the box from any control of your own.

## Components

| Export | What it is |
|---|---|
| `FeedbackButton` | `variant="rail" \| "bar" \| "floating"`. The launcher, the shortcut, and the outbox's start. Mount one per page. |
| `FeedbackDrawer` | The box itself, if you want to open it yourself. |
| `FeedbackStatus` | The status line (`variant="rail" \| "bar"`): a glyph and "1 report only on this device", "Saved on server · filing…" or "Filed as issue 0024"; nothing when there is nothing to say. A click opens `OutboxList` (Retry now, Copy text, Discard). |
| `KeyboardShortcuts` | The `?` dialog listing every key. |
| `IssuesPage`, `IssuePage`, `IssueList`, `IssueDetail`, `IssueVelocity` | The issues pages and their parts. `Link` prop takes your router's link. |
| `MarkdownField`, `Markdown` | The editor and the renderer, on their own. |
| `RegionPicker`, `ShotEditor` | The region picker and the annotation editor, on their own. |
| `capturePage`, `capturePageExact` | The redraw capture (no prompt, redacts `.nocapture`) and the screen capture (exact, asks permission, falls back to the redraw). |
| `enqueue`, `startOutbox`, `retryNow`, `discardEntry`, `useOutbox` | The outbox, headless. |
| `classify`, `settle`, `due`, `retryDelay` | The outbox's pure rules, for tests. |

Anything in your app marked with the class `nocapture` is left out of the automatic screenshot.

## Theming

All styles are scoped under `.fbk`, the class on every root the kit draws, and read CSS variables
declared on `:where(.fbk)` (no specificity), so either of these re-skins it:

```css
.fbk { --fbk-accent: #1E8F5E; --fbk-ground: #F1F4F0; }
```
```tsx
<FeedbackProvider theme={{ '--fbk-accent': '#1E8F5E' }}>
```

The variables: `--fbk-ground --fbk-surface --fbk-ink --fbk-muted --fbk-line --fbk-hair --fbk-tint
--fbk-label --fbk-accent --fbk-accent-ink --fbk-accent-soft --fbk-accent-line --fbk-accent-wash
--fbk-accent-halo --fbk-clay --fbk-green --fbk-purple --fbk-amber --fbk-rail* --fbk-display
--fbk-sans --fbk-mono --fbk-drawer-w`. `--fbk-clay` means refused/blocked and should not follow
the brand colour.

## Differences from PL LabOS tools

- No title field; the server writes titles. The request has no `title`.
- Endpoints, shortcut, storage names, user label, links and theme are configuration, not imports.
- The drawer traps Tab and opens with the cursor in the description; draft words load before the
  first render, so keys typed the instant it opens are kept.
- The issues list adds search (`/` focuses it), a Fixed-in column and a status control; the
  annotation toolbar is one row of icon buttons with names and tooltips.
- The automatic capture's "Mis-aligned?" hint is a **Misaligned? Tell us** toggle, recorded with the
  report as `context.capture.misaligned`.
- The status mark is a line in words that opens the outbox list directly (no popover in between).
- PL LabOS tools' "filed from the live app" notice for development servers and its connection notes
  are not part of the kit.
