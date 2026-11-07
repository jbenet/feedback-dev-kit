# feedback-kit example (Vite, no framework)

The kit without Next.js: a React 19 app built by Vite, with no router library, and the server package
on plain `node:http`. One process serves both: `server.ts` puts the kit's handler in front, and every
path it does not own falls through to Vite's dev middleware (or, in production, to the built files in
`dist/`). The packages are npm workspaces, so the example uses each one's built `dist/`.

```sh
npm install                                   # at the repo root (npm workspaces)
npm run dev:vite                              # builds both packages, then http://localhost:3173
# or a production build:
npm run build -w examples/vite-app
FEEDBACK_DATA=$(mktemp -d) PORT=3173 npm run start -w examples/vite-app
```

Press Alt+F (Option+F on a Mac), describe something and file it. Reports are journaled under
`FEEDBACK_DATA` (default `.data/`, git-ignored) and filed as markdown in `FEEDBACK_DATA/issues`; the
**Issues** link shows them. Titles are the report's first sentence (`generateTitle: null`).

| File | What it shows |
|---|---|
| `server.ts` | `createFeedbackHandler`, `fileStore` and `startIngester`, mounted with `toNodeListener` and a `fallback` for the app. |
| `src/main.tsx` | The stylesheet, self-hosted fonts and `VIEWPORT_BOOT` in a client-only app. |
| `src/App.tsx` | `FeedbackProvider` fed from a twenty-line history router, the button, the status line, the shortcuts dialog and the issues pages with a client-side `Link`. |

This example has no sign-in, so `authorize` lets anyone read and update issues and every report is
filed by "unknown". That is fine on localhost and nowhere else: in your app, resolve the reporter and
authorize the issue reads from your session, as `examples/next-app/lib/feedback.ts` does. Everything
else (GitHub Issues, SQL stores, MCP, the worker token) is configured on the handler exactly as in the
Next.js example and the [server README](../../packages/feedback-server/README.md).
