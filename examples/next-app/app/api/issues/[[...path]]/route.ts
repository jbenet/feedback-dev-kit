/**
 * The issues pages' reads, served by the same handler as /api/feedback:
 *   GET   /api/issues                    { issues, destination, store }
 *   GET   /api/issues/:id                { issue }
 *   PATCH /api/issues/:id                { status?, priority?, kind?, labels? } → { issue }
 *   GET   /api/issues/attachments/<path> image bytes
 * All of them go through the handler's `authorize` (lib/feedback.ts): signed-in demo users only.
 */
import { nextRoutes } from '@jbenet/feedback-server/next';
import { feedback } from '@/lib/feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, PATCH } = nextRoutes({ handle: (req) => feedback().handler.handle(req) });
