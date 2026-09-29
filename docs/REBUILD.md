# Rebuilding the feedback module from scratch

This is the specification for an agent (or a person) rebuilding the feedback module in any React app
without the PL LabOS tools source. It describes behaviour, contracts, constants and the failures each
rule exists to prevent. The server side is in [SERVER.md](SERVER.md); the user-facing tour is in
[FEATURES.md](FEATURES.md).

Words: **MUST** is required for the acceptance tests in [§14](#14-acceptance-tests) to pass.
**SHOULD** is what PL LabOS tools does and the kit keeps unless there is a reason. Constants marked
**GUESS** were chosen, not measured; keep them unless you measure better ones.

Contents:

1. [Architecture](#1-architecture)
2. [The wire contract](#2-the-wire-contract)
3. [Components](#3-components)
4. [State machines](#4-state-machines)
5. [The capture pipeline](#5-the-capture-pipeline)
6. [The region picker](#6-the-region-picker)
7. [The annotation editor](#7-the-annotation-editor)
8. [The markdown field](#8-the-markdown-field)
9. [Drafts](#9-drafts)
10. [The outbox and the sender](#10-the-outbox-and-the-sender)
11. [Keyboard](#11-keyboard)
12. [The issues pages](#12-the-issues-pages)
13. [Accessibility, theming and layout](#13-accessibility-theming-and-layout)
14. [Acceptance tests](#14-acceptance-tests)
15. [What cannot be tested headless](#15-what-cannot-be-tested-headless)

---

## 1. Architecture

```
 FeedbackButton ──opens──▶ FeedbackDrawer ────────────────────────────┐
   (Alt+F)                  ├ screenshots ─▶ capture (redraw | screen) ─▶ RegionPicker
                            │                 └▶ ShotEditor (annotate)
                            ├ MarkdownField (TipTap) ─▶ dropped images ─▶ ShotEditor
                            ├ kind, priority
                            └ File it ─▶ outbox.enqueue(report)
                                          │  IndexedDB (fallback localStorage)
                                          ▼
                              POST /api/feedback  ──202──▶ server journal (disk) ─▶ ingester ─▶ store
                                          │                                          (files, SQL, GitHub)
                              GET /api/feedback?clientId=  ◀── "filed as 0024"
 FeedbackStatus ◀── outbox state (useSyncExternalStore) ──▶ OutboxList (Retry now, Copy text, Discard)
 IssuesPage, IssuePage ◀── GET /api/issues, /api/issues/:id, /api/issues/attachments/<path>
```

Client modules, each small and independently testable:

| Module | Browser? | Responsibility |
|---|---|---|
| `journal` | no | Backoff schedule, response classification, entry transitions, send timeout, display helpers. Pure. |
| `outbox` | yes | IndexedDB/localStorage storage, the sender loop, tab sync, the observable state. |
| `drafts` | yes | Per-page draft words (localStorage) and pictures (IndexedDB). |
| `capture` | yes | Redraw and screen capture, region crop, timeouts. |
| `request-key` | both | Client ids that work outside secure contexts. |
| `keyboard` | both | Shortcut predicates and the shortcut table. |
| `markdown` | both | A small parser for rendering bodies (headings, paragraphs, lists, code, quotes, tables, rules, inline code/bold/italic/links/images). |

Keep the pure rules (`journal`, `keyboard`, title fallback, frontmatter) free of browser and server
imports so they can be property-tested in Node.

## 2. The wire contract

### 2.1 POST `{base}/api/feedback`

JSON body. Every field optional on the wire; the server decides.

```ts
interface FeedbackRequest {
  clientId: string;          // idempotency key, /^[A-Za-z0-9-]{8,64}$/ (a UUID)
  body: string;              // markdown; images as ![name](attachment:N)
  kind?: 'bug' | 'request' | 'question' | 'chore';        // default bug
  priority?: 'P0' | 'P1' | 'P2' | 'P3';                   // default P2
  page: string;              // the route when filed, e.g. "/orders"
  context: {
    route: string;           // same as page
    url: string;             // location.href
    filters: Record<string, string>;   // Object.fromEntries(new URLSearchParams(location.search))
    startedOn?: string;      // the draft's page, when it differs from page
    capture?: { misaligned: number[] };  // screenshots (1-based) the reporter flagged "Misaligned? Tell us"
    client: { userAgent: string; viewport: string /* "1440×900" */; pixelRatio: number; touch: boolean };
  };
  screenshots: string[];     // PNG data URLs, in list order
  images: Array<{ name?: string; dataUrl: string }>;     // PNG/JPEG/GIF/WebP data URLs, in token order
  imageOffset: number;       // = screenshots.length (see below)
}
```

There is **no title**. (PL LabOS tools sent `title`; the kit's server still accepts one from API callers
and keeps it.)

**Attachment numbering.** The server lays attachments out as `[...screenshots, ...images]`. The body
numbers only its own images, from 1. So body token `attachment:N` refers to array slot
`N - 1 + imageOffset`. Send `imageOffset = screenshots.length`.

`viewport` uses the multiplication sign `×` (U+00D7), `${innerWidth}×${innerHeight}`.
`touch` is `navigator.maxTouchPoints > 0`.

### 2.2 Responses the client must understand

| Status | Body | Client outcome |
|---|---|---|
| 202 (any 2xx) | `{ journaled: true, clientId, repeat, id? }` with `clientId` equal to the one sent | **journaled**: drop the local copy. If `id` (digits) is present it was already filed. |
| 2xx | `{ id: "0024", clientId }` (legacy, filed synchronously) | **filed** |
| 2xx | anything else (a proxy's 200, an HTML page, another report's id) | **retry**: "The server answered without confirming it kept the report" |
| 4xx except 408, 429 | `{ error }` | **refused**: keep, stop the clock, show `error` |
| 408, 429, 5xx | `{ error }`? | **retry** on the clock |
| network error / timeout | — | **retry**; message "Could not reach the server" or "No answer within N s" |

Acceptance is only a 2xx that says it journaled (or filed) **and echoes this entry's client id**.

### 2.3 GET `{base}/api/feedback?clientId=…`

Reads the journal only (never the database). `{ state: 'journaled' }`, `{ state: 'filed', id, location }`
(`location`: the issue's file name or URL), `{ state: 'refused', error }`, or 404 `{ state: 'unknown' }`.

The POST can also answer **422** `{ error, clientId, state: 'refused' }` (this client id was refused for
good) and **429** `{ error, clientId }` with `retry-after` (the per-reporter rate limit). By §2.2 the first
is refused and the second retried on the clock.

### 2.4 Reads for the issues pages

`GET {base}/api/issues` → `{ issues: Issue[], destination, store }`; `GET {base}/api/issues/:id` →
`{ issue }`; `GET {base}/api/issues/attachments/<path>` → image bytes; `PATCH {base}/api/issues/:id`
`{ status?, priority?, kind?, labels? }` → `{ issue }` (same-origin only). The client reads `issues`
(or `items`, or a bare array). Every one of these goes through the server's `authorize(req, action)`
hook; an app must supply it, or its issues are readable by anyone who can reach it. Shapes in
[§12](#12-the-issues-pages) and SERVER.md.

## 3. Components

The names below are the kit's exports from `@jbenet/feedback-react`: `FeedbackButton`, `FeedbackDrawer`
(the panel), `FeedbackStatus` and `OutboxList` (the status mark and the outbox), `KeyboardShortcuts`,
`RegionPicker`, `ShotEditor`, `MarkdownField`, `Markdown`, and `IssuesPage`, `IssuePage`, `IssueList`,
`IssueDetail`, `IssueVelocity`. Configuration (endpoints, shortcut, storage prefix, theme, user label)
comes from an optional `FeedbackProvider`; see the package README.

### 3.1 `FeedbackButton`

- `variant="rail" | "bar" | "floating"`. Renders a button labelled "Feedback" (a pencil glyph `✎` in the
  rail variant, "Give feedback" otherwise), `title="Give feedback (Alt+F)"`,
  `aria-keyshortcuts="Alt+F"` (both follow the configured shortcut), and a hint span `.feedbackkey`
  (`Option+F` on Apple platforms, `Alt+F` elsewhere)
  hidden by default and shown when the global shortcuts dialog is open
  (`body:has(.shortcuts-dialog[open]) .feedbackkey { display: inline }`).
- Starts the outbox sender on mount (`startOutbox()`), so a report kept by an earlier page is sent
  from any page with the button.
- Listens on `document` for the open shortcut ([§11](#11-keyboard)) and opens the panel unless a
  dialog is already open: `document.querySelector('dialog[open], [role="dialog"]:not(dialog):not([hidden])')`.
- Platform detection for labels: `/Mac|iPad|iPhone|iPod/i.test(navigator.platform)`, evaluated after
  mount (SSR renders the non-Apple label, then corrects).

### 3.2 `FeedbackDrawer` (the panel)

A `role="dialog" aria-label="Give feedback"` drawer, portalled to `document.body` after mount, over a
scrim. Both carry `nocapture`. Clicking the scrim closes the panel (the draft is kept).

State:

```ts
shots: Shot[]            // { id, dataUrl, method: 'render' | 'screen', annotated }
images: DroppedImage[]   // { index (1-based, = attachment:N), name, contentType, dataUrl, annotated? }
body: string; kind; priority
draftPage: string        // the page whose draft is being edited (initially the current route)
state: 'idle' | 'saving' | 'saved' | 'failed'; error: string | null
shooting: boolean        // a capture in progress: panel and scrim get class "away" (opacity 0, pointer-events none)
picking: boolean         // region picker up: same
failed: boolean          // last explicit capture returned nothing
editingShot: string | null; editingImage: number | null
imagesPending: boolean   // the markdown field is still reading files
wide: boolean            // localStorage "<prefix>.feedback.wide" === "1" (prefix default "feedbackkit")
showKeys: boolean; showDrafts: boolean
generation: number       // bumped per loaded draft; used as the MarkdownField's React key
```

Layout, top to bottom (narrow) or in two columns (wide: `grid-template-columns: minmax(0,1.45fr)
minmax(300px,1fr)`, width `min(1120px, 80vw)`): header (the panel's own `<h2>` "Feedback", Drafts · N,
Wider/Narrower — no intro sentence under it), screenshots column (list, Whole page, Pick a part, a
`(?)` help toggle, failure line), text column (restored-draft line, description, kind and priority —
each priority's meaning is in its own `<option>`, not a paragraph, the failure box), actions
(File it, Cancel), key hint, folded context (`<details>` with the JSON, `JSON.stringify(context, null, 2)`).

**File it** is disabled while `body.trim() === ''`, while saving, and while `imagesPending`.

### 3.3 The screenshots column (inside `FeedbackDrawer`)

Each thumbnail: a button containing the image (`max-height: 190px; object-fit: cover; object-position:
top`) that opens the annotator, an overlay bar with **✎ Annotate** and **×**
(`aria-label="Remove screenshot N"`), and a meta row: the method label (`Drawn from the page` /
`Captured from your screen`), an `annotated` flag, and, for `render` shots only, a
**Misaligned? Tell us** toggle button (`aria-pressed`; it reads "Misaligned · noted" when on) whose
`title` explains the redraw and points to the exact buttons. The flagged screenshots' numbers go in
`context.capture.misaligned`, and a line thanks the reporter and says Whole page gives exact pixels.
Beside the two buttons, a `(?)` (`role="note"`, focusable, `aria-label="About screenshots"`) carries
what used to be a paragraph under them, as its `title`: "Optional — the report files without one."
when empty, else "Adds another; it does not replace what is already here." plus "Both use your
browser's screen capture for exact pixels where it can, and it will ask permission." plus "Click a
screenshot to annotate it; use its × to delete it." It shows on hover or keyboard focus rather than
sitting on the page unasked.

### 3.4 `RegionPicker` — [§6](#6-the-region-picker). 3.5 `ShotEditor` — [§7](#7-the-annotation-editor). 3.6 `MarkdownField` — [§8](#8-the-markdown-field).

### 3.7 `Markdown` (renderer)

One renderer shared by the panel preview and the issue page, so what the reporter saw is what the
issue shows. It produces React elements, never HTML strings (no `dangerouslySetInnerHTML`), so the
stored body can contain `<`, `>` and `&` literally. It takes `resolveImage(href) → url | null`: in the
panel an `attachment:N` resolves to the local data URL; on the issue page `attachments/…` resolves to
the attachment endpoint. An image that cannot be resolved renders "image not attached: name". External
links open in a new tab with `rel="noreferrer"`.

### 3.8 `FeedbackStatus` and `OutboxList`

`FeedbackStatus` (`variant="rail" | "bar"`) is a small button (`.obchip`, `aria-live="polite"`,
`title="Where your feedback stands"`) showing a glyph and the summary in words; it renders nothing when
there is nothing to say. A click (not a hover, for touch screens) opens `OutboxList`
(`role="dialog" aria-label="Feedback waiting to file"`), anchored above the chip, with each waiting
report and **Retry now**, **Copy text** and **Discard**. It closes on Esc and on a scrim click.
[§10.6](#106-what-the-status-mark-says) gives the words. (PL LabOS tools put a popover with **Show the
notes** between the mark and the list; the kit opens the list directly.)

### 3.9 `KeyboardShortcuts`

A native `<dialog class="shortcuts-dialog">` opened with `showModal()` by `?` outside text fields
when no other dialog is open; closed by `?`, Esc, the Close button or a click on the backdrop; returns
focus to the element that had it. It lists groups from one table ([§11](#11-keyboard)); the panel's keys
card renders the "Feedback box" group from the same table.

## 4. State machines

### 4.1 The panel

```
closed ──open (button, Alt+F)──▶ loading-draft ──▶ editing
editing ──Pick a part──▶ picking ──pick──▶ shooting ──▶ editing (+1 shot)   [cancel ▶ editing]
editing ──Whole page──▶ shooting ──▶ editing (+1 shot | failed=true)
editing ──Annotate──▶ annotating ──Done──▶ editing (shot replaced, annotated) [Cancel ▶ editing]
editing ──File it / ⌘↵──▶ saving ──kept in outbox or on server──▶ saved ──▶ closed (draft discarded)
                                 └─neither──▶ failed (panel stays, draft kept, reason shown)
editing ──Esc / Cancel / scrim──▶ closed (draft kept)
```

On open: `load(currentRoute)`. If a draft exists for the route, restore its words at once and, if it
recorded pictures, clear `shots`, set `hydrating`, read the pictures from IndexedDB, then clear
`hydrating`. If it recorded none, keep `shots` empty (the reporter deleted them). If no draft exists,
take the automatic screenshot. While `hydrating`, never write the draft (a half-loaded state would
overwrite the stored pictures) and do not allow filing.

### 4.2 A draft

```
none ──first worth-keeping change──▶ kept (words in localStorage, pictures in IndexedDB)
kept ──every change──▶ kept (rewritten)          kept ──content no longer worth keeping──▶ none
kept ──filed (state saved)──▶ none               kept ──Discard (confirmed)──▶ none
```

`worthKeeping = body.trim() !== '' || shots.some(s => s.annotated) || images.length > 0`.

### 4.3 An outbox entry

```ts
interface JournalEntry {
  clientId: string; createdAt: string;
  attempts: number;          // sends that ended without confirmation
  nextAt: number;            // epoch ms when the clock may send it again
  lastError: string | null;
  refused: boolean;          // a 4xx: waits for Retry now
  textOnly?: boolean;        // kept in localStorage without pictures
  request: FeedbackRequest;
}
```

```
new ──add──▶ stored ──send──▶ journaled|filed ──▶ removed (then watched on the server until filed)
                       └──▶ retry:   attempts+1, lastError, nextAt = now + delay(attempts)
                       └──▶ refused: attempts+1, lastError, refused = true (nextAt set but ignored)
refused ──Retry now──▶ refused=false, nextAt=0 ──▶ send
any ──Discard (confirmed)──▶ removed
```

`delay(n)`: 5 s, 15 s, 60 s for n = 1, 2, 3, then 120 s for every n ≥ 4 (GUESS). `due(entry, now,
kicked) = !entry.refused && (kicked || entry.nextAt <= now)`.

### 4.4 Submit

```
submit():
  if body.trim() === '' or state ∉ {idle, failed} or imagesPending or hydrating: return
  state = 'saving'
  { body, images } = packAttachments(body, images)        // §8.4
  try  await enqueue({ body, kind, priority, page, context, screenshots, images, imageOffset: shots.length })
  catch e: state = 'failed', error = e.message; return    // neither browser nor server kept it
  state = 'saved'; discardDraft(draftPage); close()
```

`enqueue` keeps the entry (IndexedDB, else localStorage without pictures, else nowhere), marks it
`justSaved`, sends it once and waits for that one answer. It throws only when nothing could be kept
locally **and** the server did not accept it.

## 5. The capture pipeline

### 5.1 Two methods

| | Redraw (`render`) | Screen (`screen`) |
|---|---|---|
| How | Clone the DOM into an SVG `foreignObject`, rasterise (`modern-screenshot`'s `domToPng`) | `navigator.mediaDevices.getDisplayMedia`, one video frame to a canvas |
| Prompt | none | every time |
| Redacts `.nocapture` | yes | no |
| Fidelity | near exact after the fixes below | exact |
| Used for | the automatic screenshot on open | **Whole page** and **Pick a part** |

Every capture MUST race a 12 s timeout and resolve `null` on timeout or error. The panel MUST come
back (`shooting = false` in a `finally`) whatever happens.

### 5.2 The redraw, step by step

1. **Pin sticky and fixed elements** (only when scrolled). The clone has no scroll: it is the page
   drawn once and translated up by the scroll, so anything `position: sticky` or `fixed` would move up
   with it. For every element under `body` whose computed position is sticky or fixed, compute how far
   to move it back: for fixed, `(scrollX, scrollY)`; for sticky, measure its rect, set
   `style.position = 'relative'`, measure again, restore, and use the difference. Mark it
   `data-capture-shift="dx px dy px"`. A fixed `body::before/::after` cannot be marked; emit a CSS rule
   `body::before{translate: sx px sy px !important}` into the clone's SVG instead. Remove all marks
   afterwards (in `finally`).
2. **Wait for fonts**: `await document.fonts.ready`.
3. **Render** `document.body` with:
   - `width = innerWidth`, `height = innerHeight`;
   - `scale = min(2, devicePixelRatio || 1, 2000 / innerWidth)` (cap output at 2000 px wide);
   - `backgroundColor = getComputedStyle(body).backgroundColor`;
   - root style `margin: 0` (the clone's root is a `<body>` again, and would get the default 8 px
     margin), `transform: translate(-scrollX px, -scrollY px)`, `transformOrigin: top left`;
   - `features: { restoreScrollPosition: true, copyScrollbar: false }` so scrolled panels are drawn at
     their scroll and no phantom scrollbars appear;
   - `timeout: 6000` per resource;
   - `onCloneEachNode`: for elements only (check `nodeType`, not `instanceof`: the clone may belong to
     another window), set `overflow`, `overflow-x`, `overflow-y` of `auto|scroll|overlay` to `hidden`;
     on `TABLE, TBODY, THEAD, TFOOT, TR` remove `height` and `block-size` (see pitfalls); apply
     `data-capture-shift` as `style.translate` and drop the attribute;
   - `filter(node)`: drop `.nocapture`; drop `IMG` wholly outside the viewport; drop any element whose
     box starts below or right of the viewport (`rect.top > h || rect.left > w`); keep boxless elements
     (`display: contents`, `0×0`) and pinned ones. Never drop what is above or left: that would shift
     what is on screen.
4. **Crop** (when a region is given): draw the full PNG onto a canvas at
   `(r.x*scale, r.y*scale, r.w*scale, r.h*scale)`. Region coordinates are CSS pixels of the viewport.

### 5.3 The screen capture, step by step

Call it **directly from the click handler** (it needs transient user activation; awaiting anything
first loses it). Options: `{ audio: false, video: { displaySurface: 'browser' }, preferCurrentTab: true,
selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' }` (the
last four are Chromium hints). Hide the panel first (`requestAnimationFrame` after setting `shooting`),
play the stream into a muted `playsInline` video, wait **two** animation frames (the first is often
blank), read `videoWidth/videoHeight`, and always stop every track in `finally`.

To crop: `sx = videoWidth / innerWidth`, `sy = videoHeight / innerHeight`. If `|sx − sy| / max(sx, sy)
> 0.04`, the person shared a window or screen, not this tab: return `mismatch`, and the caller redraws
the region instead with a note saying so. Otherwise draw `(r.x*sx, r.y*sy, r.w*sx, r.h*sy)` into a
canvas capped at 2000 px wide. If the screen capture returns nothing (declined, unsupported, timed
out), fall back to the redraw.

### 5.4 Pitfalls, each of which shipped once

- **Fonts.** The clone embeds only `@font-face` rules it can read. A cross-origin stylesheet (Google
  Fonts) cannot be read, so the clone falls back to wider fonts and text re-wraps. **Self-host fonts
  on the same origin** (e.g. `@fontsource/*` packages). Document this for host apps; it is the largest
  single source of mismatch (12.5% of pixels differed before, 0.04% after all fixes, at 1440×940).
- **Body margin.** Without `margin: 0` on the clone root the page is drawn 8 px down and right and
  16 px narrower.
- **`devicePixelRatio`.** Never assume it when cropping a screen frame: the frame may have been scaled.
  Measure frame ÷ viewport per axis. (Cropping a pre-shrunk 2000 px frame with `devicePixelRatio` put the
  rectangle 44% off on a 2× screen.)
- **Scroll offsets.** Translate the clone by `-scrollX/-scrollY`, pin sticky/fixed elements, and draw
  scrolled inner panels at their scroll.
- **Tables.** The filter drops rows below the fold, but a table keeps its measured height, so the
  remaining rows were stretched hundreds of pixels tall. Remove explicit heights from table parts.
- **Huge pages.** Inlining every image on a page with 125 screenshots ran until nobody was waiting.
  Drop images and elements outside the viewport, and time out.
- **Cross-origin images** cannot be inlined without CORS; they render blank. Serve app images from the
  same origin or with `Access-Control-Allow-Origin`, and accept blanks otherwise.
- **iframes** are not drawn by the redraw (their documents are not cloned). Use the screen capture for
  pages that matter inside iframes, and say so in the Misaligned tooltip if the host app embeds them.
- **Canvas and video** content is copied as a frame where the library can read it; a tainted
  (cross-origin) canvas cannot be read.
- **Safari.** `getDisplayMedia` is not available on iPadOS/iOS Safari: the buttons fall back to the
  redraw. The redraw on a long page on iPad ran out the timeout; culling below the fold fixed it. Test
  the redraw on Safari explicitly; it is where most "sometimes fails" reports come from.
- **Scrollbars.** Set `copyScrollbar: false` and force `overflow: hidden` in the clone.

### 5.5 What to tell users

Keep the **Misaligned? Tell us** toggle on every redraw. A mismatch is a capture bug; the flag travels
with the report (`context.capture.misaligned`), and a **Whole page** capture beside the automatic one
gives the two pictures to compare.

## 6. The region picker

A fixed full-viewport surface (`position: fixed; inset: 0; z-index` above the panel), class
`regionpick nocapture`, `role="dialog" aria-label="Drag to choose a part of the page"`, cursor
crosshair, dimmed background, `touch-action: none; overscroll-behavior: contain; user-select: none;
-webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent`.
The panel is hidden while it is up.

- **Selection** is drawn as a transparent box with a 2 px accent border and a huge spread
  `box-shadow` (`0 0 0 9999px rgba(...)`) that dims everything outside it. A size label `W × H`
  (rounded CSS px) sits 22 px above the box.
- **Pointer events only** (`pointerdown/move/up/cancel`), one pointer at a time: record the
  `pointerId` of the drag and ignore others. On `pointerdown`: ignore the bar, ignore non-primary mouse
  buttons, `preventDefault()`, and `setPointerCapture` on the **surface** (not the child it landed on),
  in a try/catch. Clamp every point to the viewport.
- **Drag kinds:** `draw` from a point (remembering the previous selection), `corner` (the opposite
  corner fixed, and the offset within the 44 px handle where the finger landed, so the corner does not
  jump), `move` (inside the current selection, only while adjusting; clamp so it stays in the viewport).
- **Release:** a `draw` smaller than 8 px on either side restores the previous selection (a mis-tap).
  With `pointerType === 'mouse'` and not adjusting, release **picks**. With touch or pen, release enters
  **adjusting**: four corner handles (`.regionhandle`, 44×44 px, `margin: -22px`, a 14 px visible dot,
  resize cursors) and a **Use this part** button.
- **`pointercancel`**: restore the selection from before this drag (for `draw`) or the original (for
  `move`).
- **Safari:** React attaches touch listeners as passive, so add `touchmove` (`{ passive: false }`),
  `gesturestart` and `gesturechange` listeners directly on the element and `preventDefault()` them
  (if `cancelable`). Also suppress `contextmenu`.
- **Bar:** fixed, centred, 26 px from the bottom; moves to the top when the selection's bottom is
  within 96 px of the viewport bottom and its top is more than 96 px down. Text: "Drag over the part you
  want", or while adjusting "Drag a corner to adjust, or draw again". Buttons: **Use this part**
  (adjusting only; disabled if the selection is under 8 px) and **Cancel** (`title="Esc"`). On
  `(pointer: coarse)` buttons are at least 44 px tall.
- **Keys:** Esc cancels; Enter picks the current selection. Bind once on `window`; read the latest
  `onPick` through a ref.
- **Pick once:** guard with a `done` ref so a double release cannot capture twice.

## 7. The annotation editor

Full-screen over everything (`nocapture`), editing one image (a screenshot or a dropped image):

- Base image drawn on a canvas at its natural size; the canvas is scaled to fit on screen.
- Marks: `pen` (points), `arrow` and `line` (from, to), `box` (from, to), `text` (id, colour, size in
  image pixels, position, wrap width, a `sized` flag once the corner is dragged, a min height, text with
  newlines, bold). Default tool: pen. Default colour: the accent (clay `#BF4A16`). Palette: `#BF4A16`,
  `#0E7F55`, `#5F4B9E`, `#1A1917`, `#FFFFFF`, a custom `<input type="color">` (it takes `#rrggbb` only;
  normalise `rgb()` and `#rgb`), and `EyeDropper` where it exists (do not draw the button elsewhere; while
  it is open, ignore Esc).
- Keep marks in a ref as well as state: clicking Done blurs a label field, which commits it, and a
  click handler in the same tick still sees the old state. (The first label ever typed went missing
  from the saved image because of this.)
- Undo/redo stacks; a new mark clears redo. ⌘Z undo, ⌘⇧Z or ⌘Y redo, outside text fields. Clear moves
  every mark to the redo stack.
- Text labels are DOM elements while editing (move, resize by the corner, double-click to retype), and
  are painted onto the canvas only on export, with the same wrapping as the field: explicit newlines,
  then greedy wrap at the label width, spaces kept, over-long words broken. Load the label font with
  `document.fonts.load` and re-measure labels when it arrives. Line height 1.3.
- Sizes 8–400, typed or from presets 12–128. A half-typed number is not clamped until the field is left
  or Enter is pressed.
- Esc order: leave the text field keeping its text, then deselect the label, then close the editor
  (Cancel). ⌘Enter leaves a label field.
- **Done** exports `canvas.toDataURL('image/png')` and replaces the image; it is then `annotated`.

## 8. The markdown field

### 8.1 Editor

TipTap v3 with `StarterKit` (headings limited to levels 3–4; the StarterKit's own Link with
`openOnClick: false`, do not register Link twice), an **Image** extension configured `inline: false,
allowBase64: true` (without `allowBase64`, any rebuild from markdown silently drops the data-URL images
from the view), and `tiptap-markdown` with `html: false, transformPastedText: true, breaks: true`. Create
the editor with `immediatelyRender: false` (SSR).

Toolbar (rich mode): Bold, Italic, Code, Heading (h3), Bullet list, Numbered list, Quote; each an
`aria-pressed` toggle re-rendered on `selectionUpdate` and `transaction`. Tabs: **Rich** / **Markdown**
(`aria-pressed`). **Add images** opens a hidden `<input type="file" multiple
accept="image/png,image/jpeg,image/gif,image/webp">`; reset its value after reading.

### 8.2 Two representations

- **Stored** markdown refers to images as `![name](attachment:N)`.
- **Displayed** markdown swaps each token for `(<dataUrl> "attachment:N")`: the number rides in the
  image **title**, because two identical pictures have identical data URLs and the URL alone cannot say
  which attachment a node is.
- `toStored` reverses both forms `(<dataUrl> "attachment:N")` and `(<dataUrl>)` back to
  `(attachment:N)`.

### 8.3 Rules that each fixed a real bug

- **Serialize images as blocks.** The stock serializer is inline and wrote the next paragraph onto the
  image's line (`![shot](attachment:1)More words.`). Override the image node's markdown `serialize` to
  write `![alt](src "title")` (escape `()` in src, `"` in title) and then `state.closeBlock(node)`.
- **Unescape entities** after `getMarkdown()`: `&lt;` → `<`, `&gt;` → `>`, then `&amp;` → `&` (last,
  so a typed `&gt;` survives).
- **Do not round-trip while the Markdown tab is open.** The textarea owns the text (`source` state)
  until Rich is chosen; then `setContent(toDisplay(source), { emitUpdate: false })` and propagate. A
  controlled textarea fed through TipTap trimmed, escaped and moved the cursor.
- **Ignore your own echoes.** `onUpdate` sets an `ours` flag; the effect that pushes an outside
  `value` into the editor skips once when set, never emits an update, and compares `toStored(serialize)`
  with `value` first.
- **Redraw after an image changes.** When an existing image's data URL changes (it was annotated),
  `setContent(toDisplay(value), { emitUpdate: false })`; otherwise the old picture would be serialized as
  a raw data URL on the next keystroke. Do the same when draft words arrived before their pictures
  (unresolved `attachment:N` sources in the doc). Do not redraw on add: the editor already inserted it,
  and a redraw throws the cursor to the end.
- **Insert, do not replace.** Insert each new image followed by an empty paragraph, at the selection,
  or just after a selected image node (`NodeSelection`), with `insertContentAt`. `setImage` left the new
  image selected, so the next file replaced it.
- **Files first.** Listen with `onDropCapture` and `onPasteCapture` on a wrapper, so files are taken
  before ProseMirror handles the accompanying HTML. Only act when `dataTransfer.files` /
  `clipboardData.files` is non-empty; `preventDefault` and `stopPropagation`.
- **Serialize reads.** Queue each batch (`ingest = ingest.then(...)`) so overlapping pastes and drops
  are inserted in arrival order; count pending batches and report `onPendingChange(true/false)`.
- **Validate** type (PNG, JPEG, GIF, WebP) and size (8 MB); report refusals in one line ("Not attached:
  1 file that is not a PNG, JPEG, GIF or WebP · 1 over 8 MB. Everything else went in.") and insert the
  rest. Number new images from `max(existing index) + 1`.
- In Markdown mode, insert `\n![name](attachment:N)\n` at the textarea selection.

### 8.4 `packAttachments(body, images)`

Only images referenced in the body are sent. Walk `(attachment:N)` in order of first appearance, keep
those that exist, renumber them 1..k in that order, rewrite the body's tokens to match (tokens that
refer to nothing are left as they are), and return the images in that order with their new indexes.

### 8.5 Hint line

Rich: "Rich text, stored as markdown. **Markdown** shows the file it becomes." Markdown: "The markdown
that gets stored. **Rich** renders it." Then "**Drop or paste images** anywhere in this box." and, when
any, "N in the text — only those are sent."

## 9. Drafts

Storage (prefix configurable with `storagePrefix`, default `feedbackkit`):

| What | Where | Key |
|---|---|---|
| Words | localStorage | `<prefix>.feedback.draft:<page>` → `{ body, kind, priority, at, pictures }` |
| Pictures | IndexedDB `<prefix>-feedback`, store `pictures` | key `<page>` → `{ shots: Shot[], images: DroppedImage[] }` |
| Wide | localStorage | `<prefix>.feedback.wide` = `"1"` / `"0"` |

- Write words on every change of body/kind/priority/shots/images/draftPage, with `at = now` and
  `pictures = shots.length + images.length`; delete the key when not worth keeping. Never write while
  hydrating or after `saved`.
- Write pictures on every change of shots/images; `delete` when there are none.
- IndexedDB: open per transaction and close after; run transactions one at a time through a promise
  queue, so a late autosave cannot overtake a newer save or a discard, and a reopen waits for the last
  write.
- `listDrafts()`: scan localStorage keys with the prefix; title = first non-empty body line with
  leading `#>*-` and spaces stripped, else "No words yet"; newest first.
- Switching to another draft: the current one is already saved; load the other (words now, pictures
  when IndexedDB answers). If the current content is not worth keeping, carry the current screenshots
  over when the other draft has none.
- Every storage call is wrapped; failure means "not kept".

## 10. The outbox and the sender

### 10.1 Storage

IndexedDB database `<prefix>-outbox`, store `entries`, `keyPath: 'clientId'`. Open with a 2 s timeout
(GUESS; older Safari can leave `open` pending forever) and treat `onblocked` as failure. Open and close
per transaction (Safari drops long-held connections: "Connection to Indexed Database server lost"). Do
read-then-write inside one transaction with plain callbacks, not awaited promises, so the transaction
stays active on every engine. Serialize all storage operations through one promise queue.

Fallback: localStorage key `<prefix>.feedback.outbox`, a JSON array of entries **without pictures**
(`screenshots: [], images: []`, `textOnly: true`). `all()` merges both, deduped by client id, oldest
first.

### 10.2 State (observable)

```ts
interface OutboxState {
  entries: JournalEntry[];     // kept in this browser
  sending: string[];           // client ids in flight
  onServer: { clientId, title, at }[];   // journaled, not yet filed
  filed: { clientId, id: string | null, title, at, error? }[];  // shown for 8 s
  justSaved: string | null;    // the report just filed from the panel, until its first send ends
}
```

Expose `subscribe`, `snapshot` and a constant empty `serverSnapshot` for `useSyncExternalStore`.

### 10.3 The sender

- `startOutbox()` runs once per page (guard with a module flag). It keeps a reference to the original
  `fetch`, opens a `BroadcastChannel('<prefix>-outbox')` (refresh on message), listens to `storage`
  events for the fallback key, `online`, `pageshow` with `persisted`, and `visibilitychange` to visible,
  each of which **kicks**.
- It wraps `window.fetch` once (guard with a flag on `window`) to watch, not alter: when a same-origin
  response is `ok`, entries are waiting, and the last kick was over 3 s ago, kick. The sender's own
  sends use the original fetch, so they are not kicks.
- `pump(kicked)`: one at a time (a pump requested during a pump sets `again`, and the running one loops).
  For each stored entry not in flight and `due`: skip if kicked, not yet due by the clock and tried in
  the last 3 s; else `attempt`. After the pump, `schedule()` a timer for the earliest `nextAt` among
  non-refused entries, at least 1 s away.
- `attempt(entry)`: POST with `content-type: application/json`, `cache: 'no-store'`, an
  `AbortController` timeout of `min(20 s, 3 s + 1 s per full 1,000,000 body chars)` (GUESS), and
  `keepalive: body.length < 60_000` (browsers cap keepalive bodies at 64 KB). Classify
  ([§2.2](#22-responses-the-client-must-understand)). On journaled/filed: remove from storage; if an
  issue id came back, show it as filed; else add to `onServer` and start polling. Otherwise apply the
  transition in [§4.3](#43-an-outbox-entry). Always post "changed" on the channel and refresh.
- **Polling** (`onServer` non-empty): every 3 s, `GET ?clientId=` with a 3 s timeout; `filed` → show
  "Filed as issue N" for 8 s; `refused` → show "Not filed: reason"; give up quietly after 10 minutes
  (GUESS; the report is safe on the server either way).
- `retryNow(id)`: clear its last-tried time, set `refused = false, nextAt = 0`, pump with a kick.
- `discardEntry(id)`: remove, broadcast, refresh, reschedule. The caller confirms first.

### 10.4 `entryTitle`, `entryText`

Title shown in lists: the first line of the body with `#>*-` and spaces stripped, cut to 80 chars with
an ellipsis; else "Untitled". `Copy text`: `# title` (when present), the body, a blank line, then
`kind · priority · page · written <ISO time>`.

### 10.5 Copy on plain http

Use `navigator.clipboard.writeText` only when `window.isSecureContext`; otherwise create an offscreen
readonly textarea, select it and `document.execCommand('copy')`. Same for ids: `crypto.randomUUID` only
exists in secure contexts; build a v4 UUID from `crypto.getRandomValues` (set version and variant bits).
Never `Math.random`: two tabs must not share a key.

### 10.6 What the status mark says

Compute from the state, most urgent first. `device` = entries except the one `justSaved` and in flight.

| Condition | Label | Short | Tone | Glyph |
|---|---|---|---|---|
| `device.length > 0` | "1 report only on this device", "N reports only on this device" (+ " · R refused", + " · S on the server") | "N on this device" | device, or refused if any refused | `!` (refused: `×`) |
| an entry is being saved | "Saving…" | "Saving…" | send | `↑` |
| `onServer.length > 0` | "Saved on server · filing…" / "N saved on server · filing…" | "On the server" | server | `✓` |
| last filed has `error` | "Not filed: error" | "Not filed" | refused | `×` |
| last filed | "Filed as issue 0024" | "Filed 0024" | done | `✓` |
| nothing | — | — | — | the chip is not drawn |

This is `outboxSummary(state)` in the kit; `label` is shown in the rail variant, `short` in the bar.

## 11. Keyboard

One table drives the app's shortcuts dialog and the panel's keys card:

| Group | Keys | Action |
|---|---|---|
| Anywhere | `?` | Open or close keyboard shortcuts, outside text fields |
| Anywhere | Esc | Close keyboard shortcuts |
| Anywhere | Alt+F | Open feedback, outside text fields and dialogs |
| Feedback box | `?` | Open or close this box's keys panel, outside text fields |
| Feedback box | Mod+Enter | File the report |
| Feedback box | Esc | Close the keys panel first, then the box |
| Feedback box | Tab / Shift+Tab | Move to the next or previous field |
| Screenshot editor | Mod+Z; Mod+Shift+Z / Mod+Y | Undo; redo, outside text fields |
| Screenshot editor | Mod+Enter | Keep the label text and leave its field |
| Screenshot editor | Esc | Leave a field, deselect a label, then close the editor |
| Screenshot editor | Esc | Cancel choosing a screenshot region |

`Mod` renders as ⌘ on Apple platforms and Ctrl elsewhere; `Alt` as Option on Apple platforms.

Predicates:

```ts
isTypingTarget(t) = t instanceof HTMLElement && (t.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(t.tagName))
isShortcutsKey(e) = e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing && !isTypingTarget(e.target)
isFeedbackKey(e)  = e.code === 'KeyF' && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey
                    && !e.isComposing && !e.repeat && !e.defaultPrevented && !isTypingTarget(e.target)
```

The panel's handler is on `document` and does nothing while the annotator or picker is open (they own
Esc). Mod+Enter files from anywhere in the panel, including the rich editor. The global shortcuts dialog
listens in the **capture** phase on `window` and yields when any other dialog is open (check presence of
`dialog[open], [role="dialog"]`, not focus: the drawer can be open while focus stays on its launcher).

## 12. The issues pages

### 12.1 Data

```ts
interface Issue {
  id: string;                   // "0024", zero-padded, sorts as a string
  title: string;                // generated by the server
  status: 'open' | 'triaged' | 'agent-ready' | 'in-progress' | 'done';
  kind: 'bug' | 'request' | 'question' | 'chore';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  reporter: string; page: string; labels: string[];
  body: string;                 // markdown, attachment paths already rewritten
  context: Record<string, unknown> | null;
  created: string;              // ISO, UTC
  closedAt: string | null;      // set when status becomes done, cleared on reopen
  location: string;             // a path or a URL
  screenshots: string[]; attachments: string[];   // paths relative to the store
  fixedIn: string | null;       // from fixed_in:, or "**Done (N30).**" in the body
  url?: string | null;          // GitHub
}
```

A legacy status `review` reads as `done`.

### 12.2 The list

- Load all issues once (`GET /api/issues`); the list is hundreds at worst, so filter and search in the
  browser.
- **Filters** (toggle chips, `aria-pressed`): status = Not done (default) | each status | Any status;
  priority = Any | P0..P3; kind = Any | each kind.
- **Search** (kit addition): build the index once per load:
  `hay[i] = [id, title, body, reporter, page, labels.join(' ')].join('\n').toLowerCase()`, normalised
  with `normalize('NFKD').replace(/\p{M}/gu, '')`. A query is split on whitespace; an issue matches when
  every term is a substring of its haystack. Filter synchronously on each keystroke (no debounce, no
  request) and wrap the list update in `useDeferredValue` so typing never waits for the table. `/`
  focuses the box when focus is not in a text field; Esc in the box clears it. At 2,000 issues a query
  must update the table in under 50 ms on a laptop.
- Header: "N shown · M filtered out · T on file".
- Empty result: "No issue on file matches these filters." and "N issues are filed. This is a statement
  about the filters, not about the queue."
- Columns: Id (mono, muted), Title (link, with "reporter · page" under it), Kind, Priority, Status,
  Fixed in, Filed (relative).
- Above the list: counts of not-done issues per priority with each priority's meaning, and the velocity
  chart (last 30 UTC days: filed and closed per day; open count reconstructed from `created` and
  `closedAt`, shown as a range where closures have no date; today's count is exact).

### 12.3 The issue page

Title, kind/priority/status chips, **What happened** rendered with the shared renderer
(`resolveImage`: `attachments/...` → the attachment endpoint), **The page as it looked** with every
screenshot (`alt="Screenshot N filed with issue ID"`), **Context at the moment it was filed** as
pretty JSON, and a sidebar with reporter, date, status, kind, priority, page, location and Fixed in.
Kit addition: a status `<select>` that PATCHes and shows the saved state; the server records
`closed_at`.

## 13. Accessibility, theming and layout

- Every dialog has a role and a label: the panel, the region picker, the keys card,
  the outbox list, the shortcuts dialog.
- **Focus.** On open, focus the description. Trap Tab and Shift+Tab inside the panel (wrap from last to
  first and back; when focus is outside, go to the first or last), skipping elements with no client rects
  and anything under `[inert]`. On close, return focus to the opener unless the user has moved it
  elsewhere on purpose. PL LabOS tools has this helper (`useModalSheet`) for its navigation sheet but the
  feedback drawer does not use it; **the kit MUST**.
- Toggle buttons use `aria-pressed`; disclosure buttons `aria-expanded`.
- Icon-only buttons have `aria-label` (× is "Remove screenshot N", "Remove this picture", "Close").
- Status changes are announced (`aria-live="polite"`) only when urgent; "Reading images…" is
  `role="status"`.
- Colour is never the only signal: states have words and different glyphs.
- Touch targets: 44 px for handles and picker buttons on coarse pointers; 36 px for outbox actions on
  phones.
- Respect `prefers-reduced-motion`.
- **Theme** through CSS variables so an app can re-skin. The kit declares them on `:where(.fbk)` (no
  specificity), `.fbk` being the class on every root it draws: `--fbk-ground`, `--fbk-surface`,
  `--fbk-ink`, `--fbk-muted`, `--fbk-line`, `--fbk-hair`, `--fbk-tint`, `--fbk-label`, `--fbk-accent`,
  `--fbk-accent-ink`, `--fbk-accent-soft`, `--fbk-accent-line`, `--fbk-accent-wash`, `--fbk-accent-halo`,
  `--fbk-clay` (errors, refusals), `--fbk-green` (saved), `--fbk-purple`, `--fbk-amber` (Misaligned),
  `--fbk-display`, `--fbk-sans`, `--fbk-mono`, `--fbk-drawer-w`, and for the rail `--fbk-rail`,
  `--fbk-rail-ink`, `--fbk-rail-muted`, `--fbk-rail-text`, `--fbk-rail-line`, `--fbk-rail-edge`,
  `--fbk-rail-soft`, `--fbk-rail-raise`, `--fbk-rail-hover`, `--fbk-rail-dim`, `--fbk-rail-av`. Override
  them in CSS (`.fbk { --fbk-accent: … }`) or with the provider's `theme` prop. The default values are
  PLC green (`--fbk-accent: #1E8F5E`, a dark green `--fbk-rail`). The original clay-and-paper palette
  is exported as `CLAY_THEME`, a ready re-skin to pass as `theme`; `GREEN_THEME` spells out the
  default's own values.
- **Focus ring on the description.** `.mdfield:focus-within` gets `--fbk-accent`'s border colour and a
  colour-mixed box-shadow (`color-mix(in srgb, var(--fbk-accent) 22%, transparent)`), so the field the
  cursor is in is visually obvious the instant the panel opens (it also has initial focus, [§11](#11-keyboard)).
  Respects `prefers-reduced-motion` (no transition).
- **Layout.** Drawer 420 px, `position: fixed; top/right/bottom: 0`, scrim `rgba(26,25,23,.28)`; phone
  (≤ 760 px) full width with safe-area padding. The keys card sits to the left of the drawer
  (`right: calc(var(--fbk-drawer-w, 420px) + 26px)`), top-right on narrow screens. Use `innerHeight` (set a
  `--app-h` variable before first paint) rather than `100dvh` on iPad Safari, and skip the update while
  pinch-zoomed (`visualViewport.scale > 1.01`).
- **`nocapture`**: document it for host apps. Anything with that class is left out of the automatic
  screenshot; apps can use it to redact sensitive regions.

## 14. Acceptance tests

Run in Playwright against the example app, and as Node tests for the pure modules. Invented data
only. The kit's suite (`npm run e2e`) runs every end-to-end test in both **Chromium and WebKit**; §15
lists what the kit automates today and what it cannot automate headless.

**Opening and keyboard**

1. Alt+F (Option+F) opens the panel from the body; it does not open while typing in an input, during
   composition, or when a dialog is open. The button has `aria-keyshortcuts="Alt+F"`.
2. `?` outside text fields opens the shortcuts dialog; the Option+F hint becomes visible in the button.
3. In the panel: Esc closes the keys card first, then the panel; ⌘/Ctrl+Enter inside the rich editor
   files the report; Tab cycles within the panel and never reaches the page behind it.
4. Closing the panel returns focus to the button.

**Capture**

5. On open, one screenshot appears within 12 s, labelled "Drawn from the page", and the panel is not in
   it (sample a pixel where the panel was: it matches the page).
6. Pixel test: on a fixture page with self-hosted fonts, a sticky header, a scrolled position (700 px)
   and a table taller than the viewport, the redraw differs from `page.screenshot()` on under 0.5% of
   pixels (GUESS threshold; PL LabOS tools measured 0.05%).
7. A page whose redraw never resolves: the panel comes back within 12 s and still files.
8. With `getDisplayMedia` stubbed to reject, Whole page falls back to the redraw; stubbed to return a
   frame of the wrong aspect, Pick a part draws the region from the page and says so.

**Region picker**

9. Mouse drag 500×290 and release: a screenshot of that size × scale is added; Esc cancels with nothing
   added; a 5 px drag adds nothing.
10. Touch (pointerType touch, `hasTouch` context): release shows four handles and Use this part; dragging a
   corner resizes; dragging inside moves; `pointercancel` restores the previous rectangle; Use this part
   adds the picture. `getComputedStyle(surface).touchAction === 'none'`. WebKit too.

**Markdown field**

11. Typing `**bold**`, a list, and `(>100MB) & <x>` stores exactly that markdown (no `&gt;`).
12. Dropping two PNGs at once inserts both, in order, neither replacing the other; pasting a third while
    the first two are being read keeps order; a PDF and a 9 MB PNG are refused with one line.
13. Deleting an image from the text removes it from the upload; the remaining tokens are renumbered 1..k
    and the server's issue links resolve to the right files (compare bytes).
14. Rich → Markdown → edit → Rich keeps the edit and every image; annotating a dropped image updates it in
    the view and in the upload.

**Drafts**

15. Type, reload, reopen on the same page: the words and an annotated screenshot are restored with the
    "Your unsent draft" line. On another page, Drafts · 1 lists it; picking it loads it; filing records
    `startedOn`.
16. Filing removes the draft; Discard asks and removes it; with storage disabled the panel still works.

**Outbox and journal**

17. File with the server up: the panel closes in under 300 ms; the status mark shows "Saved on server ·
    filing…" then "Filed as issue N" within 15 s; exactly one issue exists.
18. File with `/api/feedback` blocked: the mark shows `!` and "1 report only on this device"; reload the
    page: still there; unblock: it files once, without user action, within the backoff window or at once on
    the next successful request.
19. Freeze the server (SIGSTOP) for 60 s during a file: it files exactly once after SIGCONT.
20. Send the same client id five times concurrently: one issue.
21. A 413 response marks the entry refused with the server's reason and no automatic retry; Retry now
    sends it.
22. Close the tab right after the 202: the issue is still filed.
23. Two tabs: an entry filed in one disappears from the other's list.
24. Copy text works on plain http (non-secure context).

**Issues pages**

25. The list defaults to Not done; chips combine; the header counts are right.
26. Search: typing a word from a body filters within one frame; with 2,000 generated issues each keystroke
    updates in under 50 ms; `/` focuses the box.
27. The issue page renders the body with images, every screenshot and the context; a status change
    persists, keeps unmanaged frontmatter lines, and sets then clears `closedAt` on close and reopen.

**Pure properties (Node)**

28. Backoff: 5 s, 15 s, 60 s, then 120 s forever; never faster, never slower.
29. Classification table in §2.2, including a 2xx for another client id → retry.
30. An entry leaves only on journaled/filed; refused entries are not due until Retry now.
31. `packAttachments` keeps referenced images in first-reference order and rewrites tokens consistently.
32. Keyboard predicates: Option+F (`key: 'ƒ'`, `code: 'KeyF'`) matches; Alt+Shift+F, Ctrl+Alt+F and
    typing targets do not.

## 15. What cannot be tested headless

The kit's automated checks, as shipped:

- **End to end** (`examples/next-app/e2e`, Playwright, Chromium and WebKit): Alt+F opens the box with
  the cursor in the description, no title field on any page, markdown typed as markdown, a dropped
  file, a region picked with the mouse (1, 3, 9, 11 and 12 in part); a region drawn and adjusted with a
  finger (10); filing with ⌘/Ctrl+Enter, journaled then "Filed as issue N" (17); a draft through a
  reload and Drafts · 1 (15); the outbox through a reload and replayed when the server is back (18);
  the list, search with `/`, the detail page's pictures and a status change (25–27 in part); the
  annotation toolbar on a phone (icon buttons with names and tooltips, a box drawn with a finger);
  and the example's sign-in guard on the issue reads and PATCH.
- **Unit** (`npm test`): the capture fallbacks with the browser stubbed (8): no `getDisplayMedia`, a
  declined prompt, a window shared instead of the tab, and both methods failing. On the server, the
  journal, ingester, stores, titles, adapters and handlers (20 and the server side of 17–22).

Not automated, because a headless browser cannot do it:

- **The exact screen capture.** `getDisplayMedia` needs a person to choose a tab in the browser's own
  prompt. Chromium can be told to auto-accept, but then it shares a fake or whole-screen source, so the
  frame, its size and the crop of a region are never the real ones. The unit tests cover the decisions
  around the frame (fallback, mismatch), not its pixels. Check **Whole page** and **Pick a part** by
  hand in Chrome, Edge and desktop Safari after touching `capture.ts`.
- **Real Safari.** Playwright's WebKit is WebKit, not Safari: it does not have iPadOS Safari's
  `100dvh`, visual-viewport and pinch behaviour, its dropped IndexedDB connections, its absent
  `getDisplayMedia`, its gesture events, or real touch input (the WebKit touch tests dispatch
  `PointerEvent`s with `pointerType: 'touch'`; Chromium's use real touch through the DevTools
  protocol). Test on a real iPad and a Mac before a release; Safari-only reports cannot be reproduced
  here.
- **Redraw fidelity** (6). The pixel comparison against `page.screenshot()` is not in the suite; the
  0.05% figure was measured in PL LabOS tools.

Not automated yet, though they could be: 2, 4, 13 (comparing bytes), 14, 16, 19 (SIGSTOP), 21–24, and
the client-side properties 28–32.
