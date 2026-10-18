import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Snapshot } from '../src/protocol.js';

const cell = (page: Page, key: string, column: string) =>
  page.getByRole('gridcell', { name: `${key}/${column}`, exact: true });
const draftKey = (page: Page) => page.getByLabel('새 행 Key', { exact: true });
const undo = (page: Page) => page.getByRole('button', { name: '되돌리기', exact: true });
const redo = (page: Page) => page.getByRole('button', { name: '다시 하기', exact: true });

async function snapshot(request: APIRequestContext, table = 'items'): Promise<Snapshot> {
  const response = await request.get('/__vibe/snapshot', { params: { table } });
  expect(response.ok()).toBe(true);
  return response.json();
}

function applyResponse(page: Page) {
  return page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/__vibe/apply');
}

async function applied(page: Page, action: () => Promise<unknown>) {
  // Wait for the write itself instead of repeatedly parsing the 5,002-row fixture.
  const pending = applyResponse(page);
  await action();
  const response = await pending;
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ type: 'snapshot' });
  await expect(page.getByRole('grid')).toHaveAttribute('aria-busy', 'false');
}

async function insert(page: Page, anchor: string, direction: '위에 행 삽입' | '아래에 행 삽입') {
  await cell(page, anchor, 'code').click({ button: 'right' });
  await page.getByRole('menuitem', { name: direction, exact: true }).click();
  await expect(page.getByRole('grid').getByLabel('새 행 Key', { exact: true })).toBeVisible();
}

async function fillItem(page: Page, key: string, name = '새 아이템') {
  await draftKey(page).fill(key);
  await page.getByLabel('새 행 name', { exact: true }).fill(name);
  await page.getByLabel('새 행 kind', { exact: true }).fill('consumable');
  await page.getByLabel('새 행 note', { exact: true }).fill('00042');
}

async function confirm(page: Page) {
  await applied(page, () => page.getByRole('button', { name: '행 추가 확정', exact: true }).click());
  await expect(draftKey(page)).toHaveCount(0);
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__vibe/reset')).ok()).toBe(true);
});

test('a draft without a Key stays in the grid without changing the revision, and can be cancelled', async ({ page, request }) => {
  const initial = await snapshot(request);
  await page.goto('/?table=items');
  await insert(page, 'currency_gold', '위에 행 삽입');
  await expect(draftKey(page)).toHaveValue('');
  await page.getByLabel('새 행 name', { exact: true }).fill('Key 없는 입력');
  expect((await snapshot(request)).revision).toBe(initial.revision);

  const submit = page.getByRole('button', { name: '행 추가 확정', exact: true });
  if (await submit.isEnabled()) await submit.click();
  await expect(draftKey(page)).toHaveValue('');
  await expect(page.getByLabel('새 행 name', { exact: true })).toHaveValue('Key 없는 입력');
  const unchanged = await snapshot(request);
  expect(unchanged.revision).toBe(initial.revision);
  expect(unchanged.rows).toEqual(initial.rows);
  await expect(undo(page)).toBeDisabled();

  await page.getByRole('button', { name: '새 행 취소', exact: true }).click();
  await expect(draftKey(page)).toHaveCount(0);
  expect((await snapshot(request)).revision).toBe(initial.revision);
  await expect(undo(page)).toBeDisabled();
});

for (const scenario of [
  { direction: '위에 행 삽입', anchor: 'currency_gold', key: 'aaa_inserted' },
  { direction: '아래에 행 삽입', anchor: 'consumable_potion', key: 'zzz_inserted' },
] as const) {
  test(`${scenario.direction} shows the draft at the insertion point, then selects the row appended in file order`, async ({ page, request }) => {
    const initial = await snapshot(request);
    await page.goto('/?table=items');
    await insert(page, scenario.anchor, scenario.direction);
    const draft = page.getByRole('grid').getByRole('row').filter({ has: draftKey(page) });
    await expect(draft).toBeVisible();
    const before = (await cell(page, 'consumable_potion', 'code').boundingBox())!;
    const position = (await draft.boundingBox())!;
    const after = (await cell(page, 'currency_gold', 'code').boundingBox())!;
    expect(position.y).toBeGreaterThanOrEqual(before.y + before.height - 1);
    expect(position.y + position.height).toBeLessThanOrEqual(after.y + 1);

    await fillItem(page, scenario.key);
    expect((await snapshot(request)).revision).toBe(initial.revision);
    await confirm(page);
    const stored = await snapshot(request);
    expect(stored.rows.map(row => row.code)).toEqual([...initial.rows.map(row => String(row.code)), scenario.key]);
    expect(stored.rows.find(row => row.code === scenario.key)).toMatchObject({
      code: scenario.key, name: '새 아이템', kind: 'consumable', note: '00042',
    });
    expect(stored.revision).not.toBe(initial.revision);
    await expect(cell(page, scenario.key, 'code')).toBeVisible();
    await expect(cell(page, scenario.key, 'code')).toHaveAttribute('data-active', 'true');
    await expect(page.getByRole('status')).toContainText('파일 끝');
  });
}

test('the empty-table toolbar creates one row as one undo and redo entry', async ({ page, request }) => {
  const initial = await snapshot(request, 'offers');
  // Empty the two-row table, never the 5,002-row items fixture.
  const emptied = await request.post('/__vibe/apply', { data: {
    type: 'apply', table: 'offers', client: 'row-fixture', revision: initial.revision,
    operations: initial.rows.map(row => ({ op: 'delete', table: 'offers', key: row.sku })),
  } });
  expect(emptied.ok()).toBe(true);
  expect((await snapshot(request, 'offers')).rows).toEqual([]);
  await page.goto('/?table=offers');
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '1');
  await expect(undo(page)).toBeDisabled();
  await page.getByRole('button', { name: '행 추가', exact: true }).click();
  await expect(page.getByRole('grid').getByLabel('새 행 Key', { exact: true })).toBeVisible();
  await draftKey(page).fill('only_offer');
  await page.getByLabel('새 행 currency', { exact: true }).fill('currency_gold');
  await page.getByLabel('새 행 price', { exact: true }).fill('+001.2300E+0002');
  await page.getByLabel('새 행 count', { exact: true }).fill('00042');
  await page.getByLabel('새 행 available', { exact: true }).fill('false');
  await confirm(page);
  const created = await snapshot(request, 'offers');
  expect(created.rows).toEqual([{
    sku: 'only_offer', currency: 'currency_gold', price: '+001.2300E+0002', count: '00042', available: false,
  }]);
  await expect(cell(page, 'only_offer', 'sku')).toHaveAttribute('data-active', 'true');
  await expect(undo(page)).toBeEnabled();
  await expect(redo(page)).toBeDisabled();

  await applied(page, () => undo(page).click());
  expect((await snapshot(request, 'offers')).rows).toEqual([]);
  await expect(cell(page, 'only_offer', 'sku')).toHaveCount(0);
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toBeEnabled();

  await applied(page, () => redo(page).click());
  expect((await snapshot(request, 'offers')).rows).toEqual(created.rows);
  await expect(cell(page, 'only_offer', 'sku')).toBeVisible();
  await expect(undo(page)).toBeEnabled();
  await expect(redo(page)).toBeDisabled();
});

for (const gesture of ['Shift+click', 'drag'] as const) {
  test(`${gesture} selection survives right-click and deletes multiple rows as one undo and redo entry`, async ({ page, request }) => {
    const initial = await snapshot(request);
    const removed = ['demo_0000', 'demo_0001'];
    await page.goto('/?table=items');
    const first = cell(page, removed[0]!, 'name');
    const last = cell(page, removed[1]!, 'kind');
    if (gesture === 'Shift+click') {
      await first.click();
      await last.click({ modifiers: ['Shift'] });
    } else {
      const start = (await first.boundingBox())!;
      const end = (await last.boundingBox())!;
      await page.mouse.move(start.x + 20, start.y + 20);
      await page.mouse.down();
      await page.mouse.move(end.x + 20, end.y + 20, { steps: 5 });
      await page.mouse.up();
    }
    const selected = page.locator('[role=gridcell][aria-selected=true]');
    await expect(selected).toHaveCount(4);
    const selection = await selected.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
    await first.click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await selected.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(selection);
    await applied(page, () => page.getByRole('menuitem', { name: '행 삭제', exact: true }).click());

    const remaining = initial.rows.filter(row => !removed.includes(String(row.code)));
    expect((await snapshot(request)).rows).toEqual(remaining);
    for (const key of removed) await expect(cell(page, key, 'code')).toHaveCount(0);
    await expect(undo(page)).toBeEnabled();
    await expect(redo(page)).toBeDisabled();

    await applied(page, () => undo(page).click());
    expect((await snapshot(request)).rows).toEqual(initial.rows);
    await expect(undo(page)).toBeDisabled();
    await expect(redo(page)).toBeEnabled();

    await applied(page, () => redo(page).click());
    expect((await snapshot(request)).rows).toEqual(remaining);
    await expect(undo(page)).toBeEnabled();
    await expect(redo(page)).toBeDisabled();
  });
}

test('protected deletion preserves the file and shows the declared offer reference in the usage panel', async ({ page, request }) => {
  const initial = await snapshot(request);
  await page.goto('/?table=items');
  await cell(page, 'currency_gold', 'code').click({ button: 'right' });
  const pending = applyResponse(page);
  await page.getByRole('menuitem', { name: '행 삭제', exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ type: 'error', code: 'DELETE_RESTRICTED' });
  await expect(page.getByRole('alert')).toContainText('DELETE_RESTRICTED');
  const stored = await snapshot(request);
  expect(stored.revision).toBe(initial.revision);
  expect(stored.rows).toEqual(initial.rows);
  await expect(cell(page, 'currency_gold', 'code')).toBeVisible();
  await expect(undo(page)).toBeDisabled();
  const panel = page.getByRole('complementary', { name: '사용처', exact: true });
  await expect(panel).toBeVisible();
  const reference = panel.getByRole('region', { name: '선언된 참조', exact: true })
    .getByRole('button', { name: /offers\/bundle\/currency/ });
  await expect(reference).toBeVisible();
  await reference.click();
  await expect(cell(page, 'bundle', 'currency')).toHaveAttribute('data-active', 'true');
  expect((await snapshot(request, 'offers')).rows.find(row => row.sku === 'bundle')?.currency).toBe('currency_gold');
});

test('a rejected duplicate Key keeps every draft value for correction and retry', async ({ page, request }) => {
  const initial = await snapshot(request);
  await page.goto('/?table=items');
  await insert(page, 'currency_gold', '아래에 행 삽입');
  await fillItem(page, 'currency_gold', '수정해서 재시도');
  const pending = applyResponse(page);
  await page.getByRole('button', { name: '행 추가 확정', exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ type: 'error', code: 'NAME_EXISTS' });
  await expect(page.getByRole('alert')).toContainText('NAME_EXISTS');
  await expect(draftKey(page)).toHaveValue('currency_gold');
  await expect(page.getByLabel('새 행 name', { exact: true })).toHaveValue('수정해서 재시도');
  await expect(page.getByLabel('새 행 kind', { exact: true })).toHaveValue('consumable');
  await expect(page.getByLabel('새 행 note', { exact: true })).toHaveValue('00042');
  const unchanged = await snapshot(request);
  expect(unchanged.revision).toBe(initial.revision);
  expect(unchanged.rows).toEqual(initial.rows);
  await expect(undo(page)).toBeDisabled();

  await draftKey(page).fill('aaa_retried');
  await confirm(page);
  const stored = await snapshot(request);
  expect(stored.rows).toHaveLength(initial.rows.length + 1);
  expect(stored.rows.find(row => row.code === 'currency_gold')).toEqual(initial.rows.find(row => row.code === 'currency_gold'));
  expect(stored.rows.find(row => row.code === 'aaa_retried')).toMatchObject({
    name: '수정해서 재시도', kind: 'consumable', note: '00042',
  });
  await expect(cell(page, 'aaa_retried', 'code')).toHaveAttribute('data-active', 'true');
});

test('undo refuses to remove a newly created row that was subsequently edited outside the screen', async ({ page, request }) => {
  await page.goto('/?table=items');
  await insert(page, 'currency_gold', '아래에 행 삽입');
  await fillItem(page, 'aaa_external');
  await confirm(page);
  const external = await request.post('/__vibe/external', { data: {
    table: 'items', key: 'aaa_external', values: { name: '외부에서 바꾼 새 행', note: '외부 입력 001' },
  } });
  expect(external.ok()).toBe(true);
  await expect(cell(page, 'aaa_external', 'name')).toContainText('외부에서 바꾼 새 행');
  await expect(cell(page, 'aaa_external', 'note')).toContainText('외부 입력 001');
  const outside = await snapshot(request);

  const pending = applyResponse(page);
  await undo(page).click();
  const response = await pending;
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ type: 'error', code: 'HISTORY_CONFLICT' });
  await expect(page.getByRole('alert')).toContainText('HISTORY_CONFLICT');
  const stored = await snapshot(request);
  expect(stored.revision).toBe(outside.revision);
  expect(stored.rows).toEqual(outside.rows);
  await expect(cell(page, 'aaa_external', 'code')).toBeVisible();
  await expect(undo(page)).toBeEnabled();
  await expect(redo(page)).toBeDisabled();
});

test('undoing an inserted row also shows where-used when a later reference protects it', async ({ page, request }) => {
  await page.goto('/?table=items');
  await insert(page, 'currency_gold', '위에 행 삽입'); await fillItem(page, 'aaa_guarded'); await confirm(page);
  expect((await request.post('/__vibe/external', { data: { table: 'offers', key: 'bundle', values: { currency: 'aaa_guarded' } } })).ok()).toBe(true);
  expect((await request.post('/__vibe/external', { data: { table: 'items', key: 'currency_gold', values: { note: 'reference added' } } })).ok()).toBe(true);
  // Insertion selects the appended row; bring the watched row back into the virtual viewport.
  await page.getByTestId('grid-scroll').evaluate(element => { element.scrollTop = 0; });
  await expect(cell(page, 'currency_gold', 'note')).toContainText('reference added');
  await undo(page).click();
  await expect(page.getByRole('alert')).toContainText('DELETE_RESTRICTED');
  await expect(page.getByRole('complementary', { name: '사용처' })).toContainText('offers/bundle/currency');
  expect((await snapshot(request)).rows.some(row => row.code === 'aaa_guarded')).toBe(true);
});
