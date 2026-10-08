'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

type Tool = 'select' | 'pen' | 'arrow' | 'line' | 'box' | 'text' | 'crop';

interface Stroke { tool: 'pen'; colour: string; width: number; points: Array<[number, number]> }
interface Arrow { tool: 'arrow'; colour: string; width: number; from: [number, number]; to: [number, number] }
/** An arrow without its head: for underlining something, or joining two things up. */
interface Line { tool: 'line'; colour: string; width: number; from: [number, number]; to: [number, number] }
interface Box { tool: 'box'; colour: string; width: number; from: [number, number]; to: [number, number] }
interface Label {
  tool: 'text';
  /** Labels are editable after they are placed, so they need identity (issue 0014). */
  id: string;
  colour: string;
  /** Font size in pixels of the saved image — the number in the size field. */
  size: number;
  at: [number, number];
  /**
   * Wrap width in image pixels. Until the corner is dragged it follows the text, out to the
   * edge of the picture; after that it is the width the user chose, and typing leaves it alone.
   */
  width: number;
  /** Set once the corner has been dragged. */
  sized: boolean;
  /** The height the corner was dragged to, as a floor — text longer than that still shows. */
  height: number;
  /** Newlines are kept. A one-line-only annotation tool makes people write captions. */
  text: string;
  bold: boolean;
}
/**
 * The part of the picture to keep, as [x0, y0, x1, y1] in image pixels; null keeps all of it.
 * A crop is a mark like any other, so undo and redo take it back and forth; the last one is the
 * one that counts. Nothing is cut until Done, so marks outside it are still there to drag in.
 */
interface Crop { tool: 'crop'; rect: [number, number, number, number] | null }
type Mark = Stroke | Arrow | Line | Box | Label | Crop;

/** The crop in force: the last crop mark's. */
const cropOf = (all: Mark[]): Crop['rect'] => {
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const m = all[i]!;
    if (m.tool === 'crop') return m.rect;
  }
  return null;
};
const inside = (r: NonNullable<Crop['rect']>, p: [number, number]) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];

const COLOURS = [
  { id: '#BF4A16', name: 'Clay' },
  { id: '#0E7F55', name: 'Green' },
  { id: '#5F4B9E', name: 'Purple' },
  { id: '#1A1917', name: 'Ink' },
  { id: '#FFFFFF', name: 'White' },
];

/** Inline icons, 16×16, stroked in the current colour: no icon dependency. */
const icon = (d: string, extra?: React.ReactNode) => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
    <path d={d} />{extra}
  </svg>
);
const ICON = {
  select: icon('M4 2.5l8.5 5.3-3.8 1 2.3 4.1-1.7.9-2.3-4.1-3 2.5z'),
  pen: icon('M10.8 2.7l2.5 2.5-7.9 7.9-3.2.7.7-3.2z M9.6 3.9l2.5 2.5'),
  arrow: icon('M3.5 12.5l8.5-8.5 M6.5 4h5.5v5.5'),
  line: icon('M3.5 12.5l9-9'),
  box: icon('M3 4.5h10v7H3z'),
  text: icon('M3.5 4V3h9v1 M8 3v10 M6.3 13h3.4'),
  crop: icon('M4.5 1.5v10h10 M1.5 4.5h10v10'),
  undo: icon('M5.5 3.5L2.5 6.5l3 3 M2.8 6.5H10a3.5 3.5 0 0 1 0 7H7'),
  redo: icon('M10.5 3.5l3 3-3 3 M13.2 6.5H6a3.5 3.5 0 0 0 0 7h3'),
  clear: icon('M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.6 8.5h5.8l.6-8.5 M6.8 7v4 M9.2 7v4'),
  close: icon('M4 4l8 8 M12 4l-8 8'),
  done: icon('M3 8.5l3.2 3.2L13 5'),
};

const TOOLS: Array<{ id: Tool; glyph: React.ReactNode; name: string }> = [
  { id: 'select', glyph: ICON.select, name: 'Select: click a mark to move or delete it' },
  { id: 'pen', glyph: ICON.pen, name: 'Draw freehand' },
  { id: 'arrow', glyph: ICON.arrow, name: 'Point at something' },
  { id: 'line', glyph: ICON.line, name: 'Draw a line' },
  { id: 'box', glyph: ICON.box, name: 'Box it' },
  { id: 'text', glyph: ICON.text, name: 'Add a label' },
  { id: 'crop', glyph: ICON.crop, name: 'Crop: drag the part to keep' },
];

/** Stroke widths, as multiples of the width that suits the picture's size (width() below). */
const WEIGHTS = [
  { id: 0.5, name: 'Thin' },
  { id: 1, name: 'Medium' },
  { id: 2, name: 'Thick' },
  { id: 3.5, name: 'Heavy' },
];

/** The selectable marks: everything but labels, which are DOM objects with their own handles. */
type Shape = Stroke | Arrow | Line | Box;
const pointsOf = (m: Shape): Array<[number, number]> => (m.tool === 'pen' ? m.points : [m.from, m.to]);
const bounds = (m: Shape) => {
  const xs = pointsOf(m).map((p) => p[0]);
  const ys = pointsOf(m).map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
const toSegment = (p: [number, number], a: [number, number], b: [number, number]) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};
/** How far a point is from a mark's ink, in image pixels. */
const distance = (m: Shape, p: [number, number]): number => {
  if (m.tool === 'box') {
    const [a, b] = [m.from, m.to];
    const corners: Array<[number, number]> = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
    return Math.min(...corners.map((c, i) => toSegment(p, c, corners[(i + 1) % 4]!)));
  }
  const pts = pointsOf(m);
  if (pts.length === 1) return Math.hypot(p[0] - pts[0]![0], p[1] - pts[0]![1]);
  let best = Infinity;
  for (let i = 1; i < pts.length; i += 1) best = Math.min(best, toSegment(p, pts[i - 1]!, pts[i]!));
  return best;
};
const moved = (m: Shape, dx: number, dy: number): Shape => (m.tool === 'pen'
  ? { ...m, points: m.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) }
  : { ...m, from: [m.from[0] + dx, m.from[1] + dy], to: [m.to[0] + dx, m.to[1] + dy] });

const PIPETTE = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9.5 4.5l2 2M10.4 3.6l1.2-1.2a1.4 1.4 0 0 1 2 2l-1.2 1.2M8.8 5.2l-5.3 5.3-.5 2.5 2.5-.5 5.3-5.3" />
  </svg>
);

/** Line height of a label, in the field on screen and in the saved image alike. */
const LEADING = 1.3;
const PLACEHOLDER = 'Type. Return makes a new line.';
/**
 * Sizes are pixels of the saved image: the one unit that means the same thing on any screen
 * and in the file that gets filed. The list is a shortcut; any whole number from 8 to 400 can
 * be typed.
 */
const SIZE_PRESETS = [12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128];
const SIZE_MIN = 8;
const SIZE_MAX = 400;

const fontOf = (size: number, bold: boolean) =>
  `${bold ? 600 : 400} ${size}px "IBM Plex Sans", system-ui, sans-serif`;

/** `<input type="color">` takes #rrggbb and nothing else, and an eyedropper may say rgb(). */
const hex6 = (c: string): string => {
  const s = c.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${[...s.slice(1)].map((d) => d + d).join('')}`;
  const rgb = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (rgb) return `#${rgb.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  return '#000000';
};
const sameColour = (a: string, b: string) => hex6(a) === hex6(b);

type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> };
/** Chromium only, so far. Where it is missing the button is not drawn at all. */
const eyeDropper = (): EyeDropperCtor | null =>
  (typeof window === 'undefined' ? null : (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper ?? null);

const isUndo = (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z';
const isRedo = (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && (
    (e.shiftKey && e.key.toLowerCase() === 'z') || (!e.shiftKey && e.key.toLowerCase() === 'y')
  );

/**
 * A label's size, as a number you can type or pick from a list.
 *
 * The field keeps a draft of its own, so a half-typed number is not clamped out from under
 * the typist: on the way to 37, "3" is too small to apply and is simply left alone. A number
 * in range applies as it is typed; leaving the field or pressing Return settles anything
 * else to the nearest size there is. The arrow keys step it by one.
 *
 * The presets are a plain `<select>` beside it, not a `<datalist>`: Chromium draws a datalist's
 * button inside a field this narrow, so a click on the number landed on the button and typing
 * went nowhere. A select behaves the same in every browser.
 */
function SizeField({ value, onChange, onDone }: {
  value: number;
  onChange: (size: number) => void;
  onDone?: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(String(value));
  }, [value]);
  const parse = (s: string) => (s.trim() === '' ? NaN : Number(s));
  const commit = () => {
    const n = parse(draft);
    const next = Number.isFinite(n) ? Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n))) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  // The size in use is in the list too, in its place, so the list always shows what is set.
  const options = [...new Set([...SIZE_PRESETS, value])].sort((a, b) => a - b);
  return (
    <span className="setsize">
      <label data-tip="Text size, in pixels of the saved image">
        <input
          ref={ref}
          type="number"
          min={SIZE_MIN}
          max={SIZE_MAX}
          step={1}
          value={draft}
          aria-label="Text size in pixels"
          onChange={(e) => {
            setDraft(e.target.value);
            const n = parse(e.target.value);
            if (Number.isInteger(n) && n >= SIZE_MIN && n <= SIZE_MAX) onChange(n);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); onDone?.(); }
          }}
        />
        <span aria-hidden>px</span>
      </label>
      <select
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Text size presets"
        data-tip="Pick a size"
      >
        {options.map((n) => <option key={n} value={n}>{n} px</option>)}
      </select>
    </span>
  );
}

/**
 * Annotating a screenshot.
 *
 * Everything is kept as a list of marks rather than painted straight onto the canvas, so
 * undo is a pop rather than a history of bitmaps — and so the base image is never
 * destroyed. The export composites once, at the end.
 */
export function ShotEditor({
  src, onCancel, onSave,
}: {
  src: string;
  onCancel: () => void;
  onSave: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  /**
   * Marks live in a ref as well as in state.
   *
   * Clicking Done blurs the text input, which commits the label — and a click handler in
   * the same tick still sees the pre-blur state. The first label anybody typed went
   * missing from the saved image for exactly that reason.
   */
  const marksRef = useRef<Mark[]>([]);
  const [marks, setMarksState] = useState<Mark[]>([]);
  const setMarks = (next: Mark[] | ((prev: Mark[]) => Mark[])) => {
    marksRef.current = typeof next === 'function' ? next(marksRef.current) : next;
    setMarksState(marksRef.current);
  };

  /** A new mark ends the redo branch, the way every editor behaves. */
  const addMark = (m: Mark) => {
    redoRef.current = [];
    setRedoDepth(0);
    setMarks((prev) => [...prev, m]);
  };

  const undo = useCallback(() => {
    const last = marksRef.current.at(-1);
    if (!last) return;
    redoRef.current = [...redoRef.current, last];
    setRedoDepth(redoRef.current.length);
    setSelected(null);
    setMarks((prev) => prev.slice(0, -1));
  }, []);

  const redo = useCallback(() => {
    const next = redoRef.current.at(-1);
    if (!next) return;
    redoRef.current = redoRef.current.slice(0, -1);
    setRedoDepth(redoRef.current.length);
    setMarks((prev) => [...prev, next]);
  }, []);

  const clearAll = () => {
    setSelected(null);
    redoRef.current = [...redoRef.current, ...marksRef.current];
    setRedoDepth(redoRef.current.length);
    setMarks([]);
  };
  // Freehand first: it is what people reach for, and every other tool is a refinement of
  // "point at the thing".
  const [tool, setTool] = useState<Tool>('pen');
  const [colourOpen, setColourOpen] = useState(false);
  const colourOpenRef = useRef(false);
  colourOpenRef.current = colourOpen;
  /** ⌘ on Apple devices, Ctrl elsewhere, for the tooltips. Decided after mount. */
  const [mod, setMod] = useState('Ctrl+');
  useEffect(() => { if (/Mac|iPad|iPhone|iPod/i.test(navigator.platform)) setMod('⌘'); }, []);
  const redoRef = useRef<Mark[]>([]);
  const [redoDepth, setRedoDepth] = useState(0);
  const [colour, setColour] = useState(COLOURS[0]!.id);
  const [weight, setWeight] = useState(1);
  /** The shape picked with the select tool, by its index in marks. */
  const [selected, setSelected] = useState<number | null>(null);
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected;
  const shapeDrag = useRef<{ index: number; last: [number, number] } | null>(null);
  const [drawing, setDrawing] = useState<Mark | null>(null);
  /** A crop being drawn or moved: where the pointer went down, and the crop before it. */
  const cropDrag = useRef<{ mode: 'new' | 'move'; start: [number, number]; from: Crop['rect'] } | null>(null);
  /** The label currently being typed or selected, by id (issue 0014). */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; mode: 'move' | 'size'; ox: number; oy: number } | null>(null);
  /** Read inside the key handler, which must not be rebuilt on every selection change. */
  const activeIdRef = useRef<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * Text settings live outside the draft so they survive between labels. The size is null
   * until somebody picks one, and until then it follows the width of the picture.
   */
  const [textSize, setTextSize] = useState<number | null>(null);
  const [bold, setBold] = useState(true);
  const [ready, setReady] = useState(false);
  /** How wide the picture is on screen. A label's type is drawn at its saved size times this. */
  const [shownWidth, setShownWidth] = useState(0);
  const [canPick, setCanPick] = useState(false);
  /** The eyedropper is open (see pickFromScreen): its Escape must not close the editor. */
  const eyeOpenRef = useRef(false);
  const measureRef = useRef<CanvasRenderingContext2D | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barWidth, setBarWidth] = useState(0);

  // Load the base image once; every redraw paints it first.
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const c = canvasRef.current;
      if (c) {
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
      }
      setReady(true);
    };
    img.src = src;
  }, [src]);

  useEffect(() => {
    setCanPick(eyeDropper() !== null);
    // Labels are measured and saved in IBM Plex Sans. If a weight arrives after a label was
    // measured, measure again rather than keep a width taken from the fallback font.
    void Promise.all([fontOf(24, false), fontOf(24, true)].map((f) => document.fonts?.load(f)))
      .then(() => setMarks((prev) => prev.map((m) => (m.tool === 'text' ? fit(m) : m))))
      .catch(() => { /* the fallback font measures consistently too */ });
  }, []);

  // The window can be resized with the editor open; a label's type has to follow the picture.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !ready) return;
    const ro = new ResizeObserver(() => setShownWidth(c.getBoundingClientRect().width));
    ro.observe(c);
    return () => ro.disconnect();
  }, [ready]);

  // The label bar's width, so it can be kept inside the picture (below).
  useLayoutEffect(() => {
    const w = barRef.current?.offsetWidth ?? 0;
    if (w !== barWidth) setBarWidth(w);
  });

  /**
   * Wrap a label the way the field on screen wraps it: explicit newlines first, then greedy
   * wrapping inside each paragraph at the label's own width. Spaces are kept as typed, since
   * the box was measured with them, and a word wider than the box breaks inside itself.
   */
  const wrapLines = (ctx: CanvasRenderingContext2D, text: string, width: number): string[] => {
    const out: string[] = [];
    const fits = (s: string) => ctx.measureText(s).width <= width;
    for (const para of text.split('\n')) {
      let line = '';
      for (const token of para.match(/\s*\S+|\s+/g) ?? []) {
        // Spaces at the end of a line hang past the edge, as they do in the field.
        if (!token.trim() || !line.trim() || fits(line + token)) line += token;
        else { out.push(line); line = token.trimStart(); }
        while (!fits(line)) {
          const chars = [...line];
          let cut = 1;
          while (cut < chars.length && fits(chars.slice(0, cut + 1).join(''))) cut++;
          if (cut >= chars.length) break;
          out.push(chars.slice(0, cut).join(''));
          line = chars.slice(cut).join('');
        }
      }
      out.push(line);
    }
    return out;
  };

  /**
   * `withText` is false while editing: placed labels are real DOM elements in the editor so
   * they can be moved, resized and retyped, and they are composited onto the canvas once, at
   * export. Painting them in both places would double them.
   */
  const paint = (target: HTMLCanvasElement, all: Mark[], withText = false, offset: [number, number] = [0, 0]) => {
    const img = imgRef.current;
    const ctx = target.getContext('2d');
    if (!ctx || !img) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, target.width, target.height);
    // Saving a crop paints the whole picture shifted, into a canvas the crop's size.
    ctx.translate(-offset[0], -offset[1]);
    ctx.drawImage(img, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const m of all) {
      if (m.tool === 'crop') continue;
      ctx.strokeStyle = m.colour;
      ctx.fillStyle = m.colour;
      if (m.tool === 'pen') {
        ctx.lineWidth = m.width;
        ctx.beginPath();
        m.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
      } else if (m.tool === 'box') {
        ctx.lineWidth = m.width;
        ctx.strokeRect(m.from[0], m.from[1], m.to[0] - m.from[0], m.to[1] - m.from[1]);
      } else if (m.tool === 'arrow' || m.tool === 'line') {
        ctx.lineWidth = m.width;
        const [x1, y1] = m.from;
        const [x2, y2] = m.to;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        if (m.tool === 'arrow') {
          const a = Math.atan2(y2 - y1, x2 - x1);
          const head = Math.max(12, m.width * 4);
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - head * Math.cos(a - Math.PI / 7), y2 - head * Math.sin(a - Math.PI / 7));
          ctx.lineTo(x2 - head * Math.cos(a + Math.PI / 7), y2 - head * Math.sin(a + Math.PI / 7));
          ctx.closePath();
          ctx.fill();
        }
      } else if (withText) {
        ctx.font = fontOf(m.size, m.bold);
        const lines = wrapLines(ctx, m.text, m.width);
        const lh = m.size * LEADING;
        ctx.fillStyle = m.colour;
        /**
         * On the baseline the field uses — half the leading, then the ascent — so a label is
         * saved where it was typed rather than a few pixels higher.
         */
        const met = ctx.measureText('Hg');
        if (Number.isFinite(met.fontBoundingBoxAscent) && Number.isFinite(met.fontBoundingBoxDescent)) {
          ctx.textBaseline = 'alphabetic';
          const base = (lh - met.fontBoundingBoxAscent - met.fontBoundingBoxDescent) / 2 + met.fontBoundingBoxAscent;
          lines.forEach((line, i) => ctx.fillText(line, m.at[0], m.at[1] + base + i * lh));
        } else {
          ctx.textBaseline = 'top';
          lines.forEach((line, i) => ctx.fillText(line, m.at[0], m.at[1] + (lh - m.size) / 2 + i * lh));
        }
      }
    }
    // The selected shape, outlined on screen only: never in the saved image.
    const sel = selectedRef.current === null ? undefined : all[selectedRef.current];
    if (!withText && sel && sel.tool !== 'text' && sel.tool !== 'crop') {
      const b = bounds(sel);
      const pad = sel.width + Math.max(6, target.width / 300);
      ctx.save();
      ctx.setLineDash([Math.max(4, target.width / 250), Math.max(3, target.width / 400)]);
      ctx.lineWidth = Math.max(1.5, target.width / 900);
      ctx.strokeStyle = '#1A1917';
      ctx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
      ctx.lineDashOffset = Math.max(4, target.width / 250);
      ctx.strokeStyle = '#EFEBE2';
      ctx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
      ctx.restore()
    }
    // On screen, what the crop leaves out is dimmed, and its edge drawn.
    const crop = cropOf(all);
    if (!withText && crop) {
      const [x0, y0, x1, y1] = crop;
      ctx.save();
      ctx.fillStyle = 'rgba(26, 25, 23, 0.6)';
      ctx.beginPath();
      ctx.rect(0, 0, target.width, target.height);
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.fill('evenodd');
      ctx.lineWidth = Math.max(1.5, target.width / 700);
      ctx.setLineDash([Math.max(4, target.width / 250), Math.max(3, target.width / 400)]);
      ctx.strokeStyle = '#EFEBE2';
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    }
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (c && ready) paint(c, drawing ? [...marks, drawing] : marks, false);
  }, [marks, drawing, ready, selected]);

  /** Pointer position in image pixels, whatever size the canvas is displayed at. */
  const at = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return [
      ((e.clientX - r.left) / r.width) * c.width,
      ((e.clientY - r.top) / r.height) * c.height,
    ];
  };

  /** The picture's natural stroke width, times the chosen weight. */
  const baseWidth = () => Math.max(3, Math.round((canvasRef.current?.width ?? 1400) / 420));
  const width = () => Math.max(1, Math.round(baseWidth() * weight));
  /** Base size scales with the image so a label reads the same on any capture. */
  const baseSize = () => Math.max(14, Math.round((canvasRef.current?.width ?? 1400) / 58));
  const penSize = () => textSize ?? baseSize();

  const textWidth = (text: string, size: number, isBold: boolean) => {
    measureRef.current ??= document.createElement('canvas').getContext('2d');
    const ctx = measureRef.current;
    if (!ctx) return 0;
    ctx.font = fontOf(size, isBold);
    return ctx.measureText(text).width;
  };

  /**
   * A label nobody has sized is as wide as its longest line, out to the edge of the picture;
   * past the edge it wraps and grows downwards. Once the corner has been dragged the width is
   * the user's, and typing only ever adds height.
   */
  const fit = (l: Label): Label => {
    if (l.sized) return l;
    const room = Math.max(l.size * 2, (canvasRef.current?.width ?? 1400) - l.at[0] - l.size * 0.25);
    const longest = Math.max(...(l.text || PLACEHOLDER).split('\n').map((s) => textWidth(s, l.size, l.bold)));
    // A fifth of an em over the text: room for the caret, and for the field's own rounding,
    // so it never wraps a line the saved image would not.
    return { ...l, width: Math.min(room, Math.ceil(Math.max(l.size, longest + l.size * 0.2))) };
  };

  const down = (e: React.PointerEvent) => {
    if (!ready) return;
    if (editingId) stopEditing();
    setActiveId(null);
    const p = at(e);
    if (tool === 'select') {
      // The nearest shape within reach of the pointer, newest first; empty space deselects.
      const reach = Math.max(8, baseWidth() * 3);
      let hit: number | null = null;
      for (let i = marksRef.current.length - 1; i >= 0; i -= 1) {
        const m = marksRef.current[i]!;
        if (m.tool !== 'text' && m.tool !== 'crop' && distance(m, p) <= reach + m.width / 2) { hit = i; break; }
      }
      setSelected(hit);
      if (hit !== null) {
        shapeDrag.current = { index: hit, last: p };
        try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* already released */ }
      }
      return;
    }
    setSelected(null);
    if (tool === 'text') {
      // Stops the browser moving focus out of the field we are about to create.
      e.preventDefault();
      const id = `l${Date.now()}`;
      addMark(fit({
        tool: 'text', id, colour, size: penSize(), at: p,
        width: 0, sized: false, height: 0, text: '', bold,
      }));
      setActiveId(id);
      setEditingId(id);
      return;
    }
    // A pointer the browser already let go of cannot be captured; the stroke still starts.
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* already released */ }
    if (tool === 'crop') {
      // Inside the crop: move it. Anywhere else: draw a new one.
      const now = cropOf(marksRef.current);
      const moving = !!now && inside(now, p);
      cropDrag.current = { mode: moving ? 'move' : 'new', start: p, from: now };
      setDrawing({ tool: 'crop', rect: moving ? now : [p[0], p[1], p[0], p[1]] });
      return;
    }
    if (tool === 'pen') setDrawing({ tool: 'pen', colour, width: width(), points: [p] });
    else setDrawing({ tool, colour, width: width(), from: p, to: p });
  };

  const move = (e: React.PointerEvent) => {
    const sd = shapeDrag.current;
    if (sd) {
      const p = at(e);
      const [dx, dy] = [p[0] - sd.last[0], p[1] - sd.last[1]];
      sd.last = p;
      setMarks((prev) => prev.map((m, i) => (i === sd.index && m.tool !== 'text' && m.tool !== 'crop' ? moved(m, dx, dy) : m)));
      return;
    }
    const d = dragRef.current;
    if (d) {
      const p = at(e);
      if (d.mode === 'move') patch(d.id, { at: [p[0] - d.ox, p[1] - d.oy] });
      else patch(d.id, { width: Math.max(40, p[0] - d.ox), height: Math.max(0, p[1] - d.oy), sized: true });
      return;
    }
    if (!drawing) return;
    const p = at(e);
    const cd = cropDrag.current;
    if (drawing.tool === 'crop' && cd) {
      const c = canvasRef.current!;
      const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
      if (cd.mode === 'move' && cd.from) {
        const [x0, y0, x1, y1] = cd.from;
        const dx = Math.max(-x0, Math.min(c.width - x1, p[0] - cd.start[0]));
        const dy = Math.max(-y0, Math.min(c.height - y1, p[1] - cd.start[1]));
        setDrawing({ tool: 'crop', rect: [x0 + dx, y0 + dy, x1 + dx, y1 + dy] });
      } else {
        const [ax, ay] = [clamp(cd.start[0], c.width), clamp(cd.start[1], c.height)];
        const [bx, by] = [clamp(p[0], c.width), clamp(p[1], c.height)];
        setDrawing({ tool: 'crop', rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] });
      }
      return;
    }
    if (drawing.tool === 'pen') setDrawing({ ...drawing, points: [...drawing.points, p] });
    else if (drawing.tool !== 'text' && drawing.tool !== 'crop') setDrawing({ ...drawing, to: p });
  };

  const up = () => {
    if (shapeDrag.current) { shapeDrag.current = null; return; }
    if (dragRef.current) { dragRef.current = null; return; }
    if (!drawing) return;
    setDrawing(null);
    const cd = cropDrag.current;
    cropDrag.current = null;
    if (drawing.tool === 'crop') {
      const r = drawing.rect;
      const before = cd?.from ?? null;
      // A click without a drag lets go of the crop; a crop too small to see is a slip, not a crop.
      const tiny = !r || r[2] - r[0] < baseWidth() * 4 || r[3] - r[1] < baseWidth() * 4;
      const next = cd?.mode === 'new' && tiny ? null : r;
      if (JSON.stringify(next) !== JSON.stringify(before)) addMark({ tool: 'crop', rect: next });
      return;
    }
    addMark(drawing);
  };

  activeIdRef.current = activeId;

  /**
   * Focus the field the moment it attaches, and only then.
   *
   * The callback is stable. It used to be a new function on every render, so React detached
   * and re-attached it on every keystroke, and each re-attach put the caret back at the end:
   * a word typed into the middle of a label came out with all but its first letter at the
   * end. Now it runs once when the field appears and once when it goes.
   */
  const attachField = useCallback((el: HTMLTextAreaElement | null) => {
    fieldRef.current = el;
    if (!el) return;
    /**
     * Deferred by a frame. Focusing inside the click that created the field loses the
     * focus again when the browser finishes handling that same click on the canvas
     * underneath — which is why the text tool looked like it did nothing at all.
     */
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  const labels = () => marksRef.current.filter((m): m is Label => m.tool === 'text');
  const labelOf = (id: string | null) => (id ? labels().find((l) => l.id === id) ?? null : null);

  const patch = (id: string, next: Partial<Label>) => {
    setMarks((prev) => prev.map((m) => (m.tool === 'text' && m.id === id ? fit({ ...m, ...next }) : m)));
  };

  const dropLabel = (id: string) => {
    setMarks((prev) => prev.filter((m) => !(m.tool === 'text' && m.id === id)));
    if (activeId === id) setActiveId(null);
    if (editingId === id) setEditingId(null);
  };

  /**
   * Leaving the text field keeps what was typed (issue 0014).
   *
   * Escape used to throw the label away, and because Escape is also how people leave a text
   * field by reflex, it threw away work they thought they were saving. An empty label is the
   * only one that disappears, and it disappears because it is empty.
   */
  const stopEditing = () => {
    const l = labelOf(editingId);
    if (l && !l.text.trim()) dropLabel(l.id);
    setEditingId(null);
  };

  /**
   * The shortcuts people already have in their fingers. Suppressed while a label is being
   * typed, where the browser's own undo belongs to the input.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inText = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (e.key === 'Escape') {
        if (eyeOpenRef.current) return;
        /**
         * One level at a time (issue 0014). In the size or colour field: leave it. In a label:
         * keep the text and leave the field. With a label selected: deselect. Otherwise: close
         * the editor. Escape used to jump straight out and take the label with it.
         */
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
          e.target.blur();
          return;
        }
        if (colourOpenRef.current) { setColourOpen(false); return; }
        if (inText || editingId) { stopEditing(); return; }
        if (activeIdRef.current) { setActiveId(null); return; }
        if (selectedRef.current !== null) { setSelected(null); return; }
        onCancel();
        return;
      }
      if (inText) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current !== null) {
        e.preventDefault();
        const gone = selectedRef.current;
        setSelected(null);
        setMarks((prev) => prev.filter((_, i) => i !== gone));
        return;
      }
      if (isUndo(e)) { e.preventDefault(); undo(); }
      else if (isRedo(e)) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, onCancel, editingId]);

  const save = () => {
    const out = document.createElement('canvas');
    const c = canvasRef.current!;
    const crop = cropOf(marksRef.current);
    const [x0, y0, x1, y1] = crop ? crop.map(Math.round) as [number, number, number, number] : [0, 0, c.width, c.height];
    out.width = Math.max(1, x1 - x0);
    out.height = Math.max(1, y1 - y0);
    paint(out, marksRef.current, true, [x0, y0]);
    onSave(out.toDataURL('image/png'));
  };

  /**
   * The browser's own eyedropper, for a colour already in the screenshot. It can take one from
   * anywhere on the screen, which is more than it needs to.
   *
   * Escape cancels it. Whether the browser also hands that Escape to the page is untested, and
   * if it did, the editor would close and take every mark with it — so Escape is ignored while
   * the eyedropper is open and for a quarter of a second after. The quarter-second is a GUESS.
   */
  const pickFromScreen = (pick: (c: string) => void) => {
    const Dropper = eyeDropper();
    if (!Dropper) return;
    eyeOpenRef.current = true;
    void new Dropper().open()
      .then((r) => pick(hex6(r.sRGBHex)))
      .catch(() => { /* Escape, or nothing picked: nothing changes */ })
      .finally(() => { window.setTimeout(() => { eyeOpenRef.current = false; }, 250); });
  };

  /** The presets, then any colour at all, then one copied off the screenshot. */
  const colourPicks = (value: string, pick: (c: string) => void) => (
    <>
      {COLOURS.map((c) => (
        <button
          key={c.id}
          className={`swatch${sameColour(c.id, value) ? ' on' : ''}`}
          style={{ background: c.id }}
          onClick={() => pick(c.id)}
          aria-pressed={sameColour(c.id, value)}
          data-tip={c.name}
          aria-label={c.name}
        />
      ))}
      <input
        type="color"
        className={`swatch any${COLOURS.some((c) => sameColour(c.id, value)) ? '' : ' on'}`}
        value={hex6(value)}
        onChange={(e) => pick(e.target.value)}
        data-tip="Any color"
        aria-label="Any color"
      />
      {canPick && (
        <button
          className="setpipette"
          onClick={() => pickFromScreen(pick)}
          data-tip="Copy a color from the screenshot"
          aria-label="Copy a color from the screenshot"
        >
          {PIPETTE}
        </button>
      )}
    </>
  );

  const c = canvasRef.current;
  const W = c?.width || 1;
  const H = c?.height || 1;
  /** The picture's width on screen, and screen pixels per image pixel. */
  const shown = c ? shownWidth || c.getBoundingClientRect().width || c.width : 1;
  const scale = c && c.width ? shown / c.width : 1;
  const active = labelOf(activeId);

  return (
    <div className="shotedit" role="dialog" aria-label="Annotate the screenshot">
      <div className="setstage">
        <div className="setwrap">
          {/* Directly above the image: a toolbar at the top of a dark overlay, with the
              picture centred below it, is a toolbar nobody finds. */}
          <div className="setop" role="toolbar" aria-label="Annotation tools">
            <div className="settools" role="group" aria-label="Tool">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`seticon${t.id === tool ? ' on' : ''}`}
                  onClick={() => { stopEditing(); setSelected(null); setTool(t.id); }}
                  aria-pressed={t.id === tool}
                  aria-label={t.name}
                  data-tip={t.name}
                >
                  {t.glyph}
                </button>
              ))}
            </div>
            <span className="setdiv" aria-hidden />
            {/* Color and stroke width share one button and one popover: two more buttons would not
                fit the row on a phone. The button shows both, the dot in the color at the width. */}
            <div className="setcols" role="group" aria-label="Color and stroke width">
              <button
                type="button"
                className="seticon setcolour"
                onClick={() => setColourOpen((v) => !v)}
                aria-expanded={colourOpen}
                aria-label={`Color and stroke width: ${COLOURS.find((x) => sameColour(x.id, colour))?.name ?? hex6(colour)}, ${WEIGHTS.find((w) => w.id === weight)?.name ?? ''}`}
                data-tip="Color and stroke width"
              >
                <span className="setdot" style={{ background: colour }} />
                <span className="setdotweight" style={{ height: `${Math.max(1.5, weight * 2)}px`, background: colour }} />
              </button>
              {colourOpen && (
                <div className="setcolpop setcolgrid" role="group" aria-label="Pick a color and a stroke width">
                  <div className="setcolrow" role="group" aria-label="Color">
                    {colourPicks(colour, (next) => {
                      setColour(next);
                      // A selected shape takes the new color too.
                      if (selected !== null) setMarks((prev) => prev.map((m, i) => (i === selected && m.tool !== 'crop' ? { ...m, colour: next } : m)));
                    })}
                  </div>
                  <div className="setcolrow" role="group" aria-label="Stroke width">
                    {WEIGHTS.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        className={`setweightpick${w.id === weight ? ' on' : ''}`}
                        aria-pressed={w.id === weight}
                        aria-label={`${w.name} stroke`}
                        data-tip={`${w.name} stroke`}
                        onClick={() => {
                          setWeight(w.id);
                          // A selected shape takes the new width too.
                          if (selected !== null) {
                            const next = Math.max(1, Math.round(baseWidth() * w.id));
                            setMarks((prev) => prev.map((m, i) => (i === selected && m.tool !== 'text' && m.tool !== 'crop' ? { ...m, width: next } : m)));
                          }
                        }}
                      >
                        <span className="setweight" style={{ height: `${Math.max(1.5, w.id * 2.5)}px`, background: colour }} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <span className="setdiv" aria-hidden />
            <div className="setacts" role="group" aria-label="History">
              <button type="button" className="seticon" onClick={undo} disabled={marks.length === 0}
                aria-label="Undo" aria-keyshortcuts="Meta+Z Control+Z" data-tip={`Undo (${mod}Z)`}>{ICON.undo}</button>
              <button type="button" className="seticon" onClick={redo} disabled={redoDepth === 0}
                aria-label="Redo" aria-keyshortcuts="Meta+Shift+Z Control+Y" data-tip={`Redo (${mod}⇧Z)`}>{ICON.redo}</button>
              <button type="button" className="seticon" onClick={clearAll} disabled={marks.length === 0}
                aria-label="Clear every mark" data-tip="Clear every mark">{ICON.clear}</button>
            </div>
            <span className="setdiv" aria-hidden />
            <div className="setend" role="group" aria-label="Finish">
              <button type="button" className="seticon" onClick={onCancel}
                aria-label="Cancel" aria-keyshortcuts="Escape" data-tip="Cancel (Esc)">{ICON.close}</button>
              <button type="button" className="seticon p" onClick={save}
                aria-label="Done" data-tip="Done: keep the annotations">{ICON.done}</button>
            </div>
          </div>

          {/* The picture's own box, and nothing else, so a label's position is a share of the
              picture. It was a share of the picture and the toolbar together, which drew every
              label higher on screen than it was saved. */}
          <div className="setimg">
            <canvas
              ref={canvasRef}
              className={`setcanvas t-${tool}`}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
            />
            {/* Placed labels are DOM objects: move them, resize them, type in them again.
                They are composited onto the image at export. */}
            {marks.filter((m): m is Label => m.tool === 'text').map((l) => {
              const editing = editingId === l.id;
              return (
                <div
                  key={l.id}
                  className={`setlabel${activeId === l.id ? ' on' : ''}${editing ? ' editing' : ''}`}
                  style={{
                    left: `${(l.at[0] / W) * 100}%`,
                    top: `${(l.at[1] / H) * 100}%`,
                    color: l.colour,
                    fontWeight: l.bold ? 600 : 400,
                    // Not rounded: the field wraps where the saved image will.
                    fontSize: `${l.size * scale}px`,
                    lineHeight: LEADING,
                  }}
                  onPointerDown={(e) => {
                    if (editing) return;
                    e.stopPropagation();
                    if (editingId) stopEditing();
                    setActiveId(l.id);
                    const p = at(e);
                    dragRef.current = { id: l.id, mode: 'move', ox: p[0] - l.at[0], oy: p[1] - l.at[1] };
                    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* already released */ }
                  }}
                  /* The label captures the pointer when a drag starts, so the moves arrive
                     here rather than on the canvas underneath. */
                  onPointerMove={move}
                  onPointerUp={up}
                  onDoubleClick={(e) => { e.stopPropagation(); setActiveId(l.id); setEditingId(l.id); }}
                >
                  <div
                    className="setbody"
                    style={{
                      width: `${l.width * scale}px`,
                      minHeight: l.height ? `${l.height * scale}px` : undefined,
                    }}
                  >
                    {/* The text as it will be saved. While it is being typed it is invisible and
                        only gives the box its height, so the box grows with the text. The field
                        used to be two lines tall and scroll, so a longer label snapped back to
                        two lines the moment it was typed in again. The trailing space holds
                        open a last line that is still empty. */}
                    <div className="settextview" aria-hidden={editing || undefined}>
                      {`${editing ? l.text || PLACEHOLDER : l.text || 'Empty label'} `}
                    </div>
                    {editing && (
                      <textarea
                        ref={attachField}
                        className="settext"
                        value={l.text}
                        placeholder={PLACEHOLDER}
                        aria-label="Label text"
                        onChange={(e) => patch(l.id, { text: e.target.value })}
                        onKeyDown={(e) => {
                          // Return is a line break. Escape leaves the field and keeps the text.
                          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopEditing(); }
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); stopEditing(); }
                        }}
                      />
                    )}
                  </div>
                  {activeId === l.id && (
                    <span
                      className="setgrip"
                      title="Drag to set the size of the box"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        // Keeps the caret in the field while the box is resized around it.
                        e.preventDefault();
                        const p = at(e);
                        const body = e.currentTarget.parentElement?.querySelector<HTMLElement>('.setbody');
                        const h = body ? body.getBoundingClientRect().height / scale : l.height;
                        dragRef.current = { id: l.id, mode: 'size', ox: p[0] - l.width, oy: p[1] - h };
                        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* already released */ }
                      }}
                    />
                  )}
                </div>
              );
            })}

            {active && (
              <div
                ref={barRef}
                className="settextbar floating"
                style={{
                  // Kept inside the picture: beside a label near the right-hand edge it ran off
                  // the screen, with Done and × in the part that was cut off.
                  left: `${Math.max(0, Math.min(active.at[0] * scale - 6, shown - barWidth))}px`,
                  top: `${(active.at[1] / H) * 100}%`,
                }}
                // A button here must not take the caret out of the label. The size, the list
                // of sizes and the colour field do need the focus they are clicked for.
                onMouseDown={(e) => {
                  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) e.preventDefault();
                }}
              >
                <SizeField
                  value={active.size}
                  onChange={(n) => { setTextSize(n); patch(active.id, { size: n }); }}
                  onDone={() => fieldRef.current?.focus()}
                />
                <button
                  className={active.bold ? 'on' : ''}
                  onClick={() => { const b = !active.bold; setBold(b); patch(active.id, { bold: b }); }}
                  aria-pressed={active.bold}
                  data-tip="Bold"
                  style={{ fontWeight: 700 }}
                >
                  B
                </button>
                <span className="sep" />
                {colourPicks(active.colour, (next) => { setColour(next); patch(active.id, { colour: next }); })}
                <span className="sep" />
                {editingId === active.id ? (
                  <button onClick={stopEditing} data-tip="Keep it and stop typing">Done</button>
                ) : (
                  <button onClick={() => setEditingId(active.id)} data-tip="Type in it again">Edit</button>
                )}
                <button onClick={() => dropLabel(active.id)} data-tip="Delete this label" aria-label="Delete this label">×</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="setnote">
        {marks.length} mark{marks.length === 1 ? '' : 's'} · <b>{mod}Z</b> undo · <b>{mod}⇧Z</b> redo ·{' '}
        the arrow tool selects a mark: drag it to move it, <b>Delete</b> removes it, and a color or
        stroke width picked while it is selected applies to it · crop: drag the part to keep, drag
        inside it to move it, click outside it to keep the whole picture again ·{' '}
        <b>Esc</b> leaves the text field, then the selection, then the editor. A label widens as
        you type until it reaches the edge of the picture, then wraps; drag it to move it, drag its
        corner to set its size, double-click to retype it. <b>Return</b> inside one is a line
        break. The annotated image is what gets filed — the original is not kept separately, so
        circle the thing rather than describing where it was.
      </p>
    </div>
  );
}
