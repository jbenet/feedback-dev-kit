/**
 * The issues pages' reads, at the paths the client uses by default (docs/REBUILD.md §2.4):
 *   GET   /api/issues                    { issues } (the handler's { items } is read too)
 *   GET   /api/issues/:id                { issue }
 *   PATCH /api/issues/:id                { status?, priority?, labels? } → { issue }
 *   GET   /api/issues/attachments/<path> image bytes
 *
 * TODO: when @jbenet/feedback-server serves /api/issues itself, point this route at its handler
 * directly. Until then the request is re-addressed to the handler's own paths under /api/feedback.
 */
import { feedback } from '@/lib/feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rest = url.pathname.replace(/^\/api\/issues\/?/, '');
  url.pathname = rest.startsWith('attachments/') ? `/api/feedback/${rest}` : `/api/feedback/issues${rest ? `/${rest}` : ''}`;
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers: req.headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') { init.body = req.body; init.duplex = 'half'; }
  const res = await feedback().handler.handle(new Request(url, init));
  if (req.method !== 'GET' || rest || !res.ok) return res;
  // The list: the handler answers { items }; the client contract says { issues }. Give both.
  const json = await res.json() as { items?: unknown; issues?: unknown };
  return Response.json({ ...json, issues: json.issues ?? json.items }, { headers: { 'cache-control': 'no-store' } });
}

export { handle as GET, handle as PATCH };
