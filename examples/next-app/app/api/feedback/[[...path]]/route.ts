/**
 * Every feedback endpoint, from one catch-all route:
 *   POST /api/feedback                 journal a report, answer 202
 *   GET  /api/feedback?clientId=       where a journaled report stands
 *   GET  /api/feedback/issues[/:id]    the issues pages' reads; PATCH /issues/:id changes status
 *   GET  /api/feedback/attachments/…   a picture filed with an issue
 *   GET  /api/feedback/export?since=   (Bearer FEEDBACK_EXPORT_TOKEN)
 */
import { feedback } from '@/lib/feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handle = (req: Request) => feedback().handler.handle(req);
export { handle as GET, handle as POST, handle as PATCH };
