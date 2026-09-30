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
  await expect(page.getByRole('textbox', { name: 'Enter any feedback' })).toBeFocused();
  return box;
}

const editor = (page: Page) => page.getByRole('textbox', { name: 'Enter any feedback' });
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

/** The filed screen's heading: where the report just filed stands. */
const filedHeading = (page: Page) => page.getByRole('dialog', { name: 'Give feedback' }).locator('.fbfiledhead');

/** The rail's status line. */
const status = (page: Page) => page.locator('.obchip');

type TouchType = 'touchStart' | 'touchMove' | 'touchEnd';

/**
 * A finger on the screen. Chromium gets real touch input through the DevTools protocol. WebKit has
 * no such protocol in Playwright, so there the same gesture is dispatched as touch pointer events,
 * kept on the element the finger went down on (as a browser captures a touch pointer implicitly).
 */
async function finger(page: Page, browserName: string): Promise<(type: TouchType, x: number, y: number) => Promise<unknown>> {
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    return (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  }
  return (type, x, y) => page.evaluate(([t, px, py]) => {
    const w = window as unknown as { __fingerOn?: Element | null };
    const name = { touchStart: 'pointerdown', touchMove: 'pointermove', touchEnd: 'pointerup' }[t];
    const target = t === 'touchStart' || !w.__fingerOn ? document.elementFromPoint(px, py) : w.__fingerOn;
    if (t === 'touchStart') w.__fingerOn = target;
    target?.dispatchEvent(new PointerEvent(name, {
      bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true,
      clientX: px, clientY: py, button: 0, buttons: t === 'touchEnd' ? 0 : 1, width: 20, height: 20, pressure: t === 'touchEnd' ? 0 : 0.5,
    }));
    if (t === 'touchEnd') w.__fingerOn = null;
  }, [type, x, y] as const);
}

// The example's stand-in for auth: signed in as an invented user (lib/users.ts), unless a test signs out.
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'demo_user', value: 'robin', url: baseURL! }]);
});

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
  // The box stays open on the filed screen; Escape closes it.
  await expect(filedHeading(page)).toBeVisible();
  await page.keyboard.press('Escape');
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

  test('a region is drawn with a finger, adjusted by a corner, and used', async ({ page, browserName }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Feedback/ }).tap();
    const box = page.getByRole('dialog', { name: 'Give feedback' });
    await expect(box).toBeVisible();
    await expect(shotsLabel(page)).toHaveText('Screenshots · 1');
    await box.getByRole('button', { name: 'Pick a part' }).tap();
    const picker = page.getByRole('dialog', { name: 'Drag to choose a part of the page' });
    await expect(picker).toBeVisible();

    // pointerType is "touch" (see finger()).
    const touch = await finger(page, browserName);
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

test('the filed screen: several reports in a row without reopening the box', async ({ page }) => {
  await page.goto('/');
  const box = await openWithShortcut(page);
  // Hold the answer to "is it filed yet?" so the screen is seen before its number arrives.
  const hold = (route: import('@playwright/test').Route) => route.fulfill({ json: { state: 'journaled' } });
  await page.route('**/api/feedback?clientId=*', hold);
  await page.keyboard.type('First of two invented reports: the late tile flickers');
  await page.keyboard.press('ControlOrMeta+Enter');

  await expect(filedHeading(page)).toHaveText('Saved on the server · being filed');
  await expect(box.getByRole('link', { name: 'Open the issue' })).toHaveAttribute('aria-disabled', 'true');
  await expect(box.getByRole('button', { name: 'Give more feedback' })).toBeFocused();
  const layout = () => box.locator('.fbfiled .acts .btn, .fbfiledhead, .fbfiled > p').evaluateAll(
    (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(','); }));
  const before = await layout();

  // The number arrives; nothing on the screen moves or changes size.
  await page.unroute('**/api/feedback?clientId=*', hold);
  await expect(filedHeading(page)).toHaveText(/^Filed as issue #\d+$/, { timeout: 20_000 });
  expect(await layout()).toEqual(before);
  const first = Number(/#(\d+)$/.exec(await filedHeading(page).innerText())![1]!);
  const firstHref = (await box.getByRole('link', { name: 'Open the issue' }).getAttribute('href'))!;
  expect(Number(/\/issues\/(\d+)$/.exec(firstHref)![1])).toBe(first);

  // ⌘/Ctrl+Enter here means "another": an empty box with a new automatic screenshot.
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveText('');
  await expect(box.locator('.shotthumb img')).toHaveCount(1);

  await editor(page).focus();
  await page.keyboard.type('Second of two invented reports: the reports tab is slow');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(filedHeading(page)).toHaveText(/^Filed as issue #\d+$/, { timeout: 20_000 });
  const list = box.locator('.fbfiledlist');
  await expect(list.locator('.lbl')).toHaveText('Filed while this was open · 2');
  await expect(list.getByRole('link')).toHaveCount(2);
  await expect(list.getByRole('link').first()).toHaveAttribute('href', firstHref);
  await expect(list.locator('.fbfiledno').first()).toHaveText(`#${first}`);
  // One number column: every title starts at the same x.
  const titles = await list.locator('.fbfiledtitle').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(titles).size).toBe(1);

  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
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
  await expect(filedHeading(page)).toContainText(/Kept in this browser .* sent again when the server answers/);
  await page.keyboard.press('Escape');
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

  test('the annotation toolbar is one row of icon buttons with names, and a box drawn is kept', async ({ page, browserName }) => {
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
    const touch = await finger(page, browserName);
    await touch('touchStart', c.x + 20, c.y + 20);
    for (let i = 1; i <= 6; i += 1) await touch('touchMove', c.x + 20 + i * 15, c.y + 20 + i * 8);
    await touch('touchEnd', c.x + 110, c.y + 68);
    await expect(bar.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await bar.getByRole('button', { name: 'Done' }).tap();
    await expect(bar).toBeHidden();
    await expect(box.locator('.shotmeta')).toContainText('annotated');
  });
});

test('the annotator: select a mark to move or delete it; stroke widths sit with the colors', async ({ page }) => {
  await page.goto('/');
  const box = await openWithShortcut(page);
  await box.getByRole('button', { name: 'Annotate screenshot 1' }).click();
  const bar = page.getByRole('toolbar', { name: 'Annotation tools' });
  const canvas = page.locator('.setcanvas');
  const c = (await canvas.boundingBox())!;
  const note = page.locator('.setnote');

  // A thick line.
  await bar.getByRole('button', { name: /^Color and stroke width/ }).click();
  await page.getByRole('button', { name: 'Thick stroke' }).click();
  await expect(bar.getByRole('button', { name: /^Color and stroke width: .*, Thick$/ })).toBeVisible();
  await page.keyboard.press('Escape'); // closes the popover, not the editor
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Draw a line' }).click();
  await page.mouse.move(c.x + 60, c.y + 60);
  await page.mouse.down();
  await page.mouse.move(c.x + 200, c.y + 140, { steps: 5 });
  await page.mouse.up();
  await expect(note).toContainText('1 mark ');

  // Select it by clicking on it, drag it, delete it.
  await bar.getByRole('button', { name: /^Select/ }).click();
  await page.mouse.click(c.x + 130, c.y + 100);
  await page.mouse.move(c.x + 130, c.y + 100);
  await page.mouse.down();
  await page.mouse.move(c.x + 130, c.y + 180, { steps: 4 });
  await page.mouse.up();
  await expect(note).toContainText('1 mark ');
  await page.keyboard.press('Delete');
  await expect(note).toContainText('0 marks');

  // Tooltips in the editor are dark, like its bars.
  await bar.getByRole('button', { name: 'Draw a line' }).hover();
  const bg = await bar.getByRole('button', { name: 'Draw a line' }).evaluate((el) => getComputedStyle(el, '::after').backgroundColor);
  expect(bg).toBe('rgb(26, 25, 23)');
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
});

test('signed out, the issues and their pictures are closed; a report still files', async ({ page, context, baseURL }) => {
  await context.clearCookies();
  const origin = new URL(baseURL!).origin;

  // The read API, the pictures and status changes answer 401 without the demo session.
  expect((await page.request.get('/api/issues')).status()).toBe(401);
  expect((await page.request.get('/api/issues/0001')).status()).toBe(401);
  expect((await page.request.get('/api/issues/attachments/0001-screenshot.png')).status()).toBe(401);
  const patch = await page.request.patch('/api/issues/0001', { data: { status: 'done' }, headers: { origin } });
  expect(patch.status()).toBe(401);

  // The issues page says how to get in.
  await page.goto('/issues');
  await expect(page.getByRole('status')).toContainText('Sign in to see issues');
  await expect(page.getByRole('searchbox', { name: 'Search issues' })).toHaveCount(0);

  // Filing does not need a session: the report is kept, filed as "unknown".
  const box = await openWithShortcut(page);
  await page.keyboard.type('Signed out, the rail shows no user name');
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/feedback');
  await page.keyboard.press('ControlOrMeta+Enter');
  expect((await posted).status()).toBe(202);
  await expect(filedHeading(page)).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(box).toBeHidden();

  // Sign in as someone from the rail, and the list is there.
  await page.getByLabel('Sign in as').selectOption('sam');
  await expect(page.getByRole('searchbox', { name: 'Search issues' })).toBeVisible();
  await expect(page.getByLabel('Signed in as')).toHaveValue('sam');
});
