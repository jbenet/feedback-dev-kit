'use client';

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Region } from './capture';

type Pt = [number, number];
type Corner = 'nw' | 'ne' | 'sw' | 'se';
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

/** What the finger or mouse is doing right now. One pointer at a time; a second finger is ignored. */
type Drag =
  | { kind: 'draw'; id: number; from: Pt; prev: Region | null }
  | { kind: 'corner'; id: number; fixed: Pt; grab: Pt }
  | { kind: 'move'; id: number; start: Pt; orig: Region };

/** Smaller than this on either side is a mis-tap, not a selection. */
const MIN = 8;

const span = (a: Pt, b: Pt): Region => ({
  x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
  w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]),
});
const clampTo = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const inViewport = (p: Pt): Pt => [clampTo(p[0], 0, window.innerWidth), clampTo(p[1], 0, window.innerHeight)];

/**
 * Drag a rectangle over the page.
 *
 * The feedback drawer is hidden while this is up — the reporter is choosing a part of the
 * page, and the panel covering a third of it would be in the way and then in the picture.
 * Escape or Cancel cancels; a drag smaller than a few pixels counts as a mis-click rather
 * than as an empty selection.
 *
 * With a mouse, letting go takes the picture, as it always has. With a finger or a pen
 * (issue 0117, iPad Safari) letting go leaves the rectangle up with four corner handles,
 * each a 44 px target, so a finger that covered the corner it was dragging can correct it;
 * "Use this part" takes the picture. The surface claims every touch (`touch-action: none`,
 * and touchmove / Safari's gesture events are cancelled), so a drag never scrolls or zooms the
 * page underneath and the browser never cancels the pointer half way.
 */
export function RegionPicker({
  onPick, onCancel,
}: {
  onPick: (r: Region) => void;
  onCancel: () => void;
}) {
  const [sel, setSel] = useState<Region | null>(null);
  /** Up after a touch or pen drag: the handles show, and the bar asks to confirm. */
  const [adjusting, setAdjusting] = useState(false);
  const selRef = useRef<Region | null>(null);
  const drag = useRef<Drag | null>(null);
  const done = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  /** The latest onPick, so the key handler bound once never calls a stale one. */
  const pick = useRef(onPick);
  pick.current = onPick;

  const show = (r: Region | null) => { selRef.current = r; setSel(r); };
  const finish = (r: Region) => {
    if (done.current || r.w < MIN || r.h < MIN) return;
    done.current = true;
    pick.current(r);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && selRef.current) { e.preventDefault(); finish(selRef.current); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]); // finish reads only refs

  /**
   * iPad Safari: `touch-action: none` covers panning and pinching, but a touchmove that is not
   * cancelled can still rubber-band the page, and pinch arrives as Safari's own gesture events.
   * React attaches touch listeners as passive, so these go on the element directly.
   */
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    const stop = (e: Event) => { if (e.cancelable) e.preventDefault(); };
    el.addEventListener('touchmove', stop, { passive: false });
    el.addEventListener('gesturestart', stop);
    el.addEventListener('gesturechange', stop);
    return () => {
      el.removeEventListener('touchmove', stop);
      el.removeEventListener('gesturestart', stop);
      el.removeEventListener('gesturechange', stop);
    };
  }, []);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (drag.current || target.closest('.regionbar')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    // Capture on the surface itself, not on whatever child the finger landed on.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* already released */ }
    const p = inViewport([e.clientX, e.clientY]);
    const cur = selRef.current;
    const corner = target.closest<HTMLElement>('.regionhandle')?.dataset.corner as Corner | undefined;
    if (cur && corner) {
      const fixed: Pt = [corner.includes('w') ? cur.x + cur.w : cur.x, corner.includes('n') ? cur.y + cur.h : cur.y];
      const at: Pt = [corner.includes('w') ? cur.x : cur.x + cur.w, corner.includes('n') ? cur.y : cur.y + cur.h];
      // Where in the 44 px target the finger landed, so the corner does not jump to it.
      drag.current = { kind: 'corner', id: e.pointerId, fixed, grab: [p[0] - at[0], p[1] - at[1]] };
      return;
    }
    if (cur && adjusting && p[0] >= cur.x && p[0] <= cur.x + cur.w && p[1] >= cur.y && p[1] <= cur.y + cur.h) {
      drag.current = { kind: 'move', id: e.pointerId, start: p, orig: cur };
      return;
    }
    drag.current = { kind: 'draw', id: e.pointerId, from: p, prev: adjusting ? cur : null };
    show({ x: p[0], y: p[1], w: 0, h: 0 });
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const p = inViewport([e.clientX, e.clientY]);
    if (d.kind === 'draw') show(span(d.from, p));
    else if (d.kind === 'corner') show(span(d.fixed, inViewport([p[0] - d.grab[0], p[1] - d.grab[1]])));
    else {
      const { orig } = d;
      show({
        ...orig,
        x: clampTo(orig.x + p[0] - d.start[0], 0, window.innerWidth - orig.w),
        y: clampTo(orig.y + p[1] - d.start[1], 0, window.innerHeight - orig.h),
      });
    }
  };

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const r = selRef.current;
    if (d.kind === 'draw' && (!r || r.w < MIN || r.h < MIN)) { show(d.prev); return; }
    if (!r) return;
    if (e.pointerType === 'mouse' && !adjusting) { finish(r); return; }
    setAdjusting(true);
  };

  /** The browser took the pointer back (a system gesture): keep what was there before this drag. */
  const cancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.kind === 'draw') show(d.prev);
    else if (d.kind === 'move') show(d.orig);
  };

  const ok = !!sel && sel.w >= MIN && sel.h >= MIN;
  // The bar moves to the top when the selection reaches down into it.
  const barTop = !!sel && typeof window !== 'undefined' && sel.y + sel.h > window.innerHeight - 96 && sel.y > 96;

  return (
    <div
      ref={surface}
      className="regionpick nocapture"
      role="dialog"
      aria-label="Drag to choose a part of the page"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {sel && (sel.w > 0 || sel.h > 0) && (
        <>
          <div className="regionhole" style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }} />
          <div className="regionsize" style={{ left: sel.x, top: Math.max(0, sel.y - 22) }}>
            {Math.round(sel.w)} × {Math.round(sel.h)}
          </div>
          {adjusting && CORNERS.map((c) => (
            <div
              key={c}
              className="regionhandle"
              data-corner={c}
              aria-hidden
              style={{
                left: c.includes('w') ? sel.x : sel.x + sel.w,
                top: c.includes('n') ? sel.y : sel.y + sel.h,
              }}
            />
          ))}
        </>
      )}
      <div className={`regionbar${barTop ? ' top' : ''}`}>
        <span>
          {adjusting
            ? 'Drag a corner to adjust, or draw again'
            : 'Drag over the part you want'}
        </span>
        {adjusting && (
          <button type="button" className="btn c" disabled={!ok} onClick={() => sel && finish(sel)}>
            Use this part
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel} title="Esc">Cancel</button>
      </div>
    </div>
  );
}
