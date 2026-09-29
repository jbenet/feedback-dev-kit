import { join } from 'node:path';
import type { NextConfig } from 'next';

const repo = join(__dirname, '..', '..');

const config: NextConfig = {
  // Both packages are npm workspaces linked from ../../packages (built to dist/ by `npm run build`),
  // so the project root is the repository's.
  turbopack: { root: repo },
  outputFileTracingRoot: repo,
  // The server package is plain Node ESM (node:fs, dynamic imports of optional peers): load it
  // from node_modules at run time rather than bundling it, and never bundle its optional peers.
  serverExternalPackages: ['@jbenet/feedback-server', '@anthropic-ai/sdk', 'better-sqlite3', 'pg'],
  devIndicators: false,
};

export default config;
