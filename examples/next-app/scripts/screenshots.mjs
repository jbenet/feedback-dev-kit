/**
 * The screenshots in docs/screenshots, taken from this example with invented data.
 *
 *   npm run build -w examples/next-app
 *   FEEDBACK_DATA=$(mktemp -d) PORT=3174 npm run start -w examples/next-app &   # a fresh data folder
 *   BASE_URL=http://localhost:3174 node examples/next-app/scripts/screenshots.mjs
 *
 * It files a few invented reports through the API first, so run it against an empty data folder:
 * the issue numbers in the pictures start at 0001. Chromium, 2× pixels.
 */
import { chromium } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://localhost:3172';
const OUT = process.env.SHOTS_DIR ?? fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));
const origin = new URL(BASE).origin;
mkdirSync(OUT, { recursive: true });
const out = (name) => join(OUT, name);
const log = (m) => console.log(`[shots] ${m}`);

/** Invented reports about the example's invented bakery, filed the way the browser files them. */
const SEED = [
  { page: '/', kind: 'bug', priority: 'P1', body: 'Harbor Deli shows as late while its order is still proofing.\n\nThe Late tile says 12 min; the table says Proofing.' },
  { page: '/reports', kind: 'request', priority: 'P3', body: 'Let me sort the weekly table by returns. Rye stands out, but only if you scroll.' },
  { page: '/settings', kind: 'bug', priority: 'P2', body: 'The delivery radius field accepts negative numbers.' },
  { page: '/', kind: 'bug', priority: 'P2', body: 'Rolls for Maple Row School are counted twice in the Loaves tile.' },
  { page: '/', kind: 'question', priority: 'P3', body: 'Could the orders table say which oven each batch is in?' },
  { page: '/reports', kind: 'chore', priority: 'P3', body: 'The region chips on Reports use a different grey from the rest of the app.' },
];

const until = async (what, fn, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

/** A box around several elements, padded, for a cropped screenshot. */
async function around(page, locators, pad = 12) {
  const boxes = (await Promise.all(locators.map((l) => l.boundingBox()))).filter(Boolean);
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const vp = page.viewportSize();
  const r = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const b = Math.min(vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x, y, width: r - x, height: b - y };
}

async function openBox(page) {
  const box = page.getByRole('dialog', { name: 'Give feedback' });
  await until('the feedback box', async () => {
    if (await box.isVisible()) return true;
    await page.keyboard.press('Alt+KeyF');
    await page.waitForTimeout(250);
    return box.isVisible();
  });
  return box;
}
const shotCount = (page, n) => page.locator('.fbshots > .lbl', { hasText: `Screenshots · ${n}` }).waitFor({ timeout: 30_000 });

/** A small invented picture, made in the page and dropped into the description. */
async function dropPicture(page, name) {
  const dt = await page.evaluateHandle(async (fileName) => {
    const c = document.createElement('canvas');
    c.width = 360; c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, 360, 200);
    g.strokeStyle = '#E4E0D6'; g.lineWidth = 2; g.strokeRect(1, 1, 358, 198);
    g.fillStyle = '#5E5A52'; g.font = '600 14px "IBM Plex Mono", monospace'; g.fillText('LATE', 22, 40);
    g.fillStyle = '#1A1917'; g.font = '600 64px Fraunces, Georgia, serif'; g.fillText('1', 22, 118);
    g.fillStyle = '#BF4A16'; g.font = '15px "IBM Plex Sans", sans-serif'; g.fillText('Harbor Deli, 12 min', 22, 160);
    const blob = await new Promise((r) => c.toBlob((b) => r(b), 'image/png'));
    const d = new DataTransfer();
    d.items.add(new File([blob], fileName, { type: 'image/png' }));
    return d;
  }, name);
  await page.locator('.mdrichwrap').dispatchEvent('drop', { dataTransfer: dt });
}

const browser = await chromium.launch();
async function newContext(options = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...options });
  await ctx.addCookies([{ name: 'demo_user', value: 'robin', url: BASE }]);
  return ctx;
}

try {
  const ctx = await newContext();
  const page = await ctx.newPage();

  // ── Seed ──────────────────────────────────────────────────────────────────────────────
  for (const r of SEED) {
    const res = await page.request.post('/api/feedback', {
      headers: { origin },
      data: {
        clientId: randomUUID(), ...r,
        context: { route: r.page, url: `${BASE}${r.page}`, filters: {}, client: { userAgent: 'invented', viewport: '1440×900', pixelRatio: 2, touch: false } },
      },
    });
    if (res.status() !== 202) throw new Error(`seed POST answered ${res.status()}`);
  }
  let seeded = [];
  await until('the seed to be filed', async () => {
    seeded = (await (await page.request.get('/api/issues')).json()).issues;
    return seeded.length >= SEED.length;
  });
  const ids = seeded.map((i) => i.id).sort();
  for (const [i, status] of [[0, 'in-progress'], [1, 'triaged'], [2, 'done'], [5, 'agent-ready']]) {
    await page.request.patch(`/api/issues/${ids[i]}`, { headers: { origin }, data: { status } });
  }
  log(`seeded ${ids.length} issues`);

  // ── The button, and the app's shortcuts list ─────────────────────────────────────────
  await page.goto('/');
  await page.getByRole('heading', { name: 'Orders' }).waitFor();
  await until('the shortcuts list', async () => {
    await page.keyboard.press('Shift+Slash');
    return page.getByRole('dialog', { name: /keyboard shortcuts/i }).isVisible();
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: out('18-shortcuts.png') });
  await page.screenshot({ path: out('01-button.png'), clip: await around(page, [page.locator('.railfoot')], 10) });
  await page.keyboard.press('Escape');

  // ── The panel ─────────────────────────────────────────────────────────────────────────
  let box = await openBox(page);
  await shotCount(page, 1);
  await page.keyboard.type('Harbor Deli shows as late while its order is still proofing.');
  await page.waitForTimeout(400);
  await page.screenshot({ path: out('02-drawer.png') });
  await page.locator('.fbshots').screenshot({ path: out('04-screenshots.png') });
  await page.screenshot({ path: out('22-misaligned.png'), clip: await around(page, [page.locator('.fbshots .shotthumb').first()], 10) });

  // What is captured with it.
  await box.locator('summary', { hasText: 'Captured with it' }).click();
  await box.locator('details.fbcaptured').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await box.locator('details.fbcaptured').screenshot({ path: out('06-context.png') });
  await box.locator('summary', { hasText: 'Captured with it' }).click();

  // The description: markdown typed as markdown, a list, a dropped picture; then its source.
  const editor = page.getByRole('textbox', { name: 'Enter any feedback' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('Harbor Deli shows as **late** while its order is still proofing. ');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- the Late tile says 12 min');
  await page.keyboard.press('Enter');
  await page.keyboard.type('the table says Proofing');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await dropPicture(page, 'late-tile.png');
  await editor.locator('img[alt="late-tile.png"]').waitFor();
  await page.waitForTimeout(400);
  await page.locator('.mdfield').screenshot({ path: out('07-markdown.png') });
  await page.locator('.mdtabs').getByRole('button', { name: 'Markdown' }).click();
  await page.waitForTimeout(300);
  await page.locator('.mdfield').screenshot({ path: out('08-markdown-source.png') });
  await page.locator('.mdtabs').getByRole('button', { name: 'Rich' }).click();

  // Wider.
  await box.getByRole('button', { name: /Wider/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out('03-wide.png') });
  await box.getByRole('button', { name: /Narrower/ }).click();
  await page.waitForTimeout(300);

  // Pick a part, with the mouse, mid-drag.
  await box.getByRole('button', { name: 'Pick a part' }).click();
  const picker = page.getByRole('dialog', { name: 'Drag to choose a part of the page' });
  await picker.waitFor();
  await page.mouse.move(300, 250);
  await page.mouse.down();
  await page.mouse.move(700, 420, { steps: 6 });
  await page.mouse.move(1030, 560, { steps: 6 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: out('09-region-picker.png') });
  await page.mouse.up();
  await shotCount(page, 2);

  // Annotate: a box and an arrow, and a tooltip on the toolbar.
  await box.getByRole('button', { name: 'Annotate screenshot 1' }).click();
  const bar = page.getByRole('toolbar', { name: 'Annotation tools' });
  await bar.waitFor();
  const canvas = page.locator('.setcanvas');
  const c = await canvas.boundingBox();
  const at = (fx, fy) => [c.x + c.width * fx, c.y + c.height * fy];
  const drag = async ([x1, y1], [x2, y2]) => {
    await page.mouse.move(x1, y1); await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 8 }); await page.mouse.up();
  };
  await bar.getByRole('button', { name: 'Box it' }).click();
  await drag(at(0.555, 0.07), at(0.74, 0.2));
  await bar.getByRole('button', { name: 'Point at something' }).click();
  await drag(at(0.45, 0.42), at(0.6, 0.23));
  await bar.getByRole('button', { name: 'Undo' }).hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out('11-annotate.png') });
  const tip = await around(page, [bar], 10);
  await page.screenshot({ path: out('21-toolbar-tooltip.png'), clip: { ...tip, height: tip.height + 34 } });
  await bar.getByRole('button', { name: 'Done' }).click();
  await bar.waitFor({ state: 'hidden' });

  // The panel's own keys card.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await page.keyboard.press('Shift+Slash');
  await page.locator('.keycard').waitFor();
  await page.waitForTimeout(200);
  await page.screenshot({ path: out('05-keys.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await box.waitFor({ state: 'hidden' });

  // ── Drafts ────────────────────────────────────────────────────────────────────────────
  await page.waitForTimeout(500);
  await page.reload();
  box = await openBox(page);
  const restored = box.getByText('Your unsent draft for this page');
  await restored.waitFor();
  await restored.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const drawer = await box.boundingBox();
  const line = await restored.boundingBox();
  const top = Math.max(drawer.y, line.y - 20);
  await page.screenshot({ path: out('12-draft-restored.png'), clip: { x: drawer.x, y: top, width: drawer.width, height: Math.min(360, drawer.y + drawer.height - top) } });
  await page.keyboard.press('Escape');

  await page.goto('/settings');
  box = await openBox(page);
  await box.getByRole('button', { name: /Drafts · 1/ }).click();
  await box.locator('.draftlist').waitFor();
  await page.waitForTimeout(200);
  await page.screenshot({ path: out('13-drafts.png'), clip: await around(page, [box.locator('.draftlist'), box.getByRole('button', { name: /Drafts · 1/ })], 10) });
  await page.keyboard.press('Escape');

  // ── The outbox, with the server unreachable ─────────────────────────────────────────
  const down = async (route) => (route.request().method() === 'POST' ? route.abort('connectionrefused') : route.fallback());
  await page.route('**/api/feedback', down);
  await page.goto('/reports?region=harbor');
  box = await openBox(page);
  await shotCount(page, 1);
  await page.keyboard.type('Week 12 returns for Rye look three times too high in the harbor region.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await box.waitFor({ state: 'hidden' });
  const chip = page.locator('.obchip');
  await chip.filter({ hasText: 'only on this device' }).waitFor();
  await chip.click();
  const list = page.getByRole('dialog', { name: 'Feedback waiting to file' });
  await list.waitFor();
  await page.waitForTimeout(1_200);
  await list.screenshot({ path: out('15-outbox-offline.png') });
  await list.getByRole('button', { name: 'Close' }).click();
  await page.unroute('**/api/feedback', down);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await chip.filter({ hasText: /Filed as issue \d+/ }).waitFor({ timeout: 30_000 });
  const filed = /issue (\d+)/.exec(await chip.innerText())[1];

  // The status mark, and its popover.
  await chip.click();
  await list.waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out('14-status.png'), clip: await around(page, [chip, list.locator('.obpanel').or(list)], 12) });
  await page.keyboard.press('Escape');

  // ── The issues pages ──────────────────────────────────────────────────────────────────
  await page.goto('/issues');
  await page.getByRole('searchbox', { name: 'Search issues' }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out('16-issues.png'), fullPage: true });
  const search = page.getByRole('searchbox', { name: 'Search issues' });
  await until('/ to focus the search', async () => {
    await page.keyboard.press('Slash');
    return search.evaluate((el) => el === document.activeElement);
  });
  await page.keyboard.type('harbor');
  await page.waitForTimeout(400);
  await page.screenshot({ path: out('19-search.png'), fullPage: true });

  await page.goto(`/issues/${filed}`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.getByAltText(`Screenshot 1 filed with issue ${filed}`).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out('17-issue-detail.png') });
  await page.getByRole('combobox', { name: 'Status' }).selectOption('agent-ready');
  await page.locator('[data-status="agent-ready"]').waitFor();
  await page.locator('aside.issueside').screenshot({ path: out('20-status-control.png') });
  await ctx.close();

  // ── Pick a part with a finger, on a tablet-sized screen ────────────────────────────────
  const tablet = await newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const tp = await tablet.newPage();
  await tp.goto('/');
  await tp.getByRole('button', { name: /Feedback/ }).tap();
  await tp.getByRole('dialog', { name: 'Give feedback' }).waitFor();
  await shotCount(tp, 1);
  await tp.getByRole('button', { name: 'Pick a part' }).tap();
  await tp.getByRole('dialog', { name: 'Drag to choose a part of the page' }).waitFor();
  const cdp = await tablet.newCDPSession(tp);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', 260, 200);
  for (let i = 1; i <= 10; i += 1) await touch('touchMove', 260 + i * 52, 200 + i * 26);
  await touch('touchEnd', 780, 460);
  await tp.locator('.regionhandle').first().waitFor();
  await tp.waitForTimeout(300);
  await tp.screenshot({ path: out('10-region-touch.png') });
  await tablet.close();

  log(`done: ${OUT}`);
} finally {
  await browser.close();
}
