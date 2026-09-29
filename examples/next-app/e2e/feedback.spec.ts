import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA = process.env.FEEDBACK_DATA!;

/** Opens the box with the keyboard shortcut, the way a keyboard-first reporter does. */
async function openWithShortcut(page: Page) {
  const box = page.getByRole('dialog', { name: 'Give feedback' });
  // Retried until the page has hydrated and bound the key.
  await expect(async () => {
    await page.keyboard.press('Alt+KeyF');
    await expect(box).toBeVisible({ timeout: 500 });
  }).toPass();
  // Keyboard-first: the cursor is in the description as soon as the box is up.
  await expect(page.getByRole('textbox', { name: 'What happened' })).toBeFocused();
  return box;
}

const editor = (page: Page) => page.getByRole('textbox', { name: 'What happened' });
const shotsLabel = (page: Page) => page.getByRole('dialog', { name: 'Give feedback' }).locator('.fbshots > .lbl');

/** A small PNG made in the page, dropped onto the markdown field as a file. */
async function dropImage(page: Page, name: string) {
  const dataTransfer = await page.evaluateHandle(async (fileName) => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 40;
    const g = c.getContext('2d')!;
    g.fillStyle = '#BF4A16'; g.fillRect(0, 0, 64, 40);
    g.fillStyle = '#fff'; g.fillRect(8, 8, 20, 20);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], fileName, { type: 'image/png' }));
    return dt;
  }, name);
  await page.locator('.mdrichwrap').dispatchEvent('drop', { dataTransfer });
}

/** The rail's status line. */
const status = (page: Page) => page.locator('.obchip');

test('files a report end to end: shortcut, markdown, dropped file, region shot, journaled, listed', async ({ page }) => {
  await page.goto('/reports?region=harbor');
  const box = await openWithShortcut(page);

  // No title field: the server writes the title.
  await expect(box.getByLabel(/title/i)).toHaveCount(0);
  await expect(box.locator('input[type=text]')).toHaveCount(0);

  // The cursor is already in the description; markdown typed as markdown becomes rich text.
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('Harbor totals **double count** returns');
  await expect(editor(page).locator('strong')).toHaveText('double count');
  await page.keyboard.press('Enter');

  // The automatic screenshot arrives on its own.
  await expect(shotsLabel(page)).toHaveText('Screenshots · 1');

  // A file dropped into the field goes in as a picture with its own Annotate and Remove.
  await dropImage(page, 'returns.png');
  await expect(editor(page).locator('img[alt="returns.png"]')).toBeVisible();

  // Another screenshot, of a part of the page, chosen with the mouse.
  await box.getByRole('button', { name: 'Pick a part' }).click();
  const picker = page.getByRole('dialog', { name: 'Drag to choose a part of the page' });
  await expect(picker).toBeVisible();
  await page.mouse.move(300, 160);
  await page.mouse.down();
  await page.mouse.move(450, 260, { steps: 5 });
  await page.mouse.move(620, 380, { steps: 5 });
  await page.mouse.up();
  await expect(picker).toBeHidden();
  await expect(shotsLabel(page)).toHaveText('Screenshots · 2', { timeout: 30_000 });

  // ⌘/Ctrl+Enter files it; the request carries no title, and the picture as attachment:1.
  const posted = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/feedback');
  await editor(page).focus();
  await page.keyboard.press('ControlOrMeta+Enter');
  const request = (await posted).postDataJSON() as Record<string, unknown> & { body: string; screenshots: string[]; images: unknown[]; imageOffset: number; context: { route: string; filters: Record<string, string> }; clientId: string };
  expect(request).not.toHaveProperty('title');
  expect(request.body).toContain('**double count**');
  expect(request.body).toContain('(attachment:1)');
  expect(request.screenshots).toHaveLength(2);
  expect(request.images).toHaveLength(1);
  expect(request.imageOffset).toBe(2);
  expect(request.context.route).toBe('/reports');
  expect(request.context.filters).toEqual({ region: 'harbor' });
  await expect(box).toBeHidden();

  // Journaled on the server at once, then filed; the rail says so.
  await expect(status(page)).toContainText(/Filed as issue \d+/, { timeout: 20_000 });
  expect(existsSync(join(DATA, 'inbox', 'filed', `${request.clientId}.json`))).toBe(true);
  const id = /issue (\d+)/.exec(await status(page).innerText())![1]!;

  // Listed on the issues page with a title written from the first line, and found by search.
  await page.goto('/issues');
  // `/` focuses the search (retried until the page has hydrated and bound the key).
  await expect(async () => {
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox', { name: 'Search issues' })).toBeFocused({ timeout: 500 });
  }).toPass();
  await page.keyboard.type('harbor double');
  const row = page.getByRole('row').filter({ hasText: id });
  await expect(row).toContainText(/Harbor totals/);
  await row.getByRole('link').click();

  // The detail page: the screenshots and the dropped picture are served back.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Harbor totals');
  await expect(page.getByAltText(`Screenshot 1 filed with issue ${id}`)).toBeVisible();
  await expect(page.getByAltText(`Screenshot 2 filed with issue ${id}`)).toBeVisible();
  const dropped = page.locator('.mdimg').first();
  await expect(dropped).toBeVisible();
  expect(await dropped.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  // Status control: PATCH, and the page shows the saved state.
  await page.getByRole('combobox', { name: 'Status' }).selectOption('triaged');
  await expect(page.locator('[data-status]')).toHaveText('triaged');
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('a region is drawn with a finger, adjusted by a corner, and used', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Feedback/ }).tap();
    const box = page.getByRole('dialog', { name: 'Give feedback' });
    await expect(box).toBeVisible();
    await expect(shotsLabel(page)).toHaveText('Screenshots · 1');
    await box.getByRole('button', { name: 'Pick a part' }).tap();
    const picker = page.getByRole('dialog', { name: 'Drag to choose a part of the page' });
    await expect(picker).toBeVisible();

    // Real touch input through the DevTools protocol: pointerType is "touch".
    const cdp = await page.context().newCDPSession(page);
    const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await touch('touchStart', 200, 150);
    for (let i = 1; i <= 8; i += 1) await touch('touchMove', 200 + i * 40, 150 + i * 25);
    await touch('touchEnd', 520, 350);

    // A finger's drag leaves the rectangle up with handles, rather than taking the picture.
    await expect(picker).toBeVisible();
    await expect(page.locator('.regionhandle')).toHaveCount(4);
    await expect(page.locator('.regionsize')).toHaveText('320 × 200');

    // Drag the south-east corner out a little.
    await touch('touchStart', 520, 350);
    for (let i = 1; i <= 5; i += 1) await touch('touchMove', 520 + i * 10, 350 + i * 6);
    await touch('touchEnd', 570, 380);
    await expect(page.locator('.regionsize')).toHaveText('370 × 230');

    // The page underneath did not scroll while dragging.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await page.getByRole('button', { name: 'Use this part' }).tap();
    await expect(picker).toBeHidden();
    await expect(shotsLabel(page)).toHaveText('Screenshots · 2', { timeout: 30_000 });
  });
});

test('a draft survives a reload', async ({ page }) => {
  await page.goto('/settings');
  await openWithShortcut(page);
  await page.keyboard.type('The radius field accepts negative numbers');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Give feedback' })).toBeHidden();

  await page.reload();
  const box = await openWithShortcut(page);
  await expect(editor(page)).toContainText('The radius field accepts negative numbers');
  await expect(box).toContainText('Your unsent draft for this page');

  // Another page has its own draft, and lists this one.
  await page.keyboard.press('Escape');
  await page.goto('/');
  const other = await openWithShortcut(page);
  await expect(editor(page)).toHaveText('');
  await other.getByRole('button', { name: /Drafts · 1/ }).click();
  await expect(other.locator('.draftlist')).toContainText('The radius field accepts negative numbers');
});

test('the outbox keeps a report while the server is down and replays it when it is back', async ({ page }) => {
  // The server is unreachable for POSTs to the feedback route.
  const down = async (route: import('@playwright/test').Route) => {
    if (route.request().method() === 'POST') await route.abort('connectionrefused');
    else await route.fallback();
  };
  await page.route('**/api/feedback', down);

  const words = `Late orders are not highlighted ${Date.now().toString(36)}`;
  await page.goto('/');
  const box = await openWithShortcut(page);
  await page.keyboard.type(words);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(box).toBeHidden();
  await expect(status(page)).toContainText('1 report only on this device');

  // Kept through a reload, still down.
  await page.reload();
  await expect(status(page)).toContainText('1 report only on this device');
  await status(page).click();
  const list = page.getByRole('dialog', { name: 'Feedback waiting to file' });
  await expect(list).toContainText(words);
  await expect(list.getByRole('button', { name: 'Retry now' })).toBeVisible();
  await list.getByRole('button', { name: 'Close' }).click();

  // The server comes back; the network event replays it.
  await page.unroute('**/api/feedback', down);
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/feedback');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect((await posted).status()).toBe(202);
  await expect(status(page)).toContainText(/Filed as issue \d+/, { timeout: 20_000 });

  await page.goto('/issues');
  await expect(page.getByRole('link', { name: words })).toBeVisible();
});

test('the box never asks for a title, on any page', async ({ page }) => {
  for (const path of ['/', '/reports', '/issues']) {
    await page.goto(path);
    const box = await openWithShortcut(page);
    await expect(box.getByLabel(/title/i)).toHaveCount(0);
    await expect(box.getByPlaceholder(/title/i)).toHaveCount(0);
    await expect(box.getByRole('textbox')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
  }
});

test.describe('annotating on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the annotation toolbar is one row of icon buttons with names, and a box drawn is kept', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Feedback/ }).tap();
    const box = page.getByRole('dialog', { name: 'Give feedback' });
    await expect(box).toBeVisible();
    await expect(shotsLabel(page)).toHaveText('Screenshots · 1');
    await box.getByRole('button', { name: 'Annotate screenshot 1' }).tap();

    const bar = page.getByRole('toolbar', { name: 'Annotation tools' });
    await expect(bar).toBeVisible();
    // Every control is an icon with an accessible name and a tooltip, not a word.
    const buttons = bar.locator('button.seticon');
    expect(await buttons.count()).toBeGreaterThanOrEqual(10);
    for (const b of await buttons.all()) {
      expect(await b.getAttribute('aria-label')).toBeTruthy();
      expect(await b.getAttribute('data-tip')).toBeTruthy();
      expect((await b.innerText()).trim()).toBe('');
    }
    // One row, inside the screen, with finger-sized targets.
    const rows = await buttons.evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
    expect(rows).toBe(1);
    const barBox = (await bar.boundingBox())!;
    expect(barBox.x).toBeGreaterThanOrEqual(0);
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(390);
    expect((await buttons.first().boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // The active tool is visible as well as announced.
    await bar.getByRole('button', { name: 'Box it' }).tap();
    await expect(bar.getByRole('button', { name: 'Box it' })).toHaveAttribute('aria-pressed', 'true');
    await expect(bar.getByRole('button', { name: 'Box it' })).toHaveClass(/\bon\b/);

    // Draw a box with a finger, and keep it.
    const canvas = page.locator('.setcanvas');
    const c = (await canvas.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await touch('touchStart', c.x + 20, c.y + 20);
    for (let i = 1; i <= 6; i += 1) await touch('touchMove', c.x + 20 + i * 15, c.y + 20 + i * 8);
    await touch('touchEnd', c.x + 110, c.y + 68);
    await expect(bar.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await bar.getByRole('button', { name: 'Done' }).tap();
    await expect(bar).toBeHidden();
    await expect(box.locator('.shotmeta')).toContainText('annotated');
  });
});
