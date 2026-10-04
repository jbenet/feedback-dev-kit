/**
 * Discovery for feedback over MCP (docs/MCP.md §3): where this app takes feedback from other apps.
 * Public and secret-free; the endpoint itself wants a token.
 */
import { FEEDBACK_MCP_VERSION } from '@jbenet/feedback-server/mcp';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const origin = process.env.FEEDBACK_APP_URL ?? new URL(req.url).origin;
  return Response.json({
    convention: 'feedback-kit/mcp',
    version: FEEDBACK_MCP_VERSION,
    mcp: `${origin.replace(/\/$/, '')}/api/feedback/mcp`,
    auth: 'bearer',
    contact: 'Ask the maintainers of this app for a token.',
  });
}
