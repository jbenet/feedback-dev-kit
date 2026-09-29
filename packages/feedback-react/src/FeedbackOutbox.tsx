'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  discardEntry, retryNow, serverSnapshot, snapshot, startOutbox, subscribe, type OutboxState,
} from './outbox';
import { entryPictures, entryText, entryTitle, type JournalEntry } from './journal';
import { themeStyle, useFeedbackConfig } from './config';
import { savedAt } from './time';

export const useOutbox = (): OutboxState => useSyncExternalStore(subscribe, snapshot, serverSnapshot);

const plural = (n: number) => (n === 1 ? '1 report' : `${n} reports`);

const inSeconds = (ms: number) => {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return sec < 90 ? `${sec} s` : `${Math.round(sec / 60)} min`;
};

/**
 * Clipboard access needs a secure context, and an app on a local network is often reached over
 * plain http, so the old selection-and-copy path is the fallback.
 */
async function copy(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch { return false; }
}

export type OutboxTone = 'device' | 'send' | 'server' | 'done' | 'refused';

/**
 * Where filed feedback stands, in words: `label` in full, `short` for a narrow line, and a tone.
 * Null when there is nothing to say. "Only on this device" outranks everything, because it is the
 * one state that is not yet safe.
 */
export function outboxSummary(out: OutboxState): { label: string; short: string; tone: OutboxTone } | null {
  const device = out.entries.filter((e) => !(out.justSaved === e.clientId && out.sending.includes(e.clientId)));
  const saving = out.entries.length - device.length;
  const server = out.onServer.length;
  const latest = out.filed.at(-1);
  if (!out.entries.length && !server && !latest) return null;

  let label: string;
  let short: string;
  let tone: OutboxTone;
  if (device.length) {
    const refused = device.filter((e) => e.refused).length;
    label = `${plural(device.length)} only on this device${refused ? ` · ${refused} refused` : ''}${server ? ` · ${server} on the server` : ''}`;
    short = `${device.length} on this device`;
    tone = refused ? 'refused' : 'device';
  } else if (saving) {
    label = 'Saving…'; short = 'Saving…'; tone = 'send';
  } else if (server) {
    label = server === 1 ? 'Saved on server · filing…' : `${server} saved on server · filing…`;
    short = 'On the server';
    tone = 'server';
  } else if (latest!.error) {
    label = `Not filed: ${latest!.error}`; short = 'Not filed'; tone = 'refused';
  } else {
    label = latest!.id ? `Filed as issue ${latest!.id}` : 'Saved';
    short = latest!.id ? `Filed ${latest!.id}` : 'Saved';
    tone = 'done';
  }
  return { label, short, tone };
}

const MARK: Record<OutboxTone, string> = { device: '!', refused: '×', send: '↑', server: '✓', done: '✓' };

/**
 * A quiet status line for filed feedback, so the reporter knows when it is safe to close the tab.
 * Draws nothing when there is nothing to say; a click opens the list. `tone` is also a word, never
 * only a colour.
 */
export function FeedbackStatus({ variant = 'rail' }: { variant?: 'rail' | 'bar' }) {
  const out = useOutbox();
  const config = useFeedbackConfig();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { startOutbox(); }, []);
  const summary = outboxSummary(out);
  if (!summary && !open) return null;
  return (
    <span className="fbk fbk-launch" style={themeStyle(config.theme)}>
      {summary && (
        <button
          ref={button}
          type="button"
          className={`obchip ob-${summary.tone}${variant === 'bar' ? ' ob-bar' : ''}`}
          aria-live="polite"
          onClick={() => {
            const r = button.current?.getBoundingClientRect();
            setAnchor(r ? { left: Math.max(8, r.left), bottom: Math.max(8, window.innerHeight - r.top + 6) } : null);
            setOpen(true);
          }}
          title="Where your feedback stands"
        >
          <span className="obmark" aria-hidden>{MARK[summary.tone]}</span>
          <span className="obtext">{variant === 'bar' ? summary.short : summary.label}</span>
        </button>
      )}
      {open && <OutboxList anchor={anchor} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** Each report's state, with Retry now, Copy text and Discard for the ones only on this device. */
export function OutboxList({ anchor, onClose }: { anchor: { left: number; bottom: number } | null; onClose: () => void }) {
  const out = useOutbox();
  const config = useFeedbackConfig();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const status = (e: JournalEntry) => {
    if (out.sending.includes(e.clientId)) return 'Sending now…';
    if (e.refused) return `The server refused it: ${e.lastError ?? 'no reason given'}. It will not retry on its own.`;
    if (!e.attempts) return 'Waiting for its first send.';
    const tries = `${e.attempts} ${e.attempts === 1 ? 'try' : 'tries'}`;
    return `${e.lastError ?? 'Not confirmed'} · ${tries} · next in ${inSeconds(e.nextAt - now)}`;
  };

  return createPortal(
    <div className="fbk nocapture" style={themeStyle(config.theme)}>
      <div className="obscrim" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        className="obpanel"
        role="dialog"
        aria-label="Feedback waiting to file"
        tabIndex={-1}
        style={anchor ? ({ '--at-left': `${anchor.left}px`, '--at-bottom': `${anchor.bottom}px` } as CSSProperties) : undefined}
      >
        <div className="obhead">
          <div className="lbl">Feedback{out.entries.length ? ` · ${out.entries.length} only on this device` : ''}</div>
          <button type="button" className="obx" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="oblede">
          {out.entries.length
            ? 'The server could not be reached, so these are kept in this browser, through reloads, and sent as soon as it answers. Keep this browser until they say saved. Sending one twice files it once.'
            : 'Saved on the server as soon as you file; it is filed from there, so the tab can be closed.'}
        </p>
        {out.onServer.map((n) => (
          <div key={n.clientId} className="obrow obonserver">
            <b>Saved on the server</b>
            <span>{n.title}</span>
            <span className="obstate">Filing… Safe to close this tab.</span>
          </div>
        ))}
        {out.filed.map((f) => (
          f.error ? (
            <div key={f.clientId} className="obrow">
              <b>Not filed</b>
              <span>{f.title}</span>
              <span className="obbad">{f.error}</span>
            </div>
          ) : f.id ? (
            <a key={f.clientId} className="obrow obfiled" href={config.issueHref(f.id)}>
              <b>Filed as issue <span className="mono">{f.id}</span></b>
              <span>{f.title || 'Untitled'}</span>
            </a>
          ) : (
            <div key={f.clientId} className="obrow obfiled">
              <b>Saved</b>
              <span>{f.title}</span>
            </div>
          )
        ))}
        {out.entries.map((e) => (
          <div key={e.clientId} className="obrow">
            <b>{entryTitle(e)}</b>
            <span className="obmeta">
              Written {savedAt(e.createdAt)} · <span className="mono">{e.request.page}</span>
              {entryPictures(e) > 0 ? ` · ${entryPictures(e)} ${entryPictures(e) === 1 ? 'picture' : 'pictures'}` : ''}
            </span>
            <span className={e.refused ? 'obbad' : 'obstate'}>Only on this device · {status(e)}</span>
            {e.textOnly && (
              <span className="obbad">Kept without its pictures: this browser&rsquo;s database was unavailable.</span>
            )}
            <div className="obacts">
              <button type="button" className="btn" disabled={out.sending.includes(e.clientId)} onClick={() => void retryNow(e.clientId)}>
                Retry now
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void copy(entryText(e)).then((ok) => setCopied(ok ? e.clientId : `fail:${e.clientId}`))}
              >
                {copied === e.clientId ? 'Copied' : copied === `fail:${e.clientId}` ? 'Copy failed' : 'Copy text'}
              </button>
              <button
                type="button"
                className="btn obdiscard"
                onClick={() => {
                  if (window.confirm('Discard this report? It has not been filed, and it cannot be brought back.')) void discardEntry(e.clientId);
                }}
              >
                Discard
              </button>
            </div>
          </div>
        ))}
        {!out.entries.length && !out.onServer.length && !out.filed.length && <p className="oblede">Nothing waiting. Everything has been filed.</p>}
      </div>
    </div>,
    document.body,
  );
}
