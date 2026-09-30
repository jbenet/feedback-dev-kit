'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ShotEditor } from './ShotEditor';
import { capturePage, capturePageExact, METHOD_LABEL, type CaptureMethod, type Region } from './capture';
import { RegionPicker } from './RegionPicker';
import { ShortcutList, useShortcutPlatform } from './KeyboardShortcuts';
import { ariaShortcut, isFeedbackKey, isShortcutsKey, shortcutLabel } from './keyboard';
import { MarkdownField, packAttachments, type DroppedImage } from './MarkdownField';
import {
  configureDrafts, discardDraft, listDrafts, readDraft, readPictures, writeDraft, writePictures, type DraftSummary,
} from './drafts';
import { configureOutbox, enqueue, startOutbox, type OutboxState } from './outbox';
import { useOutbox } from './FeedbackOutbox';
import { firstLine } from './journal';
import { newRequestKey } from './request-key';
import { currentLocation, themeStyle, useFeedbackConfig, type ResolvedFeedbackConfig } from './config';
import { savedAt } from './time';
import { useFocusTrap } from './useSheet';

export type Kind = 'bug' | 'request' | 'question' | 'chore';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * What a priority *means*, not when it will be fixed. How fast anything gets fixed is a function
 * of how full the queue is, and a promise the queue cannot keep teaches people to file everything
 * as P0.
 */
export const PRIORITY_MEANS: Record<Priority, string> = {
  P0: 'Blocking — nobody can work around this',
  P1: 'Serious — there is a workaround and it hurts',
  P2: 'Normal — worth doing, not urgent',
  P3: 'Someday — a good idea with no clock on it',
};

/** The outbox and the drafts read their names and URL from the provider, once per page. */
function useConfiguredStorage(config: ResolvedFeedbackConfig) {
  configureOutbox({ submitUrl: config.endpoints.submit, prefix: config.storagePrefix });
  configureDrafts(config.storagePrefix);
}

/** Whether the feedback box is open, for an app that wants to open it from its own control. */
const OPEN_EVENT = 'feedbackkit:open';
/** Open the feedback box from anywhere (a menu item, a help page). A FeedbackButton must be mounted. */
export const openFeedback = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_EVENT)); };

/**
 * The launcher: a button, and the keyboard shortcut (Alt+F by default) anywhere outside text
 * fields and dialogs. Mount one per page, usually in the layout. It also starts the outbox, which
 * sends what an earlier page, tab or session kept.
 */
export function FeedbackButton({
  variant = 'bar', className, children,
}: {
  /** `rail`: a dark sidebar's footer. `bar`: an ordinary button. `floating`: pinned bottom-right. */
  variant?: 'bar' | 'rail' | 'floating';
  className?: string;
  children?: ReactNode;
}) {
  const config = useFeedbackConfig();
  useConfiguredStorage(config);
  const [open, setOpen] = useState(false);
  const { apple } = useShortcutPlatform();
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => { startOutbox(); }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isFeedbackKey(event, config.shortcut) || document.querySelector('dialog[open], [role="dialog"]:not(dialog):not([hidden])')) return;
      event.preventDefault();
      setOpen(true);
    };
    const onOpen = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener(OPEN_EVENT, onOpen); };
  }, [config.shortcut]);

  const label = shortcutLabel(config.shortcut, apple);
  const cls = variant === 'rail' ? 'railfeedback' : variant === 'floating' ? 'btn floatfeedback' : 'btn';
  return (
    <span className="fbk fbk-launch" style={themeStyle(config.theme)}>
      <button
        ref={opener}
        type="button"
        className={`${cls}${className ? ` ${className}` : ''}`}
        onClick={() => setOpen(true)}
        aria-keyshortcuts={ariaShortcut(config.shortcut, apple)}
        data-tip={`Give feedback (${label})`}
      >
        {children ?? (variant === 'rail' ? <><span aria-hidden>✎</span> Feedback</> : 'Give feedback')}
        <span className="feedbackkey">{label}</span>
      </button>
      {open && <FeedbackDrawer onClose={() => { setOpen(false); requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })); }} />}
    </span>
  );
}

interface Shot {
  id: string;
  dataUrl: string;
  method: CaptureMethod;
  annotated: boolean;
  /** The reporter said the automatic capture does not match the screen. */
  misaligned?: boolean;
}

/**
 * The box itself: a sheet from the right (the whole width on a phone). No title field — the
 * server writes the title from what was said. Screenshots first (one taken automatically), then
 * the words, kind and priority; ⌘/Ctrl+Enter files it, Esc closes it, and the draft is kept per
 * page until it is filed.
 */
export function FeedbackDrawer({ onClose }: { onClose: () => void }) {
  const config = useFeedbackConfig();
  const { modifier } = useShortcutPlatform();
  /**
   * Screenshots are a list. The first is taken automatically when the box opens — a redraw, no
   * dialog, and the feedback panel redacted out of it. The buttons **add** rather than replace,
   * because a second shot of a different part of the page is a second piece of evidence, and one
   * somebody has already annotated must not vanish because they pressed the button again.
   */
  const [shots, setShots] = useState<Shot[]>([]);
  const [shooting, setShooting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** A picture dropped into the description, being drawn on. */
  const [editingImage, setEditingImage] = useState<number | null>(null);
  /** Bumped per draft, so the description field starts from its words rather than from a reset. */
  const [generation, setGeneration] = useState(0);
  const seeded = useRef(false);

  const add = (dataUrl: string, method: CaptureMethod) => {
    setShots((prev) => [...prev, { id: `${Date.now()}-${prev.length}`, dataUrl, method, annotated: false }]);
  };

  /** The automatic one. Its failure is silent — it was never asked for. */
  const seedShot = () => { void capturePage().then((c) => { if (c) add(c.dataUrl, c.method); }); };

  /**
   * Another picture, using the browser's own screen capture. It shows a permission dialog and it
   * cannot redact — which is exactly the trade somebody makes when the automatic redraw has got
   * the layout wrong. Declined or unsupported, it falls back to the redraw.
   */
  const take = (region?: Region) => {
    setShooting(true);
    setPicking(false);
    setFailed(false);
    requestAnimationFrame(() => {
      void capturePageExact(region)
        .then((c) => { if (c) add(c.dataUrl, c.method); else setFailed(true); })
        .catch(() => setFailed(true))
        // Whatever happens, the drawer comes back: a capture that hangs gives up.
        .finally(() => setShooting(false));
    });
  };

  const drop = (id: string) => setShots((prev) => prev.filter((x) => x.id !== id));
  const replace = (id: string, dataUrl: string) =>
    setShots((prev) => prev.map((x) => (x.id === id ? { ...x, dataUrl, annotated: true } : x)));
  const flagMisaligned = (id: string) =>
    setShots((prev) => prev.map((x) => (x.id === id ? { ...x, misaligned: !x.misaligned } : x)));

  const here = currentLocation(config);
  const path = here.path;
  // This page's draft words, read before the first render: the text field is built once, with them,
  // so keys typed the moment the box opens are never lost to a rebuild.
  const [initial] = useState(() => readDraft(path));
  const [body, setBody] = useState(initial?.body ?? '');
  const [kind, setKind] = useState<Kind>((initial?.kind as Kind | undefined) ?? 'bug');
  const [priority, setPriority] = useState<Priority>((initial?.priority as Priority | undefined) ?? 'P2');
  /** 'saving' is the moment it goes into this browser's outbox; nothing here waits on the server. */
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [imagesPending, setImagesPending] = useState(false);
  const [images, setImages] = useState<DroppedImage[]>([]);

  /**
   * The drawer and its editors are portalled to <body>, so a sticky or transformed ancestor of
   * the launcher cannot trap them under the page's own stacking contexts.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  /** Tab cycles inside the box, as in any modal; editors and the keys panel above it keep their own. */
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(mounted && !picking && !editingId && editingImage === null, panel);
  const [showKeys, setShowKeys] = useState(false);
  /** Wider, for a report that has got long. Remembered in this browser only. */
  const wideKey = `${config.storagePrefix}.feedback.wide`;
  const [wide, setWide] = useState(false);
  useEffect(() => {
    try { setWide(window.localStorage.getItem(wideKey) === '1'); } catch { /* private window */ }
  }, [wideKey]);
  const toggleWide = () => setWide((w) => {
    try { window.localStorage.setItem(wideKey, w ? '0' : '1'); } catch { /* private window */ }
    return !w;
  });

  /**
   * Escape closes the box, and ⌘/Ctrl+Enter files it. Escape is handled here and not in the
   * editors: the annotation editor and the region picker take it first when they are open, so the
   * drawer only sees it when it is the outermost thing on screen.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingId || editingImage !== null || picking) return;
      if (e.key === 'Escape') {
        if (showKeys) { setShowKeys(false); return; }
        e.preventDefault();
        onClose();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // On the filed screen it means another report, never filing the one just sent again.
        if (stateRef.current === 'saved') againRef.current?.();
        else void submitRef.current?.();
      }
      if (isShortcutsKey(e)) {
        e.preventDefault();
        setShowKeys((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editingId, editingImage, picking, showKeys, onClose]);

  const filtersKey = JSON.stringify(here.filters);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filters = useMemo(() => here.filters, [filtersKey]);
  // What the report was written on: the browser, the window and the screen, so a layout bug can be
  // reproduced on the device it was seen on.
  const [client, setClient] = useState<{ userAgent: string; viewport: string; pixelRatio: number; touch: boolean } | null>(null);
  useEffect(() => {
    setClient({
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      pixelRatio: window.devicePixelRatio,
      touch: navigator.maxTouchPoints > 0,
    });
  }, []);

  /**
   * Drafts. The box edits one draft at a time, named by the page it was started on: this page's,
   * until another is picked from the list beside Wider. Its words and its pictures are kept in
   * this browser as they change (drafts.ts) and dropped once it is filed. A draft is words, or a
   * picture somebody drew on or dropped in; the automatic screenshot alone is not one. Moving to
   * another page with the box open keeps editing the same draft.
   */
  const [draftPage, setDraftPage] = useState(path);
  const [restored, setRestored] = useState<{ at: string; pictures: number } | null>(null);
  const [others, setOthers] = useState<DraftSummary[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);
  /** While a draft's pictures are read back, nothing is saved over them. */
  const hydrating = useRef(false);
  const worthKeeping = Boolean(body.trim() || shots.some((x) => x.annotated) || images.length);

  /**
   * Put a draft in the box: its words at once, its pictures when IndexedDB answers. `carry` is what
   * to show when it brings no pictures — the screenshot already on screen, or (null) a fresh one.
   */
  const load = (page: string, carry: Shot[] | null, first = false) => {
    const d = first ? initial : readDraft(page);
    setDraftPage(page);
    setRestored(d ? { at: d.at ?? '', pictures: d.pictures ?? 0 } : null);
    setImages([]);
    if (!first) {
      setBody(d?.body ?? '');
      setKind((d?.kind as Kind | undefined) ?? 'bug');
      setPriority((d?.priority as Priority | undefined) ?? 'P2');
      setGeneration((g) => g + 1);
    }
    const fill = (kept: { shots: Shot[]; images: DroppedImage[] } | null) => {
      if (kept) { setShots(kept.shots); setImages(kept.images); }
      else if (carry) setShots(carry);
      else { setShots([]); seedShot(); }
    };
    if (d?.pictures) {
      hydrating.current = true;
      setShots([]);
      void readPictures<Shot, DroppedImage>(page).then((kept) => { hydrating.current = false; fill(kept); });
    } else if (d) setShots([]); // A saved draft with no pictures keeps the reporter's deletion.
    else fill(null);
  };
  // On opening: this page's draft, if there is one, else a fresh automatic screenshot.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    load(path, null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hydrating.current || state === 'saved') return;
    writeDraft(draftPage, worthKeeping
      ? { body, kind, priority, at: new Date().toISOString(), pictures: shots.length + images.length }
      : null);
  }, [body, kind, priority, shots, images, draftPage, state, worthKeeping]);
  // Pictures change rarely — taken, drawn on, removed — so each change is written as it happens.
  useEffect(() => {
    if (hydrating.current || state === 'saved') return;
    void writePictures<Shot, DroppedImage>(draftPage, worthKeeping ? { shots, images } : null);
  }, [shots, images, draftPage, state, worthKeeping]);
  useEffect(() => {
    setOthers(listDrafts().filter((d) => d.page !== draftPage));
  }, [draftPage, showDrafts, state]);

  /** The one in the box is already kept, as it stands; its pictures stay with it. */
  const switchTo = (page: string) => {
    load(page, worthKeeping ? null : shots);
    setShowDrafts(false);
  };
  const discard = (page: string) => {
    if (!window.confirm(`Discard the unsent draft started on ${page}? Its words and pictures go, and this cannot be undone.`)) return;
    void discardDraft(page).then(() => setOthers(listDrafts().filter((d) => d.page !== draftPage)));
  };

  const misaligned = shots.flatMap((x, i) => (x.misaligned ? [i + 1] : []));
  const context = useMemo(
    () => ({
      route: path,
      url: here.url,
      filters,
      ...(draftPage !== path ? { startedOn: draftPage } : {}),
      ...(client ? { client } : {}),
      ...(misaligned.length ? { capture: { misaligned } } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, here.url, filters, client, draftPage, misaligned.join(',')],
  );

  const submitRef = useRef<(() => Promise<void>) | null>(null);
  const againRef = useRef<(() => void) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Reports filed while the box has been open, newest last, with the number each got. The outbox
   * shows a filed number only for a few seconds, so each one is recorded here as it is reported.
   */
  const [filedHere, setFiledHere] = useState<FiledHere[]>([]);
  const outbox = useOutbox();
  useEffect(() => {
    setFiledHere((prev) => {
      let changed = false;
      const next = prev.map((f) => {
        const seen = standing(outbox, f);
        if (seen.id === f.id && seen.where === f.where) return f;
        changed = true;
        return { ...f, ...seen };
      });
      return changed ? next : prev;
    });
  }, [outbox]);
  const current = filedHere.at(-1);

  /**
   * File it. The report is kept in this browser first (outbox.ts), then posted with a 3 s timeout;
   * the server journals it and answers at once, and files it afterwards. The box closes either
   * way, and the status line says which it is: "Saved on the server" (safe to close the tab) or
   * "only on this device" (the server was not reached; it resends on its own). Only a report that
   * neither this browser nor the server could keep stays in the box, as a draft, with the reason.
   */
  const submit = async () => {
    if (!body.trim()) return;
    if (state !== 'idle' && state !== 'failed') return;
    if (imagesPending || hydrating.current) return;
    setError(null);
    // A picture deleted from the text is not sent — it may be the wrong one.
    const packed = packAttachments(body, images);
    // The filed screen shows at once: nothing waits on the server. Where the report stands is read
    // from the outbox by this key as it moves (sending, on the server, filed).
    const clientId = newRequestKey();
    setFiledHere((prev) => [...prev, { clientId, title: firstLine(packed.body) || 'Report', id: null, where: 'Sending…', refused: false }]);
    setState('saved');
    try {
      await enqueue({
        body: packed.body, kind, priority, page: path, context,
        screenshots: shots.map((x) => x.dataUrl),
        images: packed.images.map((i) => ({ name: i.name, dataUrl: i.dataUrl })),
        // The server numbers attachments with the screenshots first, so a body written against
        // `attachment:1` needs an offset for the screenshots still attached.
        imageOffset: shots.length,
      }, { clientId });
    } catch (err) {
      // Neither this browser nor the server kept it: back to the words, with the reason.
      setFiledHere((prev) => prev.filter((f) => f.clientId !== clientId));
      setError(err instanceof Error ? err.message : String(err));
      setState('failed');
      return;
    }
    // Kept in the outbox now: the draft goes, and nothing autosaves it back while the filed screen shows.
    void discardDraft(draftPage);
  };
  submitRef.current = submit;

  /** Another report from the same page: a fresh box, a new automatic screenshot. */
  const again = () => {
    setBody('');
    setImages([]);
    setShots([]);
    setFailed(false);
    setRestored(null);
    setError(null);
    setDraftPage(path);
    setGeneration((g) => g + 1);
    setState('idle');
    seedShot();
  };
  againRef.current = again;

  const ui = (
    <div className="fbk nocapture" style={themeStyle(config.theme)}>
      {editingId && (
        <ShotEditor
          src={shots.find((x) => x.id === editingId)!.dataUrl}
          onCancel={() => setEditingId(null)}
          onSave={(png) => { replace(editingId, png); setEditingId(null); }}
        />
      )}
      {editingImage !== null && images.some((i) => i.index === editingImage) && (
        <ShotEditor
          src={images.find((i) => i.index === editingImage)!.dataUrl}
          onCancel={() => setEditingImage(null)}
          onSave={(png) => {
            const which = editingImage;
            setImages((prev) => prev.map((i) => (i.index === which
              ? { ...i, dataUrl: png, contentType: 'image/png', annotated: true }
              : i)));
            setEditingImage(null);
          }}
        />
      )}
      {picking && <RegionPicker onPick={(r) => take(r)} onCancel={() => setPicking(false)} />}
      {showKeys && (
        <div className={`keycard nocapture${wide ? ' overdrawer' : ''}`} role="dialog" aria-label="Keyboard shortcuts">
          <div className="lbl">Keyboard · this dialog first</div>
          <ShortcutList group="feedback" />
          <button type="button" className="btn" onClick={() => setShowKeys(false)}>Close</button>
        </div>
      )}
      <div className={`scrim nocapture${picking || shooting ? ' away' : ''}`} onClick={onClose} />
      <div
        ref={panel}
        aria-modal="true"
        className={`drawer nocapture${wide ? ' wide' : ''}${picking || shooting ? ' away' : ''}`}
        role="dialog"
        aria-label="Give feedback"
      >
        <div className="drawerhead">
          <h2 className="fbhead">Feedback</h2>
          {others.length > 0 && state !== 'saved' && (
            <button
              type="button"
              className="drawerwide"
              onClick={() => setShowDrafts((v) => !v)}
              aria-expanded={showDrafts}
              data-tip="Unsent reports kept in this browser, started on other pages"
            >
              Drafts · {others.length}
            </button>
          )}
          <button
            type="button"
            className="drawerwide"
            onClick={toggleWide}
            aria-pressed={wide}
            data-tip={wide ? 'Back to the narrow panel' : 'Use more of the page for a long report'}
          >
            {wide ? '⇥ Narrower' : '⇤ Wider'}
          </button>
        </div>
        {state === 'saved' && current ? (
          <FiledScreen
            current={current}
            all={filedHere}
            href={config.issueHref}
            modifier={modifier}
            onAgain={again}
            onClose={onClose}
          />
        ) : (<>
        {showDrafts && others.length > 0 && state !== 'saved' && (
          <div className="draftlist">
            <div className="lbl">Unsent, kept in this browser · {others.length}</div>
            {others.map((d) => (
              <div className="draftrow" key={d.page}>
                <button type="button" className="draftopen" onClick={() => switchTo(d.page)}>
                  <b>{d.title}</b>
                  <span>
                    {d.page}{d.at ? ` · ${savedAt(d.at)}` : ''}
                    {d.pictures ? ` · ${d.pictures} ${d.pictures === 1 ? 'picture' : 'pictures'}` : ''}
                  </span>
                </button>
                <button type="button" className="draftx" onClick={() => discard(d.page)}>Discard</button>
              </div>
            ))}
            <p>
              Picking one puts it in this box, pictures and all{worthKeeping ? '; the one in the box now is kept' : ''}.
              It is filed with this page and says which page it was started on.
            </p>
          </div>
        )}

        <div className="fbcols">
          <div className="fbshots">
            <div className="lbl">Screenshots{shots.length > 0 ? ` · ${shots.length}` : ''}</div>

            <div className="shotlist">
              {shots.map((x, i) => (
                <div className="shotthumb" key={x.id}>
                  <button className="shotopen" type="button" onClick={() => setEditingId(x.id)} aria-label={`Annotate screenshot ${i + 1}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={x.dataUrl} alt={`Screenshot ${i + 1}`} />
                  </button>
                  <div className="mdembedbar">
                    <button type="button" onClick={() => setEditingId(x.id)} data-tip="Draw on this picture">✎ Annotate</button>
                    <button type="button" className="x" onClick={() => drop(x.id)} aria-label={`Remove screenshot ${i + 1}`} data-tip={`Delete screenshot ${i + 1}`}>×</button>
                  </div>
                  <div className="shotmeta">
                    <span className={`flag ${x.method === 'screen' ? 'f-ok' : 'f-mute'}`}>{METHOD_LABEL[x.method]}</span>
                    {x.annotated && <span className="flag f-ok">annotated</span>}
                    {x.method === 'render' && (
                      <button
                        type="button"
                        className={`misaligned${x.misaligned ? ' on' : ''}`}
                        aria-pressed={Boolean(x.misaligned)}
                        onClick={() => flagMisaligned(x.id)}
                        data-tip={
                          'The automatic capture is your browser redrawing the page from its own '
                          + 'markup. It needs no permission and it leaves this panel out — but it '
                          + 'can get spacing, wrapping or a form control subtly wrong.\n\n'
                          + 'Press to tell us it does not match your screen: the report says so, '
                          + 'which helps fix the capture. For exact pixels, press Whole page or '
                          + "Pick a part below; they take a screenshot in your browser."
                        }
                      >
                        {x.misaligned ? 'Misaligned · noted' : 'Misaligned? Tell us'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="shotpick">
              <button type="button" className="btn" onClick={() => take()} disabled={shooting}>
                <span className="gl" aria-hidden>▢</span>
                {shooting ? 'Capturing…' : 'Whole page'}
              </button>
              <button type="button" className="btn" onClick={() => setPicking(true)} disabled={shooting}>
                <span className="gl" aria-hidden>⌖</span>
                Pick a part
              </button>
              <span
                className="fbhelp" data-tip-end=""
                tabIndex={0}
                role="note"
                aria-label="About screenshots"
                data-tip={
                  (shots.length === 0
                    ? 'Optional — the report files without one.'
                    : 'Adds another; it does not replace what is already here.')
                  + " Both use your browser's screen capture for exact pixels where it can, and it will ask permission. "
                  + 'Click a screenshot to annotate it; use its × to delete it. '
                  + config.destinationNote
                }
              >
                ?
              </span>
            </div>
            {failed && (
              <p className="mdhint refused">
                No capture came back — declined, unsupported, or it took too long. Everything else
                still files.
              </p>
            )}
            {shots.some((x) => x.misaligned) && (
              <p className="mdhint">Thanks — the report says the automatic capture was off. Click the <b>Whole Page</b> or <b>Pick a Part</b> to take a screenshot in your browser.</p>
            )}
          </div>

          <div className="fbtext">
            {restored !== null && state === 'idle' && worthKeeping && (
              <p className="muted fbrestored">
                Your unsent draft {draftPage === path ? 'for this page' : <>started on <span className="mono">{draftPage}</span></>},
                kept in this browser{restored.at ? ` since ${savedAt(restored.at)}` : ''}
                {restored.pictures ? ', with its pictures' : ''}.
              </p>
            )}

            <div className="field">
              <span className="lbl">Enter any feedback:</span>
              <MarkdownField
                key={generation}
                value={body}
                onChange={setBody}
                images={images}
                onImages={setImages}
                onPendingChange={setImagesPending}
                onAnnotate={(i) => setEditingImage(i)}
                autoFocus
                label="Enter any feedback"
                placeholder={
                  'What you expected, what happened instead.\n'
                  + 'Markdown works. Drop or paste a screenshot from somewhere else in here.'
                }
              />
            </div>

            <div className="fieldrow">
              <label className="field">
                <span className="lbl">Kind</span>
                <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  <option value="bug">bug</option>
                  <option value="request">request</option>
                  <option value="question">question</option>
                  <option value="chore">chore</option>
                </select>
              </label>
              <label className="field">
                <span className="lbl">Priority</span>
                <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  {(Object.keys(PRIORITY_MEANS) as Priority[]).map((p) => (
                    <option key={p} value={p}>{p} — {PRIORITY_MEANS[p]}</option>
                  ))}
                </select>
              </label>
            </div>

            {state === 'failed' && (
              <div className="warn" role="alert" style={{ marginTop: 12 }}>
                <div className="lbl" style={{ color: 'var(--fbk-clay)' }}>Not saved</div>
                <p>Neither the server nor this browser could keep it ({error}). Your text and pictures are still in this draft; try File again, or copy the text somewhere safe.</p>
              </div>
            )}
          </div>
        </div>

        <div className="acts">
          <button
            type="button"
            className="btn p"
            disabled={!body.trim() || state === 'saving' || imagesPending}
            onClick={submit}
          >
            {state === 'saving' ? 'Saving…' : 'File it'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
        <div className="keyhint">
          <span><kbd>{modifier}</kbd><kbd>↵</kbd> file</span>
          <span><kbd>esc</kbd> close</span>
          <span><kbd>tab</kbd> next field</span>
          <button type="button" onClick={() => setShowKeys(true)}><kbd>?</kbd> all shortcuts</button>
          {config.userLabel && <span className="fbwho">Filing as <b>{config.userLabel}</b></span>}
        </div>
        {/* What goes with the report — the page, its filters, the device — is there to reproduce a
            bug, not to read: at the foot, folded, open on demand. */}
        <details className="more fbcaptured">
          <summary>Captured with it: the page, its filters and the device</summary>
          <div className="ctx">{JSON.stringify(context, null, 2)}</div>
        </details>
        </>)}
      </div>
    </div>
  );

  return mounted ? createPortal(ui, document.body) : null;
}

/** `#12` for a numeric id (the files store pads it, `0012`), else the id as it is. */
const issueLabel = (id: string) => (/^\d+$/.test(id) ? `#${Number(id)}` : id);

/** A report filed while the box was open, and where it stands. */
interface FiledHere { clientId: string; title: string; id: string | null; where: string; refused: boolean }

/**
 * Where one report stands, from the outbox: filed (with its number), refused, still in this browser,
 * being sent, or on the server waiting to be filed. What the outbox no longer mentions keeps what was
 * last seen, since a filed number is only on show for a few seconds.
 */
function standing(out: OutboxState, f: FiledHere): Pick<FiledHere, 'id' | 'where' | 'refused'> {
  const filed = out.filed.find((n) => n.clientId === f.clientId);
  if (filed?.error) return { id: null, where: `Refused by the server: ${filed.error}`, refused: true };
  if (filed?.id) return { id: filed.id, where: `Filed as issue ${filed.id}`, refused: false };
  if (filed) return { id: f.id, where: 'Saved on the server', refused: false };
  const entry = out.entries.find((e) => e.clientId === f.clientId);
  if (entry?.refused) return { id: null, where: `Refused by the server: ${entry.lastError ?? 'no reason given'}`, refused: true };
  if (out.sending.includes(f.clientId)) return { id: f.id, where: 'Sending…', refused: false };
  if (entry) {
    return { id: null, where: `Kept in this browser${entry.lastError ? ` (${entry.lastError})` : ''} · sent again when the server answers`, refused: false };
  }
  if (out.onServer.some((n) => n.clientId === f.clientId)) return { id: f.id, where: 'Saved on the server · being filed', refused: false };
  return { id: f.id, where: f.where, refused: f.refused };
}

/**
 * After File: the drawer stays open on where the report stands, so several can be filed in a row.
 * "Give more feedback" (and ⌘/Ctrl+Enter) gives a fresh box on the same page.
 */
function FiledScreen({ current, all, href, modifier, onAgain, onClose }: {
  current: FiledHere; all: FiledHere[]; href: (id: string) => string; modifier: string; onAgain: () => void; onClose: () => void;
}) {
  const heading = current.id ? `Filed as issue ${issueLabel(current.id)}` : current.where;
  // Nothing on this screen changes size when the number arrives: the heading is one line, the
  // thanks line is always there, the note under it keeps its line, and Open the issue is the same
  // element before and after (a link, disabled until there is somewhere to go).
  const note = current.refused ? '' : current.id
    ? 'You can close the box, or file another.'
    : 'Its number shows here when the server gives it one; you can close the box before then.';
  return (
    <div className="fbfiled" role="status" aria-live="polite">
      <h3 className={`fbfiledhead${current.refused ? ' refused' : ''}`} title={heading}>{heading}</h3>
      <p className="muted">Thanks — it is in the queue with this page, your filters and any screenshots attached.</p>
      <p className="muted fbfilednote">{note}</p>
      <div className="acts">
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <button type="button" className="btn p" onClick={onAgain} autoFocus>Give more feedback</button>
        <a
          className="btn"
          href={current.id ? href(current.id) : undefined}
          aria-disabled={current.id ? undefined : true}
          role="link"
        >
          Open the issue
        </a>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
      <div className="keyhint">
        <span><kbd>{modifier}</kbd><kbd>↵</kbd> another</span>
        <span><kbd>esc</kbd> close</span>
      </div>
      {all.length > 1 && (
        <div className="fbfiledlist">
          <div className="lbl">Filed while this was open · {all.length}</div>
          {/* One grid for all rows, so the number column is as wide as its widest entry and every
              title starts at the same place, numbered or not. */}
          <ul>
            {all.map((f) => (
              <li key={f.clientId}>
                {f.id ? (
                  <a href={href(f.id)}>
                    <span className="fbfiledno">{issueLabel(f.id)}</span>
                    <span className="fbfiledtitle">{f.title}</span>
                  </a>
                ) : (
                  <span className="fbfiledpending" data-tip={f.where} title={f.where}>
                    <span className="fbfiledno" aria-label="No number yet">…</span>
                    <span className="fbfiledtitle">{f.title}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
