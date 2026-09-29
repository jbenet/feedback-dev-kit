import { join } from 'node:path';
import type { NextConfig } from 'next';

const repo = join(__dirname, '..', '..');

const config: NextConfig = {
  // The client package ships TypeScript source; Next compiles it with the app.
  transpilePackages: ['@jbenet/feedback-react'],
  // The server package is imported from ../../packages (see lib/feedback.ts), outside this folder.
  turbopack: { root: repo },
  outputFileTracingRoot: repo,
  // The ingester's optional model call is loaded only when configured; never bundle it.
  serverExternalPackages: ['@anthropic-ai/sdk', 'better-sqlite3', 'pg'],
  devIndicators: false,
};

export default config;
