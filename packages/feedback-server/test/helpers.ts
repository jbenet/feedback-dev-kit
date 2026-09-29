/** Test fixtures. Invented data only. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A 1×1 PNG. */
export const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const PNG = `data:image/png;base64,${PNG_B64}`;
export const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

export async function tempDir(t: { after(fn: () => unknown): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-kit-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export const id = () => randomUUID();

/** A report as the browser sends it, about an invented app. */
export function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: id(),
    body: 'The totals row on the invented orders page counts returns twice.',
    kind: 'bug',
    priority: 'P2',
    page: '/orders',
    context: {
      route: '/orders', url: 'http://app.test/orders?state=late', filters: { state: 'late' },
      client: { userAgent: 'test', viewport: '1440×900', pixelRatio: 2, touch: false },
    },
    screenshots: [],
    images: [],
    imageOffset: 0,
    ...overrides,
  };
}

export function post(body: unknown, init: { origin?: string | null; headers?: Record<string, string>; url?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', host: 'app.test', ...init.headers };
  if (init.origin !== null) headers.origin = init.origin ?? 'http://app.test';
  return new Request(init.url ?? 'http://app.test/api/feedback', {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://app.test${path}`, { headers: { host: 'app.test', ...headers } });

export const silent = { warn: () => undefined, info: () => undefined };
