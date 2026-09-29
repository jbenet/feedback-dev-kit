/**
 * The page's height from the window itself. On Safari on an iPad, 100dvh came out taller than
 * the page as drawn — a button pinned to the bottom sat under the bottom edge — while
 * `innerHeight` is the height the page is drawn at. Put this inline in <head> so it runs before
 * first paint; the stylesheet reads `--app-h` and falls back to 100dvh without it. Not while
 * zoomed in: a pinch shrinks innerHeight, and the drawer would shrink with it.
 */
export const VIEWPORT_BOOT = `(function(){var d=document.documentElement;function s(){var v=window.visualViewport;if(v&&v.scale>1.01)return;d.style.setProperty('--app-h',window.innerHeight+'px')}s();window.addEventListener('resize',s);window.addEventListener('orientationchange',s);window.addEventListener('pageshow',s)})();`;

/**
 * The two narrow layouts. Widths, never the user agent: an iPad in split view is as narrow as a
 * phone and says it is a Mac. styles.css repeats these numbers in its media queries.
 *
 * Up to PHONE_MAX the feedback box takes the whole width. Up to PANE_MAX it opens over the page
 * from the right at its usual width. Both numbers are judgement: 760 is below every iPad's
 * portrait width, and 1023 keeps an iPad in landscape on the desktop layout.
 */
export const PHONE_MAX = 760;
export const PANE_MAX = 1023;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;
export const PANE_QUERY = `(max-width: ${PANE_MAX}px)`;

/**
 * Where Tab goes inside an open sheet: forward from the last control to the first, back from the
 * first to the last, and to the first (or last, going back) when focus is outside the sheet
 * (index -1). Null when the sheet has nothing to focus, and the sheet itself should hold focus.
 */
export function nextFocusIndex(count: number, index: number, back: boolean): number | null {
  if (count <= 0) return null;
  if (index < 0 || index >= count) return back ? count - 1 : 0;
  return back ? (index - 1 + count) % count : (index + 1) % count;
}
