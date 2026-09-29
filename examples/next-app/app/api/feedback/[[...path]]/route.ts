/**
 * Every feedback endpoint, from one catch-all route:
 *   POST /api/feedback                 journal a report, answer 202
 *   GET  /api/feedback?clientId=       where a journaled report stands
 *   GET  /api/feedback/issues[/:id]    the issues pages' reads; PATCH /issues/:id changes status
 *   GET  /api/feedback/attachments/…   a picture filed with an issue
 *   GET  /api/feedback/export?since=   (Bearer FEEDBACK_EXPORT_TOKEN)
 */
import { nextRoutes } from '@jbenet/feedback-server/next';
import { feedback } from '@/lib/feedback';

export const runtime = 'nodejs';       // the journal needs node:fs
export const dynamic = 'force-dynamic';

// The handler is made on the first request, not when Next imports this file while building.
export const { GET, POST, PATCH } = nextRoutes({ handle: (req) => feedback().handler.handle(req) });
