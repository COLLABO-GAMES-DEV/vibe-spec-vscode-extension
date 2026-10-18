import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Snapshot } from '../src/protocol.js';

const cell = (page: Page, key: string, column: string) =>
  page.getByRole('gridcell', { name: `${key}/${column}`, exact: true });

const header = (page: Page, column: number) => page.getByRole('columnheader').nth(column);
const width = (target: Locator) => target.evaluate(element => element.getBoundingClientRect().width);

async function external(request: APIRequestContext, key: string, values: Record<string, string>) {
  const response = await request.post('/__vibe/external', { data: { table: 'items', key, values } });
  expect(response.ok()).toBe(true);
}

async function expectAligned(page: Page) {
  await expect.poll(async () => page.getByRole('grid').evaluate(grid => {
    const viewport = grid.getBoundingClientRect();
    const headers = Array.from(grid.querySelectorAll('[role="columnheader"]'), element => element.getBoundingClientRect());
    const visible = Array.from(grid.querySelectorAll('[role="row"]')).filter(row => {
      const rect = row.getBoundingClientRect();
      return row.querySelector('[role="gridcell"]') && rect.bottom > headers[0]!.bottom && rect.top < viewport.bottom;
    });
    if (!visible.length) return Number.POSITIVE_INFINITY;
    return Math.max(...visible.flatMap(row =>
      Array.from(row.querySelectorAll('[role="gridcell"]')).flatMap((element, index) => {
        const rect = element.getBoundingClientRect();
        return [Math.abs(rect.x - headers[index]!.x), Math.abs(rect.right - headers[index]!.right)];
      })));
  })).toBeLessThanOrEqual(1);
  await expect.poll(() => page.getByRole('grid').getByRole('row').count()).toBeLessThan(100);
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__vibe/reset')).ok()).toBe(true);
});

test('header and every visible row share column boundaries throughout vertical and horizontal scrolling', async ({ page, request }) => {
  await external(request, 'consumable_potion', { note: '긴 설명과 이야기 '.repeat(60) });
  await external(request, 'demo_4999', { name: '화면 밖 마지막 행의 아주 긴 이름 '.repeat(6) });
  await page.setViewportSize({ width: 660, height: 780 });
  await page.goto('/?table=items');
  await expect(cell(page, 'currency_gold', 'name')).toBeVisible();
  const scroller = page.getByTestId('grid-scroll');
  await expectAligned(page);
  for (const fraction of [0, 0.5, 1]) {
    await scroller.evaluate((element, value) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * value;
      element.scrollLeft = 0;
    }, fraction);
    if (fraction === 1) await expect(cell(page, 'demo_4999', 'name')).toBeAttached();
    if (fraction === 0.5) await expect(cell(page, 'currency_gold', 'name')).toHaveCount(0);
    await expectAligned(page);
    await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await expectAligned(page);
  }
});

test('an offscreen value sets the shared width, and updates expand and shrink that width', async ({ page, request }) => {
  await page.goto('/?table=items');
  await expect(cell(page, 'currency_gold', 'name')).toBeVisible();
  const initial = await width(header(page, 1));
  expect(initial).toBeLessThan(180);
  await expect(cell(page, 'demo_4999', 'name')).toHaveCount(0);
  const longer = 'MMMMMMMMMMMMMMMMMMMMMMMMMM';
  await external(request, 'demo_4999', { name: longer });
  await expect.poll(() => width(header(page, 1))).toBeGreaterThan(initial + 100);
  await expect(cell(page, 'demo_4999', 'name')).toHaveCount(0);
  const expectedMinimum = await cell(page, 'currency_gold', 'name').evaluate((element, text) => {
    const context = document.createElement('canvas').getContext('2d')!;
    const style = getComputedStyle(element);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return context.measureText(text).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  }, longer);
  expect(await width(header(page, 1))).toBeGreaterThanOrEqual(expectedMinimum);
  expect(await width(header(page, 1))).toBeLessThan(expectedMinimum + 12);
  await external(request, 'demo_4999', { name: '짧음' });
  await expect.poll(() => width(header(page, 1))).toBe(initial);
  await expectAligned(page);
});

test('header label and code fit even when the label is wider than the body width cap', async ({ page, request }) => {
  const label = 'W'.repeat(60);
  const response = await request.get('/__vibe/snapshot', { params: { table: 'items' } });
  expect(response.ok()).toBe(true);
  const snapshot = await response.json() as Snapshot;
  snapshot.schema.columns.name!.label = label;
  // A fixed response avoids leaving a polling route.fetch alive during test teardown.
  await page.route('**/__vibe/snapshot?table=items*', route => route.fulfill({ json: snapshot }));
  await page.goto('/?table=items');
  await expect(header(page, 1).locator('strong')).toHaveText(label);
  for (const target of await page.getByRole('columnheader').all()) {
    const measurements = await target.evaluate(element => {
      const context = document.createElement('canvas').getContext('2d')!;
      const outer = getComputedStyle(element);
      const inset = parseFloat(outer.paddingLeft) + parseFloat(outer.paddingRight)
        + parseFloat(outer.borderLeftWidth) + parseFloat(outer.borderRightWidth);
      return Array.from(element.children, child => {
        const style = getComputedStyle(child);
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return { actual: element.getBoundingClientRect().width, minimum: context.measureText(child.textContent ?? '').width + inset };
      });
    });
    for (const measurement of measurements) expect(measurement.actual).toBeGreaterThanOrEqual(measurement.minimum);
  }
  expect(await width(header(page, 1))).toBeGreaterThan(480);
  await expectAligned(page);
});

test('long text stops at the width cap and remains available in the tooltip and wrapped editor', async ({ page, request }) => {
  const text = '히어로 카드의 자세한 이야기와 설명입니다. '.repeat(45);
  await external(request, 'consumable_potion', { note: text });
  await page.goto('/?table=items');
  const note = cell(page, 'consumable_potion', 'note');
  await expect(note).toContainText(text);
  await expect.poll(() => width(header(page, 3))).toBe(480);
  await expect(note).toHaveAttribute('title', text);
  await note.hover();
  const truncation = await note.locator('span').evaluate(element => ({
    clipped: element.scrollWidth > element.clientWidth,
    overflow: getComputedStyle(element).textOverflow,
  }));
  expect(truncation).toEqual({ clipped: true, overflow: 'ellipsis' });
  await note.dblclick();
  const editor = page.getByRole('textbox', { name: '값 편집', exact: true });
  await expect(editor).toHaveValue(text);
  expect(await editor.evaluate(element => element.tagName)).toBe('TEXTAREA');
  await expect.poll(() => editor.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(42);
  expect(await editor.evaluate(element => getComputedStyle(element).whiteSpace)).not.toBe('pre');
  expect(await editor.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
});

test('an unchanged or restored draft switches directly to the clicked cell without writing', async ({ page }) => {
  const submitted: string[] = [];
  page.on('request', event => {
    if (event.method() === 'POST' && new URL(event.url()).pathname === '/__vibe/apply') submitted.push(event.postData() ?? '');
  });
  await page.goto('/?table=items');
  await cell(page, 'currency_gold', 'name').dblclick();
  const editor = page.getByRole('textbox', { name: '값 편집', exact: true });
  await expect(editor).toHaveValue('골드');
  // An unchanged short-text editor must not cover the cell in the next row.
  await cell(page, 'demo_0000', 'name').click();
  await expect(editor).toHaveValue('아이템 0');
  await expect(editor).toBeFocused();
  await cell(page, 'currency_gold', 'note').click();
  await expect(editor).toHaveValue('001');
  await expect(editor).toBeFocused();
  await expect(cell(page, 'currency_gold', 'note')).toHaveAttribute('data-active', 'true');
  await editor.fill('바꿨다가');
  await editor.fill('001');
  await cell(page, 'consumable_potion', 'name').click();
  await expect(editor).toHaveValue('회복약');
  await expect(editor).toBeFocused();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(submitted).toEqual([]);
});

test('unchanged null and numeric spelling switch cells without submitting a write', async ({ page, request }) => {
  const submitted: string[] = [];
  page.on('request', event => {
    if (event.method() === 'POST' && new URL(event.url()).pathname === '/__vibe/apply') submitted.push(event.postData() ?? '');
  });
  await page.goto('/?table=offers');
  await cell(page, 'starter', 'currency').dblclick();
  await expect(page.getByRole('combobox', { name: '값 편집', exact: true })).toHaveValue('');
  await cell(page, 'bundle', 'price').click();
  const editor = page.getByRole('textbox', { name: '값 편집', exact: true });
  await expect(editor).toHaveValue('+001.2300E+0002');
  await cell(page, 'bundle', 'count').click();
  await expect(editor).toHaveValue('900719925474099312345');
  await expect(editor).toBeFocused();
  expect(submitted).toEqual([]);
  const snapshot = await (await request.get('/__vibe/snapshot', { params: { table: 'offers' } })).json() as Snapshot;
  expect(snapshot.rows.find(row => row.sku === 'starter')?.currency).toBeNull();
  expect(snapshot.rows.find(row => row.sku === 'bundle')?.price).toBe('+001.2300E+0002');
});
