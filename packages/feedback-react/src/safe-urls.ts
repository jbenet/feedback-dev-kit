/**
 * URLs from untrusted places, made safe: what an issue (written by a reporter) may link to or load,
 * and what the reporter's own address may carry into a report.
 */

/**
 * The URL for a picture named in an issue, or null when it must not be loaded. Issue text and its
 * attachment list come from reporters (people, or other apps over MCP): only the store's own
 * `attachments/…` files, with no `..`, or an image from a trusted origin, are shown. Anything else — a
 * remote tracker, a same-origin API path, `attachments/../../x` — is not.
 */
export function safeAttachmentUrl(c: { trustedImageOrigins: string[]; endpoints: { attachment: (path: string) => string } }, path: string): string | null {
  const p = path.trim();
  if (/^https:\/\//i.test(p)) {
    try { return c.trustedImageOrigins.includes(new URL(p).origin) ? p : null; } catch { return null; }
  }
  const segments = p.split('/');
  if (segments[0] !== 'attachments' || segments.length < 2) return null;
  if (!segments.slice(1).every((s) => /^[\w.-]+$/.test(s) && s !== '.' && s !== '..')) return null;
  return c.endpoints.attachment(p);
}

/** Links an issue's text may carry: the web, mail, this app's own pages, anchors. Others are shown as text. */
export function safeLinkHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(h) ? h : null;
}

/** Query keys that carry credentials rather than page state (the server scrubs them too). */
export const SECRET_KEY = /^(?:.*[_-])?(?:token|access_token|id_token|key|api_key|apikey|code|password|passwd|secret|signature|sig|session|auth)$/i;

/** The address without a fragment (where OAuth puts tokens) and with secret-looking query values removed. */
export function cleanUrl(href: string): string {
  try {
    const u = new URL(href);
    u.hash = '';
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) if (SECRET_KEY.test(k)) u.searchParams.set(k, '[removed]');
    return u.toString();
  } catch { return href; }
}

