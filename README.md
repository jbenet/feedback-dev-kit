# feedback-kit

An in-app feedback module for React apps, extracted from PL LabOS tools, where it has filed and tracked
every bug report since September 2026. A person presses Alt+F, describes the problem, and files it.
The report arrives with a screenshot of what they were looking at, the page, its filters and the
device. It is saved on the server within milliseconds, even when the app is busy or restarting, and
becomes an issue that a person or a coding agent can pick up.

Two packages:

- **`@jbenet/feedback-react`** (`packages/feedback-react`): the button and shortcut, the feedback
  panel, automatic and exact screenshots, the region picker (mouse and touch), the annotation editor,
  a WYSIWYG markdown field with drag-and-drop and paste of images, per-page drafts, the offline outbox,
  the status line, and the issues pages.
- **`@jbenet/feedback-server`** (`packages/feedback-server`): a journal-first `POST /api/feedback`
  (written to disk before it answers), a background ingester, AI-generated titles, the issues API, and
  stores for files, SQLite/Postgres, and GitHub Issues. Next.js and plain Node adapters.

There is no Title field: titles are generated from the body and screenshots on the server.

## Tour

The feedback panel, with the automatic screenshot of the page behind it:

![The feedback panel](docs/screenshots/02-drawer.png)

Pick a part of the page, with a mouse or a finger:

![Region picker after a finger drag](docs/screenshots/10-region-touch.png)

Write in rich text; drop or paste images; the source is markdown:

![The description field](docs/screenshots/07-markdown.png)

When the server cannot be reached, reports wait in the browser and resend themselves:

![The outbox](docs/screenshots/15-outbox-offline.png)

The issues page, with filters and local search (`/`):

![The issues list, searched](docs/screenshots/19-search.png)

More in [docs/FEATURES.md](docs/FEATURES.md).

## Try the example

`examples/next-app` is a small Next.js app (an invented bakery) wiring both packages, with end-to-end
tests. From the repository root:

```sh
npm install
npm run dev          # builds both packages, then http://localhost:3172: press Alt+F (Option+F on a Mac)
```

Pick a person under **Sign in as** in the rail to see the issues pages; filing works signed out too.

## Quick start (Next.js App Router)

Each file below is the example's, with its demo sign-in replaced by your session.

```sh
npm install @jbenet/feedback-react @jbenet/feedback-server
# The default theme's fonts, self-hosted (the automatic screenshot can only embed same-origin fonts):
npm install @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono @fontsource-variable/fraunces
```

**1. The server**: one handler, one store and one ingester per process.

```ts
// lib/feedback.ts
import { join, resolve } from 'node:path';
import { createFeedbackHandler, fileStore, startIngester, type FeedbackHandler, type FileStore } from '@jbenet/feedback-server';
import { userFromRequest } from './auth';           // yours: read the session from the cookie, no database

const root = resolve(process.env.FEEDBACK_DATA ?? join(process.cwd(), '.data'));
const journalDir = join(root, 'inbox');              // reports land here first, fsynced
const issuesDir = join(root, 'issues');              // then filed as NNNN-slug.md with their pictures

const g = globalThis as typeof globalThis & { __feedback?: { store: FileStore; handler: FeedbackHandler } };

export function feedback() {
  if (g.__feedback) return g.__feedback;
  const store = fileStore({ dir: issuesDir });
  startIngester({ journal: journalDir, store });    // titles by Claude if ANTHROPIC_API_KEY is set, else the first sentence
  const handler = createFeedbackHandler({
    journal: journalDir,
    store,
    // Who is filing, from your session; never from the request body.
    resolveReporter: (req) => userFromRequest(req)?.handle ?? null,
    // Who may read issues, see their pictures and change their status. Without it, anyone can.
    authorize: (req) => Boolean(userFromRequest(req)),
  });
  return (g.__feedback = { store, handler });
}
```

**2. The routes**: two catch-all files with the same lines.

```ts
// app/api/feedback/[[...path]]/route.ts   (and app/api/issues/[[...path]]/route.ts, exporting GET and PATCH)
import { nextRoutes } from '@jbenet/feedback-server/next';
import { feedback } from '@/lib/feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST, PATCH } = nextRoutes({ handle: (req) => feedback().handler.handle(req) });
```

**3. The ingester starts with the server**, so reports a restart left behind are filed:

```ts
// instrumentation.ts
export function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  void import('./lib/feedback').then((m) => { m.feedback(); }).catch(() => undefined);
}
```

```ts
// next.config.ts
export default {
  // Plain Node ESM with optional peers: load it at run time rather than bundle it.
  serverExternalPackages: ['@jbenet/feedback-server', '@anthropic-ai/sdk', 'better-sqlite3', 'pg'],
};
```

**4. The client**: a provider, the button, the status line and the shortcuts dialog.

```tsx
// components/Providers.tsx
'use client';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { FeedbackProvider } from '@jbenet/feedback-react';

export function Providers({ userLabel, children }: { userLabel?: string; children: ReactNode }) {
  return <FeedbackProvider pathname={usePathname()} userLabel={userLabel}>{children}</FeedbackProvider>;
}
```

```tsx
// app/layout.tsx
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@jbenet/feedback-react/styles.css';
import type { ReactNode } from 'react';
import { FeedbackButton, FeedbackStatus, KeyboardShortcuts, VIEWPORT_BOOT } from '@jbenet/feedback-react';
import { Providers } from '@/components/Providers';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: VIEWPORT_BOOT }} /></head>
      <body>
        <Providers userLabel="…your user's name…">
          <nav>… <FeedbackStatus /> <FeedbackButton variant="rail" /></nav>
          <main>{children}</main>
          <KeyboardShortcuts />
        </Providers>
      </body>
    </html>
  );
}
```

`suppressHydrationWarning` on `<html>` is needed: the kit sets the `--app-h` viewport height on `<html>` before React hydrates.


**5. The issues pages:**

```tsx
// app/issues/page.tsx
'use client';
import Link from 'next/link';
import { IssuesPage } from '@jbenet/feedback-react';
export default function Issues() { return <IssuesPage Link={Link} />; }       // reads GET /api/issues
```

```tsx
// app/issues/[id]/page.tsx
'use client';
import Link from 'next/link';
import { use } from 'react';
import { IssuePage } from '@jbenet/feedback-react';
export default function Issue({ params }: { params: Promise<{ id: string }> }) {
  return <IssuePage id={use(params).id} Link={Link} editable />;               // the status control PATCHes
}
```

(The example's list page reads the store on the server instead and passes `issues` in; either works.)

Also: add the class `nocapture` to anything that must never appear in an automatic screenshot, and
keep `.data/` (or wherever `FEEDBACK_DATA` points) out of git, because reports and screenshots hold
whatever was on screen. Plain Node, Express, SQLite, Postgres and GitHub Issues are in the
[server README](packages/feedback-server/README.md); every client option is in the
[client README](packages/feedback-react/README.md).

## Build and test

```sh
npm run build        # both packages to dist/ (ESM + .d.ts), then the example
npm run typecheck
npm test             # unit tests: the server package, and the client's capture fallbacks
npx playwright install chromium webkit   # once
npm run e2e          # the example's end-to-end tests, in Chromium and WebKit
```

What the suite cannot check headless (the exact screen capture, real Safari) is listed in
[REBUILD.md §15](docs/REBUILD.md#15-what-cannot-be-tested-headless).

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
- [CHANGELOG.md](CHANGELOG.md).

Screenshots come from `examples/next-app` and show invented data
(`examples/next-app/scripts/screenshots.mjs` retakes them).

## License

MIT, © Juan Benet. See [LICENSE](LICENSE).
