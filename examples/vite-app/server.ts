/**
 * The server side of the Vite example: @jbenet/feedback-server on plain node:http, no framework.
 *
 * The kit's handler takes a fetch Request and returns a Response, so any server that can hand it one
 * works (Express, Fastify, Hono, Bun, Deno …). Here `toNodeListener` adapts it to node:http, and every
 * path the kit does not own falls through to Vite (in development) or to the built files in dist/.
 *
 *   npm run dev      Vite dev server with hot reload, on PORT (default 3173)
 *   npm run build && npm run start
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { createFeedbackHandler, fileStore, startIngester } from '@jbenet/feedback-server';
import { toNodeListener } from '@jbenet/feedback-server/node';

const port = Number(process.env.PORT ?? 3173);
const root = resolve(process.env.FEEDBACK_DATA ?? '.data');
const journal = join(root, 'inbox');
const store = fileStore({ dir: join(root, 'issues'), destination: 'Markdown files in .data/issues' });

// Files the journal's reports in this process. No model is called: a title is the report's first sentence.
startIngester({ journal, store, generateTitle: null, everyMs: 5_000 });

const feedback = createFeedbackHandler({
  journal,
  store,
  // Who is filing, from your session; never from the request body. This example has no sign-in.
  resolveReporter: () => null,
  // Who may read issues, see their pictures and change their status. Your app checks its session
  // here. Left open so the demo's issues pages work, which is fine on localhost and nowhere else.
  authorize: () => true,
});

let app: (req: IncomingMessage, res: ServerResponse) => void;
if (process.env.NODE_ENV === 'production') {
  app = serveStatic(resolve('dist'));
} else {
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({ server: { middlewareMode: true }, appType: 'spa' });
  app = vite.middlewares;
}

createServer(toNodeListener(feedback, { fallback: app })).listen(port, () => {
  console.log(`http://localhost:${port}  (press Alt+F, or Option+F on a Mac)`);
});

/** The built app: files from dist/, and index.html for every other path (client-side routes). */
function serveStatic(dir: string) {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png',
  };
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    let file = resolve(dir, '.' + path);
    if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) file = join(dir, 'index.html');
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  };
}
