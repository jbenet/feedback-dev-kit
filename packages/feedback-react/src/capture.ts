/**
 * Capturing what the reporter is looking at, without asking for permission.
 *
 * Two ways, and they are not equivalent:
 *
 *   render  — the DOM re-drawn through an SVG foreignObject, by the browser's own engine.
 *             No permission prompt, and it **can redact**: anything marked `nocapture` is
 *             dropped, which is how the feedback drawer stays out of its own screenshot.
 *   screen  — `getDisplayMedia`. Literally the composited frame, and therefore exact — but
 *             it shows a permission dialog every single time and it cannot redact anything,
 *             because by then the pixels are just pixels.
 *
 * **Render is the default.** Once the clone waits for `document.fonts.ready` the difference
 * is small enough that it is not worth a dialog on every complaint, and the redaction is
 * worth more than the last few per cent of fidelity. The screen path stays available for
 * somebody who explicitly wants exact pixels and will accept the prompt.
 *
 * Nothing is captured when the box opens. A screenshot is taken when somebody asks for one.
 */

export type CaptureMethod = 'screen' | 'render';

export interface Capture {
  dataUrl: string;
  method: CaptureMethod;
  /** Why the exact path was not used, when it was not. */
  note: string | null;
}

const MAX_WIDTH = 2000;

/**
 * A hard ceiling on a capture.
 *
 * `domToPng` inlines every image it can see, and the in-app changelog has a hundred and
 * twenty-five screenshots on one page. It did not fail there — it ran until nobody was
 * waiting any more, which left the feedback drawer hidden behind a capture that was never
 * coming back. Anything that can hang has to be able to give up.
 */
const CAPTURE_TIMEOUT_MS = 12_000;

function withTimeout<T>(work: Promise<T>, ms = CAPTURE_TIMEOUT_MS): Promise<T | null> {
  return Promise.race([
    work.catch(() => null),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms); }),
  ]);
}

function toPng(source: CanvasImageSource, w: number, h: number): string {
  const scale = Math.min(1, MAX_WIDTH / w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/**
 * One frame of the current tab, optionally cut down to a region the reporter drew.
 *
 * Must be called from the click handler itself — the API needs transient user activation,
 * so anything awaited before it loses the gesture.
 *
 * The crop happens here, on the full-resolution video frame, and it measures the frame
 * rather than assuming it (issue 0015). The old version shrank the frame to 2000px first
 * and then cropped with `devicePixelRatio` as though nothing had been shrunk — on a 2×
 * screen that put the rectangle 44% too far right and down, which is the "off in x" in the
 * report. The ratio is now simply frame pixels ÷ viewport pixels, per axis.
 */
type ScreenFrame = { dataUrl: string } | { mismatch: true } | null;

async function captureScreen(region?: Region): Promise<ScreenFrame> {
  const md = navigator.mediaDevices;
  if (!md?.getDisplayMedia) return null;

  let stream: MediaStream | null = null;
  try {
    stream = await md.getDisplayMedia({
      audio: false,
      video: { displaySurface: 'browser' },
      // Chrome-only hints: pre-select this tab, and do not offer to switch mid-capture.
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'exclude',
    } as DisplayMediaStreamOptions);

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    // Two frames: the first is often blank while the pipeline spins up.
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    if (!region) return { dataUrl: toPng(video, w, h) };

    const sx = w / window.innerWidth;
    const sy = h / window.innerHeight;
    /**
     * If the frame is not the shape of this tab's viewport, somebody shared a window or a
     * whole screen instead, and viewport coordinates mean nothing in it. Say so rather than
     * cutting a confident rectangle out of the wrong picture.
     */
    if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.04) return { mismatch: true };

    const srcW = region.w * sx;
    const srcH = region.h * sy;
    const cap = Math.min(1, MAX_WIDTH / srcW);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(srcW * cap));
    canvas.height = Math.max(1, Math.round(srcH * cap));
    canvas.getContext('2d')!.drawImage(
      video, region.x * sx, region.y * sy, srcW, srcH, 0, 0, canvas.width, canvas.height,
    );
    return { dataUrl: canvas.toDataURL('image/png') };
  } catch {
    return null;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

export interface Region { x: number; y: number; w: number; h: number }

/**
 * The page, redrawn. Optionally cropped to a region the reporter drew.
 *
 * Cropping happens after the render rather than by rendering a sub-tree: a region is a
 * rectangle on the screen and usually cuts across several elements, so the honest thing is
 * to draw the page and cut the rectangle out of it.
 */
export async function captureRender(region?: Region): Promise<string | null> {
  return withTimeout(renderNow(region));
}

const SHIFT = 'data-capture-shift';

/**
 * The clone has no scroll: it is the page drawn once and moved up by the scroll. A sticky rail
 * or top bar, or anything fixed, sits where the scroll put it on screen, and would go up with
 * the rest. So each is marked with how far to move it back, measured on the live page, and moved
 * in the clone: a sticky element by where it is now less where it would be unstuck, a
 * fixed one by the scroll itself. Returns the cleanup, which takes the marks off again.
 */
function pinStuck(): { cleanup: () => void; rootShift: string | null } {
  const sx = window.scrollX;
  const sy = window.scrollY;
  if (!sx && !sy) return { cleanup: () => {}, rootShift: null };
  const marked: HTMLElement[] = [];
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
    const position = getComputedStyle(el).position;
    if (position !== 'sticky' && position !== 'fixed') continue;
    let dx = sx;
    let dy = sy;
    if (position === 'sticky') {
      const now = el.getBoundingClientRect();
      const inline = el.style.position;
      el.style.position = 'relative';
      const unstuck = el.getBoundingClientRect();
      el.style.position = inline;
      dx = now.left - unstuck.left;
      dy = now.top - unstuck.top;
    }
    if (!dx && !dy) continue;
    el.setAttribute(SHIFT, `${dx}px ${dy}px`);
    marked.push(el);
  }
  // The body's own ::before and ::after cannot carry a mark; a fixed one gets a rule instead.
  const fixedPseudo = ['::before', '::after'].filter((p) => getComputedStyle(document.body, p).position === 'fixed');
  return {
    cleanup: () => marked.forEach((el) => el.removeAttribute(SHIFT)),
    rootShift: fixedPseudo.length ? `${fixedPseudo.map((p) => `body${p}`).join(',')}{translate:${sx}px ${sy}px !important}` : null,
  };
}

async function renderNow(region?: Region): Promise<string | null> {
  const pinned = pinStuck();
  try {
    const { domToPng } = await import('modern-screenshot');
    // The clone can only use fonts it can embed, and it embeds only what it can read: the
    // @font-face rules of a same-origin stylesheet. A cross-origin
    // one, like Google Fonts', is skipped, and the clone falls back to wider fonts and re-wraps.
    await document.fonts.ready;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = Math.min(2, window.devicePixelRatio || 1, MAX_WIDTH / w);
    const full = await domToPng(document.body, {
      width: w,
      height: h,
      scale,
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      style: {
        // The clone's root is a <body> again, and a body's default margin is 8px: without this,
        // the whole page was drawn 8px down and right, and 16px narrower.
        margin: '0',
        transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
        transformOrigin: 'top left',
      },
      // A panel scrolled on screen (the rail, a drawer) is drawn scrolled, as it is seen.
      features: { restoreScrollPosition: true, copyScrollbar: false },
      onCloneEachNode: (node: Node) => {
        // Not `instanceof`: the clone may belong to another window's constructors.
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as HTMLElement;
        // No scrollbars: the clone drew ones the page didn't show — one across the foot of the
        // rail — and its scrolled panels are already drawn at their scroll.
        for (const prop of ['overflow', 'overflow-x', 'overflow-y']) {
          const v = el.style.getPropertyValue(prop);
          if (v === 'auto' || v === 'scroll' || v === 'overlay') el.style.setProperty(prop, 'hidden');
        }
        // A table keeps the height it has on the page, but the filter below leaves out its rows
        // under the fold, so the rows that remain were stretched to fill it: every row of the
        // pipeline hundreds of pixels tall (seen on long tables). Let a table and
        // its row groups take the height of what is drawn.
        if (['TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR'].includes(el.tagName)) {
          el.style.removeProperty('height');
          el.style.removeProperty('block-size');
        }
        const shift = el.getAttribute(SHIFT);
        if (!shift) return;
        el.style.setProperty('translate', shift);
        el.removeAttribute(SHIFT);
      },
      onCreateForeignObjectSvg: (svg: SVGSVGElement) => {
        if (!pinned.rootShift) return;
        const style = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style');
        style.textContent = pinned.rootShift;
        svg.appendChild(style);
      },
      timeout: 6000,
      filter: (node: Node) => {
        if (!(node instanceof Element)) return true;
        if (node.classList.contains('nocapture')) return false;
        const r = node.getBoundingClientRect();
        // An image outside the viewport is not in the picture, and inlining it costs the
        // same as one that is. This is what made the changelog page uncapturable.
        if (node.tagName === 'IMG') return !(r.bottom < 0 || r.top > h || r.right < 0 || r.left > w);
        // Nor is anything wholly below or right of it, and cloning it costs the same (seen
        // on Safari on an iPad: a long page — thousands of rows — ran out the timeout or the
        // browser's limits, so the capture failed "sometimes"). Only below and right: dropping
        // what is above would move what is on screen up in the picture. An element with no box of
        // its own (display: contents) is kept for its children, and so is anything pinned in place.
        if (r.width === 0 && r.height === 0) return true;
        if (node.hasAttribute(SHIFT)) return true;
        return !(r.top > h || r.left > w);
      },
    });
    if (!region) return full;
    return await crop(full, region, scale);
  } catch {
    return null;
  } finally {
    pinned.cleanup();
  }
}

function crop(dataUrl: string, r: Region, scale: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(r.w * scale));
      c.height = Math.max(1, Math.round(r.h * scale));
      c.getContext('2d')!.drawImage(
        img, r.x * scale, r.y * scale, r.w * scale, r.h * scale,
        0, 0, c.width, c.height,
      );
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/** The default: no dialog, and the feedback drawer is redacted out of its own picture. */
export async function capturePage(region?: Region): Promise<Capture | null> {
  const rendered = await captureRender(region);
  if (!rendered) return null;
  return {
    dataUrl: rendered,
    method: 'render',
    note:
      'Drawn by your browser from the page itself, with no permission prompt. Anything marked '
      + 'as not-for-capture — the feedback panel included — is left out.',
  };
}

/**
 * Exact pixels, and a permission dialog.
 *
 * This is what the retake buttons use. The automatic capture is a redraw and can get the
 * layout subtly wrong; this is the composited frame, so it cannot. It cannot redact either,
 * which is the trade the person is making when they press the button.
 */
export async function capturePageExact(region?: Region): Promise<Capture | null> {
  const screen = await withTimeout(captureScreen(region));
  if (screen && 'dataUrl' in screen) {
    return {
      dataUrl: screen.dataUrl,
      method: 'screen',
      note: 'The frame your browser composited. Exactly what was on the screen, including '
        + 'anything the automatic capture leaves out.',
    };
  }
  if (screen && 'mismatch' in screen && region) {
    // A different surface was shared. The redraw can still cut the right rectangle.
    const drawn = await capturePage(region);
    return drawn && {
      ...drawn,
      note: 'You shared something other than this tab, so the part you picked was drawn from '
        + 'the page instead of cut from the shared picture.',
    };
  }
  // Declined, unsupported, or too slow. Fall back rather than leaving them with nothing.
  return capturePage(region);
}

export const METHOD_LABEL: Record<CaptureMethod, string> = {
  screen: 'Captured from your screen',
  render: 'Drawn from the page',
};
