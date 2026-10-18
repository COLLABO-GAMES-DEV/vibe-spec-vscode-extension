import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Snapshot } from '../src/protocol.js';

async function snapshot(request: APIRequestContext, table = 'items'): Promise<Snapshot> {
  const response = await request.get('/__vibe/snapshot', { params: { table } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Snapshot>;
}

async function stored(request: APIRequestContext, table: string, key: string, column: string) {
  const result = await snapshot(request, table);
  return result.rows.find(row => row[result.schema.primary_key] === key)?.[column];
}

const cell = (page: Page, key: string, column: string) =>
  page.getByRole('gridcell', { name: `${key}/${column}`, exact: true });

async function edit(page: Page, key: string, column: string, value: string) {
  await cell(page, key, column).dblclick();
  const input = page.getByRole('textbox', { name: '값 편집', exact: true });
  await input.fill(value);
  return input;
}

async function paste(target: Locator, text: string) {
  await target.evaluate((element, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

async function external(request: APIRequestContext, table: string, key: string, values: Record<string, string>) {
  const response = await request.post('/__vibe/external', { data: { table, key, values } });
  expect(response.ok()).toBe(true);
}

test.beforeEach(async ({ request }) => {
  const response = await request.post('/__vibe/reset');
  expect(response.ok()).toBe(true);
});

test('thousands of rows use a bounded DOM and the last row is reachable', async ({ page }) => {
  await page.goto('/?table=items');
  const grid = page.getByRole('grid');
  await expect(grid).toBeVisible();
  await expect(cell(page, 'currency_gold', 'name')).toContainText('골드');
  await expect.poll(() => grid.getByRole('row').count()).toBeLessThan(100);
  await expect(cell(page, 'demo_4999', 'name')).toHaveCount(0);
  await page.getByTestId('grid-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(cell(page, 'demo_4999', 'name')).toContainText('아이템 4999');
  await expect.poll(() => grid.getByRole('row').count()).toBeLessThan(100);
});

test('cell editing persists through the host and survives a reload', async ({ page, request }) => {
  await page.goto('/?table=items');
  const input = await edit(page, 'currency_gold', 'name', '황금 재화');
  await input.press('Enter');
  await expect.poll(() => stored(request, 'items', 'currency_gold', 'name')).toBe('황금 재화');
  await page.reload();
  await expect(cell(page, 'currency_gold', 'name')).toContainText('황금 재화');
});

test('numeric cells use text inputs and retain the complete original spelling', async ({ page, request }) => {
  await page.goto('/?table=offers');
  await expect(cell(page, 'bundle', 'price')).toContainText('+001.2300E+0002');
  const original = '+000123.4500e-0002';
  const input = await edit(page, 'bundle', 'price', original);
  await expect(input).toHaveAttribute('type', 'text');
  await input.press('Enter');
  await expect.poll(() => stored(request, 'offers', 'bundle', 'price')).toBe(original);
  await page.reload();
  await expect(cell(page, 'bundle', 'price')).toContainText(original);
  await expect(cell(page, 'bundle', 'count')).toContainText('900719925474099312345');
});

test('text editors preserve newlines and unchanged nullable cells preserve null', async ({ page, request }) => {
  await page.goto('/?table=items');
  await cell(page, 'consumable_potion', 'note').dblclick();
  const text = page.getByRole('textbox', { name: '값 편집', exact: true });
  expect(await text.evaluate(element => element.tagName)).toBe('TEXTAREA');
  await expect(text).toHaveValue('첫 줄\n둘째 줄');
  await text.press('Enter');
  await expect(text).toHaveCount(0);
  expect(await stored(request, 'items', 'consumable_potion', 'note')).toBe('첫 줄\n둘째 줄');

  await cell(page, 'consumable_potion', 'note').dblclick();
  await text.fill('줄바꿈 전');
  await text.press('Shift+Enter');
  await page.keyboard.insertText('줄바꿈 후');
  await expect(text).toHaveValue('줄바꿈 전\n줄바꿈 후');
  await text.press('Enter');
  await expect.poll(() => stored(request, 'items', 'consumable_potion', 'note')).toBe('줄바꿈 전\n줄바꿈 후');

  await page.goto('/?table=offers');
  await cell(page, 'starter', 'currency').dblclick();
  const reference = page.getByRole('combobox', { name: '값 편집', exact: true });
  await reference.press('Enter');
  await expect(reference).toHaveCount(0);
  expect(await stored(request, 'offers', 'starter', 'currency')).toBeNull();
  await expect(cell(page, 'starter', 'currency')).toContainText('null');
});

test('clicking another cell commits the draft before editing the destination', async ({ page, request }) => {
  await page.goto('/?table=items');
  const input = await edit(page, 'currency_gold', 'name', '버리면 안 되는 입력');
  await cell(page, 'currency_gold', 'note').click();
  await expect(input).toHaveValue('001');
  await expect(input).toBeFocused();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await stored(request, 'items', 'currency_gold', 'name')).toBe('버리면 안 되는 입력');
  await input.press('Escape');
  expect(await stored(request, 'items', 'currency_gold', 'note')).toBe('001');
});

test('Tab and Shift+Tab apply an editor value before focusing the next or previous cell', async ({ page, request }) => {
  await page.goto('/?table=offers');
  const price = await edit(page, 'bundle', 'price', '00123.000');
  await price.press('Tab');
  await expect(cell(page, 'bundle', 'count')).toHaveAttribute('data-active', 'true');
  expect(await stored(request, 'offers', 'bundle', 'price')).toBe('00123.000');
  await page.keyboard.press('Enter');
  const count = page.getByRole('textbox', { name: '값 편집', exact: true });
  await count.fill('00042');
  await count.press('Shift+Tab');
  await expect(cell(page, 'bundle', 'price')).toHaveAttribute('data-active', 'true');
  expect(await stored(request, 'offers', 'bundle', 'count')).toBe('00042');
});

test('a TSV rectangle becomes one apply request with the expected cells', async ({ page, request }) => {
  await page.goto('/?table=items');
  const submitted: unknown[] = [];
  page.on('request', event => {
    if (event.method() === 'POST' && new URL(event.url()).pathname === '/__vibe/apply') {
      submitted.push(event.postDataJSON());
    }
  });
  const first = cell(page, 'consumable_potion', 'name');
  await first.focus();
  const applied = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/__vibe/apply'
    && response.request().postDataJSON()?.type === 'apply');
  await paste(first, '수정한 물약\tconsumable\r\n수정한 재화\tcurrency');
  const response = await applied;
  expect(response.ok()).toBe(true);
  const result = await response.json() as Snapshot;
  expect(result.type).toBe('snapshot');
  // Read persisted values after acknowledgement; polling the entire 5,002-row
  // project while the write is in flight adds unrelated CPU work on Windows.
  const persisted = await snapshot(request);
  expect(persisted.revision).toBe(result.revision);
  expect(persisted.rows.find(row => row[persisted.schema.primary_key] === 'currency_gold'))
    .toMatchObject({ name: '수정한 재화', kind: 'currency' });
  expect(persisted.rows.find(row => row[persisted.schema.primary_key] === 'consumable_potion'))
    .toMatchObject({ name: '수정한 물약', kind: 'consumable' });
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({ type: 'apply' });
});

test('references offer target Keys and store the selected Key alone', async ({ page, request }) => {
  await page.goto('/?table=offers');
  // The text input offers Keys through a native datalist and still allows invalid drafts.
  await cell(page, 'bundle', 'currency').dblclick();
  const select = page.getByRole('combobox', { name: '값 편집', exact: true });
  await expect(page.locator('datalist option[value=currency_gold]')).toHaveCount(1);
  await expect(page.locator('datalist option[value=consumable_potion]')).toHaveCount(1);
  await select.fill('consumable_potion');
  await expect(select).toHaveValue('consumable_potion');
  const applied = page.waitForRequest(event => event.method() === 'POST' && new URL(event.url()).pathname === '/__vibe/apply');
  await select.press('Enter');
  expect((await applied).postDataJSON()).toMatchObject({ operations: [
    { op: 'update', table: 'offers', key: 'bundle', values: { currency: 'consumable_potion' } },
  ] });
  await expect.poll(() => stored(request, 'offers', 'bundle', 'currency')).toBe('consumable_potion');
});

test('editing a Key uses rename and updates declared references', async ({ page, request }) => {
  await page.goto('/?table=items');
  const input = await edit(page, 'currency_gold', 'code', 'currency_gold_new');
  await input.press('Enter');
  await expect(cell(page, 'currency_gold_new', 'name')).toContainText('골드');
  await expect(cell(page, 'currency_gold', 'code')).toHaveCount(0);
  await expect.poll(() => stored(request, 'offers', 'bundle', 'currency')).toBe('currency_gold_new');
});

test('arrow keys and Tab move between cells and Escape cancels a draft', async ({ page, request }) => {
  await page.goto('/?table=offers');
  await cell(page, 'bundle', 'price').focus();
  await page.keyboard.press('ArrowRight');
  await expect(cell(page, 'bundle', 'count')).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(cell(page, 'starter', 'count')).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Tab');
  await expect(cell(page, 'starter', 'available')).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  const input = page.getByRole('textbox', { name: '값 편집', exact: true });
  await input.fill('777');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(cell(page, 'starter', 'count')).toHaveAttribute('data-active', 'true');
  expect(await stored(request, 'offers', 'starter', 'count')).toBe('001');
});

test('core validation errors appear on the cell and the error list navigates to it', async ({ page, request }) => {
  await page.goto('/?table=offers');
  const input = await edit(page, 'bundle', 'price', '-0.01');
  await input.press('Enter');
  await expect.poll(() => stored(request, 'offers', 'bundle', 'price')).toBe('-0.01');
  await expect(cell(page, 'bundle', 'price')).toHaveAttribute('aria-invalid', 'true');
  const list = page.getByRole('region', { name: '검증 오류', exact: true });
  const error = list.getByRole('button', { name: /offers\/bundle\/price/ });
  await expect(error).toContainText('minimum');
  await error.click();
  await expect(cell(page, 'bundle', 'price')).toHaveAttribute('data-active', 'true');
});

test('an external edit refreshes a cell without reloading the page', async ({ page, request }) => {
  await page.goto('/?table=items');
  await expect(cell(page, 'currency_gold', 'name')).toContainText('골드');
  await external(request, 'items', 'currency_gold', { name: '외부에서 바꾼 이름' });
  await expect(cell(page, 'currency_gold', 'name')).toContainText('외부에서 바꾼 이름');
});

test('an error outside the virtual viewport navigates to its row and column', async ({ page, request }) => {
  await page.goto('/?table=items');
  await expect(cell(page, 'currency_gold', 'name')).toBeVisible();
  await external(request, 'items', 'demo_4999', { kind: 'not-an-enum-value' });
  const list = page.getByRole('region', { name: '검증 오류', exact: true });
  await list.getByRole('button', { name: /items\/demo_4999\/kind/ }).click();
  const invalid = cell(page, 'demo_4999', 'kind');
  await expect(invalid).toBeVisible();
  await expect(invalid).toHaveAttribute('data-active', 'true');
  await expect(invalid).toHaveAttribute('aria-invalid', 'true');
});

test('an external edit to another cell preserves the current draft', async ({ page, request }) => {
  await page.goto('/?table=items');
  const input = await edit(page, 'currency_gold', 'name', '아직 입력 중');
  await external(request, 'items', 'currency_gold', { note: '에이전트 메모' });
  await expect(cell(page, 'currency_gold', 'note')).toContainText('에이전트 메모');
  await expect(input).toHaveValue('아직 입력 중');
  await expect(page.getByRole('dialog', { name: '파일 변경 충돌', exact: true })).toHaveCount(0);
  // Enter submits asynchronously. Wait for this write's acknowledgement before
  // inspecting persistence; repeated full-table reads compete with the pending write.
  const applied = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/__vibe/apply');
  await input.press('Enter');
  const response = await applied;
  expect(await response.json()).toMatchObject({ type: 'snapshot',
    requestId: response.request().postDataJSON().requestId, history: { canUndo: true } });
  expect(response.ok()).toBe(true);
  await expect(input).toHaveCount(0);
  await expect(cell(page, 'currency_gold', 'name')).toContainText('아직 입력 중');
  expect(await stored(request, 'items', 'currency_gold', 'name')).toBe('아직 입력 중');
  expect(await stored(request, 'items', 'currency_gold', 'note')).toBe('에이전트 메모');
});

for (const choice of ['파일 값 사용', '내 입력 적용'] as const) {
  test(`same-cell external changes show both values and allow ${choice}`, async ({ page, request }) => {
    await page.goto('/?table=items');
    await edit(page, 'currency_gold', 'name', '내가 쓴 값');
    await external(request, 'items', 'currency_gold', { name: '외부 파일 값' });
    const dialog = page.getByRole('dialog', { name: '파일 변경 충돌', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('내가 쓴 값');
    await expect(dialog).toContainText('외부 파일 값');
    await dialog.getByRole('button', { name: choice, exact: true }).click();
    const expected = choice === '내 입력 적용' ? '내가 쓴 값' : '외부 파일 값';
    await expect.poll(() => stored(request, 'items', 'currency_gold', 'name')).toBe(expected);
    await expect(dialog).toHaveCount(0);
    await expect(cell(page, 'currency_gold', 'name')).toContainText(expected);
  });
}

test('a write racing an external change cannot silently overwrite the newer revision', async ({ page, request }) => {
  await page.goto('/?table=items');
  let release!: () => void;
  let submitted!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { submitted = resolve; });
  await page.route('**/__vibe/apply', async route => {
    submitted();
    await held;
    await route.continue();
  });
  const input = await edit(page, 'currency_gold', 'name', '늦게 도착한 입력');
  const response = page.waitForResponse(event => new URL(event.url()).pathname === '/__vibe/apply');
  await input.press('Enter');
  await started;
  try {
    await external(request, 'items', 'currency_gold', { name: '이미 바뀐 파일' });
  } finally {
    release();
  }
  expect(await (await response).json()).toMatchObject({ type: 'error', code: 'STALE_REVISION' });
  expect(await stored(request, 'items', 'currency_gold', 'name')).toBe('이미 바뀐 파일');
  const dialog = page.getByRole('dialog', { name: '파일 변경 충돌', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('늦게 도착한 입력');
  await expect(dialog).toContainText('이미 바뀐 파일');
  await dialog.getByRole('button', { name: '파일 값 사용', exact: true }).click();
  await expect(cell(page, 'currency_gold', 'name')).toContainText('이미 바뀐 파일');
});
