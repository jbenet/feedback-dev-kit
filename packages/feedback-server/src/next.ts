/**
 * Next.js App Router adapter. One catch-all route serves every endpoint:
 *
 *   // app/api/feedback/[[...path]]/route.ts   and the same three lines in
 *   // app/api/issues/[[...path]]/route.ts
 *   import { nextRoutes } from '@jbenet/feedback-server/next';
 *   import { feedback } from '@/lib/feedback';        // createFeedbackHandler({...})
 *   export const { GET, POST, PATCH } = nextRoutes(feedback);
 *   export const runtime = 'nodejs';                    // the journal needs node:fs
 *   export const dynamic = 'force-dynamic';
 *
 * (The issue reads are also served under /api/feedback/issues…, so the first file alone is enough
 * when the client is pointed there.)
 *
 * Start the ingester from instrumentation.ts (see README): Next calls register() once per server
 * process, so reports a restart left in the journal are filed without waiting for a request.
 */
import type { FeedbackHandler } from './handlers.ts';

export function nextRoutes(handler: Pick<FeedbackHandler, 'handle'>) {
  const route = (req: Request) => handler.handle(req);
  return { GET: route, POST: route, PATCH: route };
}
