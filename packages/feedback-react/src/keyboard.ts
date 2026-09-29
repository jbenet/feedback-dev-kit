import { DEFAULT_SHORTCUT, type FeedbackShortcut } from './config';

/** The bindings the kit owns, grouped by the surface that owns them. Mod is ⌘ on Apple devices. */
export const SHORTCUT_GROUPS = [
  { id: 'anywhere', title: 'Anywhere', shortcuts: [
    { keys: [['?']], description: 'Open or close keyboard shortcuts, outside text fields' },
    { keys: [['Esc']], description: 'Close keyboard shortcuts' },
    { keys: [['FEEDBACK']], description: 'Open feedback, outside text fields and dialogs' },
  ] },
  { id: 'feedback', title: 'Feedback box', shortcuts: [
    { keys: [['?']], description: 'Open or close this box’s keys panel, outside text fields' },
    { keys: [['Mod', 'Enter']], description: 'File the report' },
    { keys: [['Esc']], description: 'Close the keys panel first, then the box' },
    { keys: [['Tab'], ['Shift', 'Tab']], description: 'Move to the next or previous field' },
  ] },
  { id: 'screenshot', title: 'Screenshot editor', shortcuts: [
    { keys: [['Mod', 'Z']], description: 'Undo an annotation, outside text fields' },
    { keys: [['Mod', 'Shift', 'Z'], ['Mod', 'Y']], description: 'Redo an annotation, outside text fields' },
    { keys: [['Mod', 'Enter']], description: 'Keep the label text and leave its field' },
    { keys: [['Enter']], description: 'Apply the text size while editing its number' },
    { keys: [['Esc']], description: 'Leave a field keeping its text, deselect a label, then close the editor' },
    { keys: [['Enter']], description: 'Use the region drawn, when choosing a part of the page' },
    { keys: [['Esc']], description: 'Cancel choosing a screenshot region' },
  ] },
] as const;

export type ShortcutGroupId = (typeof SHORTCUT_GROUPS)[number]['id'];

export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  );
}

export function isShortcutsKey(event: KeyboardEvent): boolean {
  return event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey
    && !event.isComposing && !isTypingTarget(event.target);
}

const isApple = () => typeof navigator !== 'undefined' && /Mac|iPad|iPhone|iPod/i.test(navigator.platform);

/**
 * The feedback shortcut, by physical key: Alt+F also matches Option+F on macOS, where event.key
 * is ƒ. Never while typing in a field, never on a repeat, never when something else took the key.
 */
export function isFeedbackKey(event: KeyboardEvent, shortcut: FeedbackShortcut = DEFAULT_SHORTCUT): boolean {
  const mod = isApple() ? event.metaKey : event.ctrlKey;
  const otherMod = isApple() ? event.ctrlKey : event.metaKey;
  return event.code === shortcut.code
    && event.altKey === Boolean(shortcut.alt)
    && event.shiftKey === Boolean(shortcut.shift)
    && mod === Boolean(shortcut.mod) && !otherMod
    && !event.isComposing && !event.repeat && !event.defaultPrevented
    && !isTypingTarget(event.target);
}

/** The shortcut's keys as they are drawn: ['Alt', 'F'], with Mod and Alt named per platform later. */
export function shortcutKeys(shortcut: FeedbackShortcut = DEFAULT_SHORTCUT): string[] {
  const key = shortcut.code.replace(/^Key|^Digit/, '');
  return [shortcut.mod ? 'Mod' : null, shortcut.alt ? 'Alt' : null, shortcut.shift ? 'Shift' : null, key]
    .filter((k): k is string => k !== null);
}

/** "Alt+F", "Option+F", "⌘+Shift+K". */
export function shortcutLabel(shortcut: FeedbackShortcut = DEFAULT_SHORTCUT, apple = isApple()): string {
  return shortcutKeys(shortcut).map((k) => (k === 'Mod' ? (apple ? '⌘' : 'Ctrl') : k === 'Alt' ? (apple ? 'Option' : 'Alt') : k)).join('+');
}

/** For `aria-keyshortcuts`: "Alt+F", "Meta+Shift+K". */
export function ariaShortcut(shortcut: FeedbackShortcut = DEFAULT_SHORTCUT, apple = isApple()): string {
  return shortcutKeys(shortcut).map((k) => (k === 'Mod' ? (apple ? 'Meta' : 'Control') : k)).join('+');
}
