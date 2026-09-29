'use client';

import { useEffect, useRef, useState } from 'react';
import { isShortcutsKey, SHORTCUT_GROUPS, shortcutKeys, type ShortcutGroupId } from './keyboard';
import { themeStyle, useFeedbackConfig } from './config';

export function useShortcutPlatform() {
  const [apple, setApple] = useState(false);
  useEffect(() => setApple(/Mac|iPad|iPhone|iPod/i.test(navigator.platform)), []);
  return { apple, modifier: apple ? '⌘' : 'Ctrl', alt: apple ? 'Option' : 'Alt' };
}

/** Shared by the feedback box's keys panel and the app-wide list, so the two cannot drift. */
export function ShortcutList({ group }: { group: ShortcutGroupId }) {
  const { modifier, alt } = useShortcutPlatform();
  const { shortcut } = useFeedbackConfig();
  const section = SHORTCUT_GROUPS.find((item) => item.id === group)!;
  const name = (key: string) => (key === 'Mod' ? modifier : key === 'Alt' ? alt : key);
  return (
    <dl className="shortcut-list">
      {section.shortcuts.map((s) => (
        <div key={s.description}>
          <dt>{s.keys.map((keys, i) => {
            const drawn = keys.length === 1 && keys[0] === 'FEEDBACK' ? shortcutKeys(shortcut) : [...keys];
            return (
              <span key={drawn.join('+')}>
                {i > 0 && <span className="muted"> / </span>}
                {drawn.map((key) => <kbd key={key}>{name(key)}</kbd>)}
              </span>
            );
          })}</dt>
          <dd>{s.description}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The app-wide list of keys, opened with `?` outside text fields. Optional: mount it once in the
 * layout if the app has no shortcuts dialog of its own.
 */
export function KeyboardShortcuts() {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const { theme } = useFeedbackConfig();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modal = dialog.current;
      if (!modal || event.defaultPrevented || event.repeat) return;
      if (modal.open) {
        if (event.key === 'Escape' || isShortcutsKey(event)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          modal.close();
        }
        return;
      }
      if (!isShortcutsKey(event)) return;
      // Existing dialogs own their keys, especially the feedback box and its keys panel.
      // Check presence, not focus: the drawer can be open while focus stays on its launcher.
      if (document.querySelector('dialog[open], [role="dialog"]:not(.shortcuts-dialog)')) return;
      event.preventDefault();
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      modal.showModal();
      closeButton.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <dialog
      ref={dialog}
      className="fbk shortcuts-dialog nocapture"
      style={themeStyle(theme)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="fbk-shortcuts-title"
      onClose={() => {
        if (returnFocus.current?.isConnected) returnFocus.current.focus();
        returnFocus.current = null;
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) {
          event.currentTarget.close();
        }
      }}
    >
      <header className="shortcuts-head">
        <h2 id="fbk-shortcuts-title">Keyboard shortcuts</h2>
        <button ref={closeButton} type="button" className="btn" onClick={() => dialog.current?.close()}>Close</button>
      </header>
      <p className="shortcuts-note">Shortcuts apply where you are working. Text fields keep what you type; open dialogs handle their own keys.</p>
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.id} aria-labelledby={`fbk-shortcuts-${group.id}`}>
          <h3 className="lbl" id={`fbk-shortcuts-${group.id}`}>{group.title}</h3>
          <ShortcutList group={group.id} />
        </section>
      ))}
    </dialog>
  );
}
