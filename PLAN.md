# feedback-kit — build plan (shared by the agents building it)

Extracted from PL LabOS tools, 29 Sep 2026; PL LabOS tools' source was the source of truth for behaviour.
Never copy its data: screenshots, examples and tests use invented data only.

## Layout
```
README.md                     what it is, quick start, feature tour (short), links
docs/FEATURES.md              every feature, with screenshots (docs/screenshots/*.webp|png)
docs/REBUILD.md               the agent-facing spec to rebuild it from scratch in any app
docs/SERVER.md                server side: API, journal-to-files (fire and forget), ingest to DB; GitHub variant
docs/TRIAGE.md                how dev agents prioritize feedback in the background; roles → outcomes
docs/PACKAGES.md              dependencies to install and why
packages/feedback-react/      client: button+shortcut, sidebar, capture, region picker, markdown field,
                              drafts, outbox, submit flow, issues page (list/filters/search/detail), CSS
packages/feedback-server/     server: handlers (framework-agnostic + Next adapters), journal, ingester,
                              storage adapters (files+SQLite/Postgres, files+GitHub), AI title hook, export
examples/next-app/            a small Next.js app wiring both packages; e2e tests (Playwright)
```

## Wire contract (keep the current PL LabOS tools format, minus title)
- The client never asks for a title. The server (or a background agent) generates one with an LLM from the
  body, page and screenshots; fallback: first line of the body, trimmed to 80 chars.
- POST {base}/api/feedback — the current app/api/feedback/route.ts request shape (body markdown, page,
  context {route, url, filters, client{userAgent, viewport, pixelRatio, touch}}, attachments, client_id
  idempotency key, kind/priority optional). Responds as soon as the entry is journaled to disk (fire and
  forget); ingestion to the DB/GitHub happens asynchronously and retries.
- GET {base}/api/feedback/export?since= (token-protected) and the issues list/detail reads.
- Reporter identity is resolved server-side from the session, never trusted from the client body.

## Rules for the builders
- Framework: React + TypeScript; server handlers work in Next.js route handlers and plain Node (adapter).
- Keep the PL LabOS tools look as the default theme, via CSS variables so apps can re-skin.
- No PL LabOS tools imports; everything the package needs lives in the package or is a documented peer dep.
- Invented data only. Commit to this repo (main); never push.
