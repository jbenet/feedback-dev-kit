/**
 * Plain Node adapter: `http.createServer(toNodeListener(handler))`, or mount it in Express/Connect
 * with a fallback for paths it does not own.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { FeedbackHandler } from './handlers.ts';

export interface NodeListenerOptions {
  /** Called for requests outside the handler's basePath (Express's next()). Default: 404. */
  fallback?: (req: IncomingMessage, res: ServerResponse) => void;
  /** 'https' when TLS terminates in front of this process and you trust that proxy. Default: 'http' (or 'https' on a TLS socket). */
  protocol?: 'http' | 'https';
}

/** An IncomingMessage as a fetch Request. The body streams; the handler enforces its own size limit. */
export function toRequest(req: IncomingMessage, protocol?: 'http' | 'https'): Request {
  const proto = protocol ?? ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const url = `${proto}://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit);
}

export async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) { res.end(); return; }
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function toNodeListener(handler: FeedbackHandler, options: NodeListenerOptions = {}) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (!handler.owns(path)) {
      if (options.fallback) return options.fallback(req, res);
      res.statusCode = 404;
      res.end();
      return;
    }
    void handler.handle(toRequest(req, options.protocol))
      .then((response) => sendResponse(res, response))
      .catch(() => { if (!res.headersSent) res.statusCode = 500; res.end(); });
  };
}
