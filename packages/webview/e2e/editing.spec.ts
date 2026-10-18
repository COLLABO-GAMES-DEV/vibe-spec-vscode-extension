import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Snapshot } from '../src/protocol.js';

const cell = (page: Page, key: string, column: string) =>
  page.getByRole('gridcell', { name: `${key}/${column}`, exact: true });
const editor = (page: Page) => page.getByRole('textbox', { name: '값 편집', exact: true });

async function stored(request: APIRequestContext, table: string, key: string, column: string) {
  const response = await request.get('/__vibe/snapshot', { params: { table } });
  expect(response.ok()).toBe(true);
  const snapshot = await response.json() as Snapshot;
  return snapshot.rows.find(row => row[snapshot.schema.primary_key] === key)?.[column];
}

async function edit(page: Page, key: string, column: string, value: string) {
  await cell(page, key, column).dblclick();
  await editor(page).fill(value);
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__vibe/reset')).ok()).toBe(true);
});

test('clicking another cell applies the draft and opens that cell, while Escape restores its original value', async ({ page, request }) => {
  await page.goto('/?table=items');
  await edit(page, 'currency_gold', 'name', '확정한 재화 이름');
  await cell(page, 'currency_gold', 'note').click();
  await expect(editor(page)).toHaveValue('001');
  await expect(editor(page)).toBeFocused();
  expect(await stored(request, 'items', 'currency_gold', 'name')).toBe('확정한 재화 이름');
  await editor(page).fill('취소할 메모');
  await editor(page).press('Escape');
  await expect(editor(page)).toHaveCount(0);
  await expect(cell(page, 'currency_gold', 'note')).toHaveAttribute('data-active', 'true');
  await expect(cell(page, 'currency_gold', 'note')).toContainText('001');
  expect(await stored(request, 'items', 'currency_gold', 'note')).toBe('001');
  expect(await stored(request, 'items', 'currency_gold', 'name')).toBe('확정한 재화 이름');
});

test('click-to-apply preserves the exact numeric string before opening the destination editor', async ({ page, request }) => {
  await page.goto('/?table=offers');
  const numeric = '+000123.4500e-0002';
  await edit(page, 'bundle', 'price', numeric);
  await cell(page, 'bundle', 'count').click();
  await expect(editor(page)).toHaveValue('900719925474099312345');
  await expect(editor(page)).toBeFocused();
  expect(await stored(request, 'offers', 'bundle', 'price')).toBe(numeric);
  await expect(cell(page, 'bundle', 'price')).toContainText(numeric);
});

test('Enter applies then focuses the next row; Tab and Shift+Tab apply then focus adjacent columns', async ({ page, request }) => {
  await page.goto('/?table=offers');
  await edit(page, 'bundle', 'price', '000123.4500');
  await editor(page).press('Enter');
  await expect(editor(page)).toHaveCount(0);
  await expect(cell(page, 'starter', 'price')).toHaveAttribute('data-active', 'true');
  expect(await stored(request, 'offers', 'bundle', 'price')).toBe('000123.4500');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toHaveValue('-0.000');
  await editor(page).fill('000.010');
  await editor(page).press('Tab');
  await expect(cell(page, 'starter', 'count')).toHaveAttribute('data-active', 'true');
  expect(await stored(request, 'offers', 'starter', 'price')).toBe('000.010');
  await page.keyboard.press('Enter');
  await editor(page).fill('00024');
  await editor(page).press('Shift+Tab');
  await expect(cell(page, 'starter', 'price')).toHaveAttribute('data-active', 'true');
  expect(await stored(request, 'offers', 'starter', 'count')).toBe('00024');
});

test('a complete value outside the schema range is applied and marked invalid while the clicked cell opens', async ({ page, request }) => {
  await page.goto('/?table=offers');
  await edit(page, 'bundle', 'price', '-1');
  await cell(page, 'bundle', 'count').click();
  await expect(editor(page)).toHaveValue('900719925474099312345');
  await expect(editor(page)).toBeFocused();
  expect(await stored(request, 'offers', 'bundle', 'price')).toBe('-1');
  await expect(cell(page, 'bundle', 'price')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('region', { name: '검증 오류', exact: true })
    .getByRole('button', { name: /offers\/bundle\/price/ })).toContainText('minimum');
});

for (const action of ['click', 'Enter'] as const) {
  test(`an incomplete number keeps its draft and source focus when ${action} attempts to apply it`, async ({ page, request }) => {
    await page.goto('/?table=offers');
    await edit(page, 'bundle', 'price', '1e');
    const response = page.waitForResponse(event => new URL(event.url()).pathname === '/__vibe/apply');
    if (action === 'click') await cell(page, 'bundle', 'count').click();
    else await editor(page).press('Enter');
    expect(await (await response).json()).toMatchObject({ type: 'error', code: 'INCOMPLETE_NUMBER' });
    await expect(editor(page)).toHaveValue('1e');
    await expect(editor(page)).toBeFocused();
    await expect(cell(page, 'bundle', 'price')).toHaveAttribute('data-active', 'true');
    await expect(page.getByRole('alert')).toContainText('INCOMPLETE_NUMBER');
    expect(await stored(request, 'offers', 'bundle', 'price')).toBe('+001.2300E+0002');
    await editor(page).press('Escape');
    await expect(cell(page, 'bundle', 'price')).toHaveAttribute('data-active', 'true');
    await expect(cell(page, 'bundle', 'price')).toContainText('+001.2300E+0002');
  });
}

test('a stale revision cancels click navigation and preserves the draft and original editor focus', async ({ page, request }) => {
  await page.goto('/?table=offers');
  let release!: () => void;
  let submitted!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { submitted = resolve; });
  await page.route('**/__vibe/apply', async route => {
    submitted();
    await held;
    await route.continue();
  });
  await edit(page, 'bundle', 'price', '00123.000');
  const response = page.waitForResponse(event => new URL(event.url()).pathname === '/__vibe/apply');
  await cell(page, 'bundle', 'count').click();
  await started;
  try {
    const external = await request.post('/__vibe/external', {
      data: { table: 'items', key: 'currency_gold', values: { note: '다른 프로세스의 새 변경' } },
    });
    expect(external.ok()).toBe(true);
  } finally {
    release();
  }
  expect(await (await response).json()).toMatchObject({ type: 'error', code: 'STALE_REVISION' });
  await expect(editor(page)).toHaveValue('00123.000');
  await expect(editor(page)).toBeFocused();
  await expect(cell(page, 'bundle', 'price')).toHaveAttribute('data-active', 'true');
  await expect(page.getByRole('alert')).toContainText('STALE_REVISION');
  expect(await stored(request, 'offers', 'bundle', 'price')).toBe('+001.2300E+0002');
  expect(await stored(request, 'items', 'currency_gold', 'note')).toBe('다른 프로세스의 새 변경');
});
