/**
 * The issues pages' reads, served by the same handler as /api/feedback (docs/REBUILD.md §2.4):
 *   GET   /api/issues                    { issues }
 *   GET   /api/issues/:id                { issue }
 *   PATCH /api/issues/:id                { status?, priority?, labels? } → { issue }
 *   GET   /api/issues/attachments/<path> image bytes
 * Put these behind your own auth in a real app (the handler's `authorize` option).
 */
import { feedback } from '@/lib/feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handle = (req: Request) => feedback().handler.handle(req);
export { handle as GET, handle as PATCH };
