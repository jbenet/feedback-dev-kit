import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, safeAttachmentUrl, safeLinkHref } from '../src/safe-urls.ts';

const config = {
  trustedImageOrigins: ['https://cdn.example.test'],
  endpoints: { attachment: (p: string) => `/api/issues/${p}` },
};

test('links in issue text: web, mail, same-site and anchors only', () => {
  for (const ok of ['https://example.test/a', 'http://example.test', 'mailto:a@example.test', '/issues/0001', '#top']) {
    assert.equal(safeLinkHref(ok), ok, ok);
  }
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>',
    '//evil.test/login', 'vbscript:x', 'file:///etc/passwd', 'issues/0001']) {
    assert.equal(safeLinkHref(bad), null, bad);
  }
});

test('pictures in an issue: the store\'s own attachments, or a trusted origin; nothing else is loaded', () => {
  assert.equal(safeAttachmentUrl(config, 'attachments/0007-screenshot.png'), '/api/issues/attachments/0007-screenshot.png');
  assert.equal(safeAttachmentUrl(config, 'attachments/5f2c-uuid/report-image-1.png'), '/api/issues/attachments/5f2c-uuid/report-image-1.png');
  assert.equal(safeAttachmentUrl(config, 'https://cdn.example.test/x.png'), 'https://cdn.example.test/x.png');
  for (const bad of ['https://tracker.test/p.png', '//tracker.test/p.png', 'http://cdn.example.test/x.png', '/api/feedback/export',
    'attachments/../../export', 'attachments/..', 'attachments/', 'data:image/svg+xml,<svg/>', 'javascript:x', '../attachments/x.png',
    'attachments/a b.png', 'attachments/%2e%2e/x.png']) {
    assert.equal(safeAttachmentUrl(config, bad), null, bad);
  }
});

test('the reporter\'s address loses its fragment and secret-looking query values', () => {
  assert.equal(cleanUrl('https://app.test/cb?code=abc&state=1#access_token=xyz'), 'https://app.test/cb?code=%5Bremoved%5D&state=1');
  assert.equal(cleanUrl('https://u:p@app.test/r?api_key=k&region=harbor'), 'https://app.test/r?api_key=%5Bremoved%5D&region=harbor');
  assert.equal(cleanUrl('https://app.test/orders?state=late'), 'https://app.test/orders?state=late');
});
