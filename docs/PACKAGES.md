# Packages

What the feedback module depends on, the versions Capital OS runs (installed versions as of
29 Sep 2026), and why each is there. Everything else (the outbox, drafts, the journal, the region
picker, the annotation editor, the markdown renderer, the frontmatter reader and writer) is written
by hand on browser and Node built-ins, on purpose: each is small, and each had bugs a library would
have hidden.

## Client (`packages/feedback-react`)

| Package | Version in Capital OS | Kind | Why |
|---|---|---|---|
| `react`, `react-dom` | 19.3.0 | peer | Components, portals (`createPortal` to `<body>`), `useSyncExternalStore` for the outbox state. React 18 should work; 19 is what is tested. |
| `modern-screenshot` | 4.7.0 | dependency, loaded with a dynamic `import()` when the first capture runs | The automatic screenshot: `domToPng` clones the DOM into an SVG `foreignObject` and rasterises it. Unlike `html2canvas`, which re-implements CSS layout in JavaScript, it lets the browser lay the page out, so modern CSS draws as it does on screen. The hooks the capture depends on: `onCloneEachNode` (fix overflow, table heights, pinned elements), `onCreateForeignObjectSvg` (inject a rule), `filter` (redaction and culling), `features.restoreScrollPosition`, per-resource `timeout`. |
| `@tiptap/react` | 3.31.3 | dependency | The rich description editor (ProseMirror underneath), React node views for inline images with their own Annotate and × buttons. |
| `@tiptap/starter-kit` | 3.31.3 | dependency | Paragraphs, bold, italic, code, headings (limited to h3–h4), lists, blockquote, and in v3 the Link extension (do not add Link separately; it registers twice). |
| `@tiptap/extension-image` | 3.31.3 | dependency | Image nodes, extended to serialise as blocks and render the embed view. Configure `allowBase64: true`. |
| `@tiptap/pm` | 3.31.3 | dependency | `NodeSelection` from `@tiptap/pm/state`, to insert after a selected image instead of replacing it. |
| `tiptap-markdown` | 0.9.0 | dependency | Markdown in and out of the editor (`getMarkdown()`), paste as markdown. It escapes `<`, `>`, `&` as entities with `html: false`; the field unescapes them. |

Not dependencies: no markdown library for rendering (a ~260-line parser that returns blocks, rendered
to React elements, shared by the preview and the issue page); no state library; no IndexedDB wrapper
(two tiny ones, because Safari needs per-transaction connections and an open timeout); no UUID
library (`crypto.randomUUID`, with a `getRandomValues` fallback for plain http); no drag library
(Pointer Events).

### Fonts (host app)

The redraw can only embed fonts from same-origin stylesheets. Capital OS self-hosts its fonts from
`@fontsource/ibm-plex-sans` 5.3.0, `@fontsource/ibm-plex-mono` 5.3.0 and
`@fontsource-variable/fraunces` 5.3.0 (Latin subsets). Before that, fonts came from Google Fonts,
the capture fell back to wider fonts, and text re-wrapped. Any app using the kit should self-host its
fonts the same way. The default theme uses these three families through CSS variables; they are
optional.

## Server (`packages/feedback-server`)

| Package | Version | Kind | Why |
|---|---|---|---|
| Node.js | ≥ 20 | runtime | `node:fs/promises` (`open` with `wx`, `FileHandle.sync`, `link`, `rename`), `node:crypto` (`randomBytes`, `timingSafeEqual`, `createHash`). The journal and the files store need nothing else. |
| `next` | 16.3.5 in Capital OS | optional peer | Route handler adapters and `instrumentation.ts` to start the ingester. A plain Node adapter is included for anything else. |
| `better-sqlite3` | ≥ 11 (13.0.3 in development) | optional peer | The SQLite store. |
| `pg` | ≥ 8 (8.23.0 in development) | optional peer | The Postgres store. |
| `@anthropic-ai/sdk` | ≥ 0.60 (0.129.0 in development) | optional peer | The AI title adapter. Any model can be used through the title hook instead. |
| GitHub REST API | `2022-11-28` | via `fetch` | The GitHub store uses plain `fetch`, no Octokit, to keep rate-limit handling explicit. |

Not dependencies: no YAML library (the frontmatter is a closed set of scalars and string lists, written
by hand so field order and comments survive); no job queue (the ingester is a timer and a folder); no
separate journal process.

## Development and tests

| Package | Version in Capital OS | Why |
|---|---|---|
| `typescript` | 7.0.2 | Types; `tsc --noEmit` in the gate. |
| `playwright` | 1.63.0 | End-to-end tests and the doc screenshots: Chromium for most checks, WebKit with touch emulation for the region picker. Playwright's WebKit cannot drag with a finger, so touch drags are driven with synthetic `PointerEvent`s; a real iPad remains the final check. |
| `sharp` | 0.35.4 | Generating invented test images and comparing captures. |
| `tsx` | 4.23.13 | Running TypeScript scripts and property tests in Node. |
| `@electric-sql/pglite` | 0.5.8 | Postgres semantics in-process for the SQL store's tests. |

## Browser APIs relied on

`IndexedDB`, `localStorage`, `BroadcastChannel`, `fetch` with `keepalive` and `AbortController`,
`navigator.mediaDevices.getDisplayMedia` (optional; absent on iOS/iPadOS Safari),
`document.fonts.ready`, Pointer Events with `setPointerCapture`, `ResizeObserver`,
`window.EyeDropper` (optional, Chromium), `crypto.getRandomValues`, `<dialog>.showModal()`,
`useSyncExternalStore`, CSS `:has()` (for the shortcut hint; cosmetic where missing).
