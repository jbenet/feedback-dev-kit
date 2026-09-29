/**
 * Mutations come from this server's own pages. The Origin must equal the scheme, host and port the
 * browser asked for (the Host header — not X-Forwarded-Host, which anyone can send — and not the
 * address the server is bound to, which a framework may put in req.url). Sibling origins are not
 * trusted unless listed. A request without an Origin is refused: browsers send one on every POST.
 */
export interface OriginPolicy {
  /** More origins to accept, exactly, e.g. `https://app.example.com` when a TLS proxy talks http to you. */
  allowed?: string[];
  /** Accept requests with no Origin header (non-browser clients). Default false. */
  allowMissing?: boolean;
}

/** null when the request may proceed; otherwise the reason it may not. */
export function checkOrigin(req: Request, policy: OriginPolicy = {}): string | null {
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (!origin) return policy.allowMissing ? null : 'Use this server\'s own page to send feedback.';
  const url = new URL(req.url);
  const own = `${url.protocol}//${req.headers.get('host') || url.host}`;
  if (origin === own && (site === null || site === 'same-origin')) return null;
  if (policy.allowed?.includes(origin)) return null;
  return 'Use this server\'s own page to send feedback.';
}
