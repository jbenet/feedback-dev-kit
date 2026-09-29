/**
 * Next calls register() once per server process: start the ingester, so whatever a restart left in
 * the journal is filed without waiting for a request. Not while building, and never awaited: a slow
 * disk must not hold the server's start.
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  void import('./lib/feedback')
    .then((m) => { m.feedback(); })
    .catch((err: unknown) => console.warn('[feedback] the ingester did not start:', err));
}
