import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Snapshot } from '../src/protocol.js';

const cell = (page: Page, key: string, column: string) => page.getByRole('gridcell', { name: `${key}/${column}`, exact: true });
const editor = (page: Page) => page.getByLabel('값 편집', { exact: true });
// Windows' native clipboard may expose CRLF even when the copied TSV used LF.
const clipboardText = (page: Page) => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'));
async function snapshot(request: APIRequestContext, table = 'items'): Promise<Snapshot> {
  return (await request.get('/__vibe/snapshot', { params: { table } })).json();
}
async function value(request: APIRequestContext, table: string, key: string, column: string) {
  const current = await snapshot(request, table);
  return current.rows.find(row => row[current.schema.primary_key] === key)?.[column];
}
async function change(page: Page, key: string, column: string, text: string) {
  await cell(page, key, column).dblclick(); await editor(page).fill(text); await editor(page).press('Enter');
  await expect(editor(page)).toHaveCount(0);
}
async function external(request: APIRequestContext, table: string, key: string, values: Record<string, string>) {
  expect((await request.post('/__vibe/external', { data: { table, key, values } })).ok()).toBe(true);
}

test.beforeEach(async ({ request }) => { expect((await request.post('/__vibe/reset')).ok()).toBe(true); });

for (const modifier of ['Meta', 'Control']) {
  test(`${modifier} undo and redo affect only this screen's edits and keep unrelated external changes`, async ({ page, request }) => {
    await page.goto('/?table=items');
    await change(page, 'currency_gold', 'name', '화면에서 편집');
    await external(request, 'items', 'currency_gold', { note: '외부 메모' });
    await expect(cell(page, 'currency_gold', 'note')).toContainText('외부 메모');
    await page.keyboard.press(`${modifier}+z`);
    await expect.poll(() => value(request, 'items', 'currency_gold', 'name')).toBe('골드');
    expect(await value(request, 'items', 'currency_gold', 'note')).toBe('외부 메모');
    await page.keyboard.press(`${modifier}+Shift+z`);
    await expect.poll(() => value(request, 'items', 'currency_gold', 'name')).toBe('화면에서 편집');
    await page.reload();
    await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeDisabled();
  });
}

test('one rectangular paste is one undo and redo, preserving numeric spelling', async ({ page, request }) => {
  await page.goto('/?table=offers');
  await cell(page, 'bundle', 'price').click();
  await page.getByLabel('선택한 칸 입력').evaluate(element => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '000.5000\t00042\r\n0.005\t00099\r\n');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => value(request, 'offers', 'starter', 'count')).toBe('00099');
  await page.keyboard.press('Control+z');
  await expect.poll(() => value(request, 'offers', 'bundle', 'price')).toBe('+001.2300E+0002');
  expect(await value(request, 'offers', 'starter', 'count')).toBe('001');
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeDisabled();
  await page.keyboard.press('Control+y');
  await expect.poll(() => value(request, 'offers', 'starter', 'price')).toBe('0.005');
  expect(await value(request, 'offers', 'bundle', 'price')).toBe('000.5000');
});

test('Control+Y leaves a pending cell draft and view controls alone', async ({ page, request }) => {
  await page.goto('/?table=items');
  await change(page, 'currency_gold', 'name', '다시 할 이름');
  await page.keyboard.press('Control+z');
  await expect.poll(() => value(request, 'items', 'currency_gold', 'name')).toBe('골드');
  await cell(page, 'currency_gold', 'name').dblclick();
  await editor(page).fill('확정 전 초안');
  await editor(page).press('Control+y');
  await expect(editor(page)).toHaveValue('확정 전 초안');
  expect(await value(request, 'items', 'currency_gold', 'name')).toBe('골드');
  await editor(page).press('Escape');
  const filter = page.getByLabel('텍스트 필터', { exact: true });
  await filter.fill('currency_gold');
  await filter.press('Control+y');
  expect(await value(request, 'items', 'currency_gold', 'name')).toBe('골드');
  await cell(page, 'currency_gold', 'name').click();
  await page.keyboard.press('Control+y');
  await expect.poll(() => value(request, 'items', 'currency_gold', 'name')).toBe('다시 할 이름');
});

test('undo refuses a same-cell external edit instead of overwriting it', async ({ page, request }) => {
  await page.goto('/?table=offers');
  await change(page, 'bundle', 'price', '012.5000');
  await external(request, 'offers', 'bundle', { price: '099.000' });
  await expect(cell(page, 'bundle', 'price')).toContainText('099.000');
  await page.keyboard.press('Meta+z');
  await expect(page.getByRole('alert')).toContainText('HISTORY_CONFLICT');
  expect(await value(request, 'offers', 'bundle', 'price')).toBe('099.000');
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeEnabled();
});

test('typing replaces a selected value, while Enter and F2 keep it for editing', async ({ page, request }) => {
  await page.goto('/?table=items');
  await cell(page, 'currency_gold', 'name').click();
  await expect(editor(page)).toHaveCount(0);
  await page.keyboard.type('Gold');
  await expect(editor(page)).toHaveValue('Gold');
  await editor(page).press('Escape');
  expect(await value(request, 'items', 'currency_gold', 'name')).toBe('골드');
  for (const key of ['Enter', 'F2']) {
    await page.keyboard.press(key); await expect(editor(page)).toHaveValue('골드'); await editor(page).press('Escape');
  }
});

test('Chromium IME keeps the first Korean consonant while selection becomes an editor', async ({ page, request }) => {
  await page.goto('/?table=items');
  await cell(page, 'currency_gold', 'name').click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 });
  await expect(editor(page)).toHaveValue('ㅎ');
  await cdp.send('Input.imeSetComposition', { text: '히', selectionStart: 1, selectionEnd: 1 });
  await expect(editor(page)).toHaveValue('히');
  await cdp.send('Input.insertText', { text: '히' });
  await cdp.send('Input.imeSetComposition', { text: '어', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '어' });
  await cdp.send('Input.imeSetComposition', { text: '로', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '로' });
  await expect(editor(page)).toHaveValue('히어로');
  await editor(page).press('Enter');
  await expect.poll(() => value(request, 'items', 'currency_gold', 'name')).toBe('히어로');
  await cdp.detach();
});

for (const modifier of ['Meta', 'Control']) {
  test(`${modifier} copy exports a selected rectangle as raw numeric TSV`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/?table=offers');
    await cell(page, 'bundle', 'price').click();
    await cell(page, 'starter', 'count').click({ modifiers: ['Shift'] });
    await expect(page.locator('[role=gridcell][aria-selected=true]')).toHaveCount(4);
    await page.keyboard.press(`${modifier}+c`);
    await expect.poll(() => clipboardText(page)).toBe('+001.2300E+0002\t900719925474099312345\n-0.000\t001');
  });
}

test('header and Key stay fixed through both scroll directions', async ({ page, request }) => {
  await external(request, 'items', 'demo_4999', { name: '아주 긴 이름 '.repeat(60), note: '아주 긴 메모 '.repeat(60) });
  await page.setViewportSize({ width: 650, height: 800 }); await page.goto('/?table=items');
  const grid = page.getByRole('grid'); await expect(grid).toBeVisible();
  const header = page.getByRole('columnheader').first(); const before = await header.boundingBox();
  await grid.evaluate(element => { element.scrollTop = element.scrollHeight; element.scrollLeft = element.scrollWidth; });
  const key = cell(page, 'demo_4999', 'code'); await expect(key).toBeVisible();
  await expect.poll(async () => Math.abs((await header.boundingBox())!.x - before!.x)).toBeLessThan(1);
  await expect.poll(async () => Math.abs((await header.boundingBox())!.y - before!.y)).toBeLessThan(1);
  expect(Math.abs((await key.boundingBox())!.x - before!.x)).toBeLessThan(1);
  expect(await grid.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});

test('find scans offscreen data, moves next and previous, and reveals filtered results', async ({ page, request }) => {
  await external(request, 'items', 'demo_0000', { note: '숨은 쟁점' });
  await external(request, 'items', 'demo_4999', { note: '숨은 쟁점' });
  await page.goto('/?table=items');
  await page.getByLabel('텍스트 필터', { exact: true }).fill('currency_gold');
  await page.keyboard.press('Meta+f');
  const find = page.getByRole('region', { name: '표에서 찾기' });
  await find.getByLabel('찾을 내용').fill('숨은 쟁점');
  await expect(cell(page, 'demo_0000', 'note')).toHaveAttribute('data-active', 'true');
  await expect(page.getByLabel('텍스트 필터', { exact: true })).toHaveValue('');
  await expect(find).toContainText('1 / 2');
  await find.getByRole('button', { name: '다음 일치' }).click();
  await expect(cell(page, 'demo_4999', 'note')).toBeVisible();
  await expect(cell(page, 'demo_4999', 'note')).toHaveAttribute('data-active', 'true');
  await find.getByRole('button', { name: '이전 일치' }).click();
  await expect(cell(page, 'demo_0000', 'note')).toHaveAttribute('data-active', 'true');
  await find.getByRole('button', { name: '찾기 닫기' }).click();
  await page.keyboard.press('Control+f'); await expect(find).toBeVisible();
});

test('reference navigation and where-used distinguish declared references from text candidates', async ({ page, request }) => {
  await external(request, 'items', 'consumable_potion', { note: 'currency_gold 사용 메모' });
  await page.goto('/?table=offers');
  await cell(page, 'bundle', 'currency').click({ modifiers: ['Meta'] });
  await expect(page.getByRole('heading', { name: 'items', exact: true })).toBeVisible();
  await expect(cell(page, 'currency_gold', 'code')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('[role=gridcell][aria-selected=true]')).toHaveCount(4);
  await page.getByRole('button', { name: '행 사용처 보기' }).click();
  const panel = page.getByRole('complementary', { name: '사용처' });
  await panel.getByRole('region', { name: '선언된 참조', exact: true }).getByRole('button', { name: /offers\/bundle\/currency/ }).click();
  await expect(cell(page, 'bundle', 'currency')).toHaveAttribute('data-active', 'true');
  await panel.getByRole('button', { name: '사용처 닫기' }).click();
  await cell(page, 'bundle', 'currency').click({ modifiers: ['Control'] });
  await cell(page, 'currency_gold', 'code').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '사용처 보기' }).click();
  await panel.getByRole('region', { name: '본문 텍스트 후보', exact: true }).getByRole('button', { name: /items\/consumable_potion\/note/ }).click();
  await expect(cell(page, 'consumable_potion', 'note')).toHaveAttribute('data-active', 'true');
});

test('sort and filter stay in the view; editing a sorted filtered row uses its Key', async ({ page, request }) => {
  const initial = await snapshot(request, 'offers');
  await page.goto('/?table=offers');
  await page.getByLabel('정렬 열', { exact: true }).selectOption('price');
  await expect(page.locator('.grid-row').first()).toContainText('starter');
  const sorted = await snapshot(request, 'offers'); expect(sorted.revision).toBe(initial.revision);
  await page.getByLabel('필터 열', { exact: true }).selectOption('sku');
  await page.getByLabel('텍스트 필터', { exact: true }).fill('starter');
  await expect(page.locator('.grid-row')).toHaveCount(1);
  await expect(page.getByText('보기 전용 정렬·필터 적용 중')).toBeVisible();
  await change(page, 'starter', 'price', '012.5000');
  expect(await value(request, 'offers', 'starter', 'price')).toBe('012.5000');
  const after = await snapshot(request, 'offers'); expect(after.rows.map(row => row.sku)).toEqual(initial.rows.map(row => row.sku));
  await page.getByRole('button', { name: '보기 초기화' }).click();
  await expect(page.locator('.grid-row').first()).toContainText('bundle');
});

test('dragged column widths persist locally per table and double-click restores content fitting', async ({ page, request }) => {
  await page.goto('/?table=items');
  const original = await snapshot(request);
  const header = page.getByRole('columnheader').nth(1); const initial = (await header.boundingBox())!.width;
  const edge = page.getByRole('separator', { name: 'name 열 너비', exact: true }); const rect = (await edge.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 100, rect.y + rect.height / 2); await page.mouse.up();
  await expect.poll(async () => (await header.boundingBox())!.width).toBe(initial + 100);
  await page.reload(); await expect.poll(async () => (await header.boundingBox())!.width).toBe(initial + 100);
  expect((await snapshot(request)).revision).toBe(original.revision);
  await page.goto('/?table=offers');
  expect(await page.evaluate(() => localStorage.getItem('vibe.widths:offers'))).toBeNull();
  await page.goto('/?table=items');
  await edge.dblclick(); await expect.poll(async () => (await header.boundingBox())!.width).toBe(initial);
  await page.reload(); await expect.poll(async () => (await header.boundingBox())!.width).toBe(initial);
});

test('Key rename is undoable and redoable with its declared references', async ({ page, request }) => {
  await page.goto('/?table=items');
  await cell(page, 'currency_gold', 'code').dblclick(); await editor(page).fill('currency_gold_new');
  await editor(page).press('Tab');
  await expect(cell(page, 'currency_gold_new', 'name')).toHaveAttribute('data-active', 'true');
  expect(await value(request, 'offers', 'bundle', 'currency')).toBe('currency_gold_new');
  await page.keyboard.press('Meta+z');
  await expect(cell(page, 'currency_gold', 'code')).toBeVisible();
  expect(await value(request, 'offers', 'bundle', 'currency')).toBe('currency_gold');
  await page.keyboard.press('Meta+Shift+z');
  await expect(cell(page, 'currency_gold_new', 'code')).toBeVisible();
  expect(await value(request, 'offers', 'bundle', 'currency')).toBe('currency_gold_new');
});

test('drag selection and Shift+arrows select rectangular cells for copying', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?table=offers');
  const start = (await cell(page, 'bundle', 'price').boundingBox())!;
  const end = (await cell(page, 'starter', 'count').boundingBox())!;
  await page.mouse.move(start.x + 20, start.y + 20); await page.mouse.down();
  await page.mouse.move(end.x + 20, end.y + 20, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('[role=gridcell][aria-selected=true]')).toHaveCount(4);
  await page.keyboard.press('Control+c');
  await expect.poll(() => clipboardText(page)).toContain('900719925474099312345');
  await cell(page, 'bundle', 'price').click();
  await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('[role=gridcell][aria-selected=true]')).toHaveCount(4);
  await page.goto('/?table=items');
  const text = (await cell(page, 'consumable_potion', 'name').boundingBox())!;
  const choice = (await cell(page, 'currency_gold', 'kind').boundingBox())!;
  await page.mouse.move(text.x + 20, text.y + 20); await page.mouse.down();
  await page.mouse.move(choice.x + 20, choice.y + 20, { steps: 5 }); await page.mouse.up();
  await expect(page.getByLabel('선택한 칸 입력')).toBeFocused();
  await page.keyboard.press('Meta+c');
  await expect.poll(() => clipboardText(page)).toBe('회복약\tconsumable\n골드\tcurrency');
});

test('a failed redo preserves the outside value and its redo entry', async ({ page, request }) => {
  await page.goto('/?table=offers');
  await change(page, 'bundle', 'price', '012.5000');
  await page.keyboard.press('Control+z');
  await expect.poll(() => value(request, 'offers', 'bundle', 'price')).toBe('+001.2300E+0002');
  await external(request, 'offers', 'bundle', { price: '9.9000' });
  await expect(cell(page, 'bundle', 'price')).toContainText('9.9000');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByRole('alert')).toContainText('HISTORY_CONFLICT');
  expect(await value(request, 'offers', 'bundle', 'price')).toBe('9.9000');
  await expect(page.getByRole('button', { name: '다시 하기', exact: true })).toBeEnabled();
});
