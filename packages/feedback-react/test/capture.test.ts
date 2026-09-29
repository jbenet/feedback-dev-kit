/**
 * The capture fallbacks, without a browser: when the exact screen capture is unsupported, declined
 * or shows the wrong surface, the redraw is used instead, and when both fail nothing comes back.
 *
 * What this cannot test (see docs/REBUILD.md §15): the pixels of a real getDisplayMedia frame, which
 * needs a person to pick a tab in the browser's own prompt, and the redraw's fidelity in real Safari.
 * The browser, `modern-screenshot` and the media stream are stand-ins here.
 */
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const RENDERED = 'data:image/png;base64,UkVOREVSRUQ=';
const CROPPED = 'data:image/png;base64,Q1JPUFBFRA==';
const FRAME = 'data:image/png;base64,RlJBTUU=';

let renderFails = false;
const renders: Array<{ width: number; height: number }> = [];
const fakeScreenshot = {
  domToPng: async (_node: unknown, options: { width: number; height: number }) => {
    renders.push({ width: options.width, height: options.height });
    if (renderFails) throw new Error('the redraw failed');
    return RENDERED;
  },
};
// Node 25 renamed the option (`namedExports` → `exports`); Node 22 knows only the old name.
mock.module('modern-screenshot', Number(process.versions.node.split('.')[0]) >= 25
  ? { exports: fakeScreenshot } as Parameters<typeof mock.module>[1]
  : { namedExports: fakeScreenshot });

/** A 1280×800 window with no scroll, a canvas that says what it drew, and an Image that loads at once. */
function fakeBrowser(getDisplayMedia?: (options: unknown) => Promise<unknown>) {
  const g = globalThis as Record<string, unknown>;
  const canvas = () => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage: () => undefined }),
    toDataURL(this: { fromVideo?: boolean }) { return this.fromVideo ? FRAME : CROPPED; },
  });
  Object.assign(g, {
    window: g, innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    getComputedStyle: () => ({ position: 'static', backgroundColor: 'rgb(255, 255, 255)' }),
    Image: class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { setTimeout(() => this.onload?.(), 0); } },
    document: {
      fonts: { ready: Promise.resolve() },
      body: { querySelectorAll: () => [] },
      createElement: (tag: string) => (tag === 'video'
        ? { srcObject: null, muted: false, playsInline: false, videoWidth: 2560, videoHeight: 1600, play: async () => undefined }
        : canvas()),
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: getDisplayMedia ? { getDisplayMedia } : undefined },
  });
}

const stream = () => ({ getTracks: () => [{ stop: () => undefined }] });

let capture: typeof import('../src/capture.ts');
beforeEach(async () => {
  renderFails = false;
  renders.length = 0;
  capture ??= await import('../src/capture.ts');
});
afterEach(() => {
  for (const k of ['window', 'document', 'Image', 'getComputedStyle', 'requestAnimationFrame']) delete (globalThis as Record<string, unknown>)[k];
});

test('no getDisplayMedia (Safari on iOS, an old browser): the exact capture falls back to the redraw', async () => {
  fakeBrowser();
  const shot = await capture.capturePageExact();
  assert.equal(shot?.method, 'render');
  assert.equal(shot?.dataUrl, RENDERED);
  assert.equal(renders.length, 1);
  assert.deepEqual(renders[0], { width: 1280, height: 800 });
});

test('the prompt declined: the redraw is used, cut to the region that was picked', async () => {
  fakeBrowser(async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); });
  const shot = await capture.capturePageExact({ x: 10, y: 20, w: 300, h: 200 });
  assert.equal(shot?.method, 'render');
  assert.equal(shot?.dataUrl, CROPPED);
  assert.match(shot!.note!, /Drawn by your browser/);
});

test('a window or screen shared instead of this tab: the region is drawn from the page, and the note says why', async () => {
  // A 16:10 viewport, and a shared frame of another shape (a whole 4:3 screen).
  fakeBrowser(async () => stream());
  const doc = (globalThis as unknown as { document: { createElement: (t: string) => unknown } }).document;
  const make = doc.createElement;
  doc.createElement = (tag: string) => (tag === 'video' ? { ...(make(tag) as object), videoWidth: 2048, videoHeight: 1536 } : make(tag));
  const shot = await capture.capturePageExact({ x: 10, y: 20, w: 300, h: 200 });
  assert.equal(shot?.method, 'render');
  assert.equal(shot?.dataUrl, CROPPED);
  assert.match(shot!.note!, /something other than this tab/);
});

test('this tab shared: the exact frame is used and no redraw runs', async () => {
  fakeBrowser(async () => stream());
  const doc = (globalThis as unknown as { document: { createElement: (t: string) => unknown } }).document;
  const make = doc.createElement;
  doc.createElement = (tag: string) => {
    const el = make(tag) as Record<string, unknown>;
    if (tag === 'canvas') el.fromVideo = true;
    return el;
  };
  const shot = await capture.capturePageExact();
  assert.equal(shot?.method, 'screen');
  assert.equal(shot?.dataUrl, FRAME);
  assert.equal(renders.length, 0);
});

test('both fail: nothing comes back, so the box says so and files without a picture', async () => {
  fakeBrowser(async () => { throw new Error('declined'); });
  renderFails = true;
  assert.equal(await capture.capturePageExact(), null);
  assert.equal(await capture.capturePage(), null);
});
