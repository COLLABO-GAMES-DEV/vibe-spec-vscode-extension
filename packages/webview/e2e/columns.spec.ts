import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Column, StructurePreview } from '@vibe-spec/core';
import type { Snapshot } from '../src/protocol.js';

const columnHeader = (page: Page, column: string) => page.locator(`[role=columnheader][data-column="${column}"]`);
const cell = (page: Page, key: string, column: string) => page.getByRole('gridcell', { name: `${key}/${column}`, exact: true });
const undo = (page: Page) => page.getByRole('button', { name: '되돌리기', exact: true });
const redo = (page: Page) => page.getByRole('button', { name: '다시 하기', exact: true });

async function snapshot(request: APIRequestContext, table = 'offers'): Promise<Snapshot> {
  const response = await request.get('/__vibe/snapshot', { params: { table } });
  expect(response.ok()).toBe(true);
  return response.json();
}
function responseFor(page: Page, type: string) {
  return page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.startsWith('/__vibe/')
    && (response.request().postDataJSON() as { type?: string } | null)?.type === type);
}
async function applied(page: Page, type: string, action: () => Promise<unknown>) {
  const pending = responseFor(page, type);
  await action();
  const response = await pending;
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ type: 'snapshot' });
  await expect(page.getByRole('grid')).toHaveAttribute('aria-busy', 'false');
}
async function open(page: Page, column: string, action: string) {
  await columnHeader(page, column).click({ button: 'right' });
  await page.getByRole('menuitem', { name: action, exact: true }).click();
  return page.getByRole('dialog', { name: action.includes('삽입') ? '열 삽입' : action, exact: true });
}
async function dragBefore(page: Page, column: string, anchor: string) {
  await columnHeader(page, column).dragTo(columnHeader(page, anchor), { targetPosition: { x: 15, y: 20 } });
}
async function headerOrder(page: Page) {
  return page.getByRole('columnheader').evaluateAll(elements => elements.map(element => element.getAttribute('data-column')));
}

test.beforeEach(async ({ request }) => { expect((await request.post('/__vibe/reset')).ok()).toBe(true); });

for (const type of ['string', 'text', 'integer', 'decimal', 'boolean', 'enum', 'ref'] as const) {
  test(`inserting a ${type} column persists its definition and position without filling or changing existing rows`, async ({ page, request }) => {
    const initial = await snapshot(request);
    await page.goto('/?table=offers');
    const dialog = await open(page, 'price', '왼쪽에 열 삽입');
    await dialog.getByLabel('표시명', { exact: true }).fill('새 열');
    await dialog.getByLabel('코드명', { exact: true }).fill('new_' + type);
    await dialog.getByLabel('타입', { exact: true }).selectOption(type);
    if (type === 'enum') {
      await expect(dialog.getByRole('button', { name: '열 추가', exact: true })).toBeDisabled();
      await dialog.getByLabel('선택지 값', { exact: true }).fill('일반\n희귀\n전설');
    }
    if (type === 'ref') {
      await expect(dialog.getByRole('button', { name: '열 추가', exact: true })).toBeDisabled();
      await expect(dialog.getByLabel('대상 표', { exact: true }).getByRole('option', { name: 'items', exact: true })).toBeAttached();
      await dialog.getByLabel('대상 표', { exact: true }).selectOption('items');
    }
    await applied(page, 'structureEdit', () => dialog.getByRole('button', { name: '열 추가', exact: true }).click());
    await expect(dialog).not.toBeVisible();
    const stored = await snapshot(request);
    expect(Object.keys(stored.schema.columns)).toEqual(['sku', 'currency', 'new_' + type, 'price', 'count', 'available']);
    expect(stored.schema.columns['new_' + type]).toMatchObject({ type, label: '새 열', required: false,
      ...(type === 'enum' ? { values: ['일반', '희귀', '전설'] } : {}), ...(type === 'ref' ? { table: 'items' } : {}) });
    expect(stored.rows).toEqual(initial.rows);
    await expect(columnHeader(page, 'new_' + type)).toContainText('새 열');
    await expect(undo(page)).toBeEnabled();
    const value = { string: '한 줄 텍스트', text: '첫째 줄\n둘째 줄', integer: '00042',
      decimal: '+001.2300E+0002', boolean: 'false', enum: '희귀', ref: 'currency_gold' }[type];
    await cell(page, 'bundle', 'new_' + type).dblclick();
    await page.getByLabel('값 편집', { exact: true }).fill(value);
    await applied(page, 'apply', () => page.getByLabel('값 편집', { exact: true }).press('Enter'));
    expect((await snapshot(request)).rows.find(row => row.sku === 'bundle')?.['new_' + type]).toBe(type === 'boolean' ? false : value);
  });
}

test('Korean labels suggest unique lowercase codes and never overwrite a manually edited code', async ({ page, request }) => {
  await page.goto('/?table=offers');
  const dialog = await open(page, 'sku', '오른쪽에 열 삽입');
  const label = dialog.getByLabel('표시명', { exact: true }), code = dialog.getByLabel('코드명', { exact: true });
  await label.fill('아이템 이름');
  const suggested = await code.inputValue();
  expect(suggested).toMatch(/^[a-z0-9_]+$/);
  expect(suggested).not.toBe('column');
  await label.fill('price');
  await expect(code).toHaveValue('price_2');
  await code.fill('my_custom_code');
  await label.fill('자유로운/표시명 😊');
  await expect(code).toHaveValue('my_custom_code');
  for (const invalid of ['Upper', '한글', 'with space', 'path/name', '']) {
    await code.fill(invalid);
    await expect(dialog.getByRole('button', { name: '열 추가', exact: true })).toBeDisabled();
  }
  await code.fill('price');
  await expect(dialog).toContainText('이미 같은 코드명');
  await code.fill('my_custom_code');
  await applied(page, 'structureEdit', () => dialog.getByRole('button', { name: '열 추가', exact: true }).click());
  expect((await snapshot(request)).schema.columns.my_custom_code?.label).toBe('자유로운/표시명 😊');
  expect((await headerOrder(page)).slice(0, 3)).toEqual(['sku', 'my_custom_code', 'currency']);
});

test('adding a required column leaves old rows empty and reports their missing values, with one undo and redo entry', async ({ page, request }) => {
  const initial = await snapshot(request);
  await page.goto('/?table=offers');
  const dialog = await open(page, 'price', '오른쪽에 열 삽입');
  await dialog.getByLabel('표시명', { exact: true }).fill('담당자');
  await dialog.getByLabel('코드명', { exact: true }).fill('owner');
  await dialog.getByLabel('필수 입력', { exact: true }).check();
  await applied(page, 'structureEdit', () => dialog.getByRole('button', { name: '열 추가', exact: true }).click());
  const created = await snapshot(request);
  expect(created.rows).toEqual(initial.rows);
  expect(created.schema.columns.owner?.required).toBe(true);
  expect(created.diagnostics.map(item => item.path)).toContain('offers/bundle/owner');
  await expect(cell(page, 'bundle', 'owner')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('region', { name: '검증 오류', exact: true })).toContainText('offers/bundle/owner');
  await applied(page, 'undo', () => undo(page).click());
  expect((await snapshot(request)).schema).toEqual(initial.schema);
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toBeEnabled();
  await applied(page, 'redo', () => redo(page).click());
  expect((await snapshot(request)).schema).toEqual(created.schema);
  expect((await snapshot(request)).rows).toEqual(initial.rows);
});

test('label, type and required edits keep the original cell values and numeric spelling', async ({ page, request }) => {
  const initial = await snapshot(request);
  await page.goto('/?table=offers');
  const dialog = await open(page, 'price', '열 수정');
  await expect(dialog.getByLabel('코드명', { exact: true })).toHaveAttribute('readonly', '');
  await dialog.getByLabel('표시명', { exact: true }).fill('가격/원문 !');
  await dialog.getByLabel('타입', { exact: true }).selectOption('boolean');
  await dialog.getByLabel('필수 입력', { exact: true }).check();
  await applied(page, 'structureEdit', () => dialog.getByRole('button', { name: '변경 적용', exact: true }).click());
  const updated = await snapshot(request);
  expect(updated.schema.columns.price).toMatchObject({ label: '가격/원문 !', type: 'boolean', required: true });
  expect(updated.rows).toEqual(initial.rows);
  expect(updated.rows[0]?.price).toBe('+001.2300E+0002');
  expect(updated.rows[1]?.price).toBe('-0.000');
  await expect(cell(page, 'bundle', 'price')).toHaveAttribute('aria-invalid', 'true');
  await expect(columnHeader(page, 'price')).toContainText('가격/원문 !');
  await applied(page, 'undo', () => undo(page).click());
  expect((await snapshot(request)).schema).toEqual(initial.schema);
  expect((await snapshot(request)).rows).toEqual(initial.rows);
});

test('renaming a column updates data and declared unique fields, preserves its label, and moves active focus', async ({ page, request }) => {
  const initial = await snapshot(request);
  await page.goto('/?table=offers');
  await cell(page, 'bundle', 'price').click();
  const dialog = await open(page, 'price', '코드명 바꾸기');
  await dialog.getByLabel('코드명', { exact: true }).fill('unit_price');
  await applied(page, 'columnRename', () => dialog.getByRole('button', { name: '코드명 변경', exact: true }).click());
  const renamed = await snapshot(request);
  expect(renamed.schema.columns.unit_price).toEqual(initial.schema.columns.price);
  expect(renamed.schema.columns.price).toBeUndefined();
  expect(renamed.schema.unique).toEqual([['unit_price']]);
  expect(renamed.rows).toEqual(initial.rows.map(({ price, ...row }) => ({ ...row, unit_price: price })));
  await expect(cell(page, 'bundle', 'unit_price')).toHaveAttribute('data-active', 'true');
  await expect(page.getByLabel('선택한 칸 입력', { exact: true })).toBeFocused();
  await applied(page, 'undo', () => undo(page).click());
  expect((await snapshot(request)).schema).toEqual(initial.schema);
  await expect(cell(page, 'bundle', 'price')).toHaveAttribute('data-active', 'true');
  await applied(page, 'redo', () => redo(page).click());
  await expect(cell(page, 'bundle', 'unit_price')).toHaveAttribute('data-active', 'true');
});

test('deletion previews usages and changed files, requires confirmation, and restores data with undo', async ({ page, request }) => {
  expect((await request.post('/__vibe/external', { data: {
    table: 'items', key: 'currency_gold', values: { note: '검토: offers/*/price 원문 유지' },
  } })).ok()).toBe(true);
  const initial = await snapshot(request);
  await page.goto('/?table=offers');
  await cell(page, 'bundle', 'price').click();
  const previewResponse = responseFor(page, 'structurePreview');
  let dialog = await open(page, 'price', '열 삭제');
  expect(await (await previewResponse).json()).toMatchObject({ type: 'structurePreview' });
  await expect(dialog.getByRole('region', { name: '영향받는 표', exact: true })).toContainText('offers');
  await expect(dialog.getByRole('region', { name: '변경 파일', exact: true })).toContainText('schemas/offers.yaml');
  await expect(dialog.getByRole('region', { name: '변경 파일', exact: true })).toContainText('tables/offers.yaml');
  await expect(dialog.getByRole('region', { name: '선언된 참조', exact: true })).toContainText('unique/0/0');
  await expect(dialog.getByRole('region', { name: '본문 텍스트 후보', exact: true })).toContainText('items/currency_gold/note');
  await expect(dialog.getByRole('button', { name: '열 삭제 확정', exact: true })).toBeDisabled();
  expect((await snapshot(request)).revision).toBe(initial.revision);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect((await snapshot(request)).rows).toEqual(initial.rows);
  dialog = await open(page, 'price', '열 삭제');
  await dialog.getByLabel('열의 데이터가 삭제됨을 확인했습니다', { exact: true }).check();
  await applied(page, 'structureEdit', () => dialog.getByRole('button', { name: '열 삭제 확정', exact: true }).click());
  const deleted = await snapshot(request);
  expect(deleted.schema.columns.price).toBeUndefined();
  expect(deleted.rows).toEqual(initial.rows.map(({ price: _price, ...row }) => row));
  await expect(cell(page, 'bundle', 'count')).toHaveAttribute('data-active', 'true');
  await expect(page.getByLabel('선택한 칸 입력', { exact: true })).toBeFocused();
  await applied(page, 'undo', () => undo(page).click());
  expect((await snapshot(request)).schema).toEqual(initial.schema);
  expect((await snapshot(request)).rows).toEqual(initial.rows);
  await applied(page, 'redo', () => redo(page).click());
  expect((await snapshot(request)).rows).toEqual(deleted.rows);
});

test('Key stays fixed and cannot be deleted or have a column inserted before it', async ({ page, request }) => {
  const initial = await snapshot(request);
  await page.goto('/?table=offers');
  await expect(columnHeader(page, 'sku')).toHaveAttribute('draggable', 'false');
  await columnHeader(page, 'sku').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '왼쪽에 열 삽입', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: '열 삭제', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await dragBefore(page, 'count', 'sku');
  expect(await headerOrder(page)).toEqual(Object.keys(initial.schema.columns));
  expect((await snapshot(request)).revision).toBe(initial.revision);
  await expect(undo(page)).toBeDisabled();
});

test('dragging a header moves schema order with undo and redo while all 5002 data rows stay unchanged', async ({ page, request }) => {
  const initial = await snapshot(request, 'items');
  await page.goto('/?table=items');
  await cell(page, 'currency_gold', 'note').click();
  await applied(page, 'structureEdit', () => dragBefore(page, 'note', 'name'));
  const moved = await snapshot(request, 'items');
  expect(Object.keys(moved.schema.columns)).toEqual(['code', 'note', 'name', 'kind']);
  expect(moved.rows).toEqual(initial.rows);
  expect(moved.rows).toHaveLength(5002);
  expect(await headerOrder(page)).toEqual(['code', 'note', 'name', 'kind']);
  await expect(cell(page, 'currency_gold', 'note')).toHaveAttribute('data-active', 'true');
  await expect.poll(() => page.getByRole('grid').getByRole('row').count()).toBeLessThan(100);
  await applied(page, 'undo', () => undo(page).click());
  expect((await snapshot(request, 'items')).schema).toEqual(initial.schema);
  await applied(page, 'redo', () => redo(page).click());
  expect((await snapshot(request, 'items')).schema).toEqual(moved.schema);
  expect((await snapshot(request, 'items')).rows).toEqual(initial.rows);
});

test('numeric-only codes follow persisted column order when inserted, dragged, undone and redone', async ({ page, request }) => {
  const initial = await snapshot(request);
  await page.goto('/?table=offers');
  for (const code of ['2', '1']) {
    const dialog = await open(page, 'price', '왼쪽에 열 삽입');
    await dialog.getByLabel('표시명', { exact: true }).fill('열 ' + code);
    await dialog.getByLabel('코드명', { exact: true }).fill(code);
    await applied(page, 'structureEdit', () => dialog.getByRole('button', { name: '열 추가', exact: true }).click());
  }
  expect(await headerOrder(page)).toEqual(['sku', 'currency', '2', '1', 'price', 'count', 'available']);
  await applied(page, 'structureEdit', () => dragBefore(page, '1', '2'));
  expect(await headerOrder(page)).toEqual(['sku', 'currency', '1', '2', 'price', 'count', 'available']);
  await applied(page, 'undo', () => undo(page).click());
  expect(await headerOrder(page)).toEqual(['sku', 'currency', '2', '1', 'price', 'count', 'available']);
  await applied(page, 'redo', () => redo(page).click());
  expect(await headerOrder(page)).toEqual(['sku', 'currency', '1', '2', 'price', 'count', 'available']);
  expect((await snapshot(request)).rows).toEqual(initial.rows);
});

test('a pending cell draft commits before a column change; incomplete numeric drafts remain editable', async ({ page, request }) => {
  await page.goto('/?table=offers');
  await cell(page, 'bundle', 'price').dblclick();
  const editor = page.getByLabel('값 편집', { exact: true });
  await editor.fill('00012.5000');
  const committed = responseFor(page, 'apply');
  await columnHeader(page, 'count').click({ button: 'right' });
  expect((await committed).ok()).toBe(true);
  await expect(page.getByRole('menu', { name: '열 작업', exact: true })).toBeVisible();
  expect((await snapshot(request)).rows[0]?.price).toBe('00012.5000');
  await page.getByRole('menuitem', { name: '열 수정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '열 수정', exact: true });
  await dialog.getByLabel('표시명', { exact: true }).fill('수량');
  await applied(page, 'structureEdit', () => dialog.getByRole('button', { name: '변경 적용', exact: true }).click());
  await cell(page, 'bundle', 'price').dblclick();
  await editor.fill('1e');
  const rejected = responseFor(page, 'apply');
  await columnHeader(page, 'count').click({ button: 'right' });
  expect(await (await rejected).json()).toMatchObject({ type: 'error', code: 'INCOMPLETE_NUMBER' });
  await expect(page.getByRole('menu', { name: '열 작업', exact: true })).toHaveCount(0);
  await expect(editor).toHaveValue('1e');
  await expect(editor).toBeFocused();
  expect((await snapshot(request)).rows[0]?.price).toBe('00012.5000');
});

test('a rejected column write keeps the complete dialog draft for retry', async ({ page, request }) => {
  let reject = true;
  await page.route('**/__vibe/apply', async route => {
    const body = route.request().postDataJSON() as { type?: string; requestId?: string };
    if (body.type === 'structureEdit' && reject) {
      reject = false;
      await route.fulfill({ status: 409, json: { type: 'error', requestId: body.requestId, code: 'STALE_REVISION', message: '파일이 변경되었습니다.' } });
    } else await route.continue();
  });
  await page.goto('/?table=offers');
  const dialog = await open(page, 'price', '오른쪽에 열 삽입');
  await dialog.getByLabel('표시명', { exact: true }).fill('품질 등급');
  await dialog.getByLabel('코드명', { exact: true }).fill('grade');
  await dialog.getByLabel('타입', { exact: true }).selectOption('enum');
  await dialog.getByLabel('선택지 값', { exact: true }).fill('일반\n희귀');
  await dialog.getByLabel('필수 입력', { exact: true }).check();
  const rejected = responseFor(page, 'structureEdit');
  await dialog.getByRole('button', { name: '열 추가', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(dialog).toContainText('STALE_REVISION');
  await expect(dialog.getByLabel('표시명', { exact: true })).toHaveValue('품질 등급');
  await expect(dialog.getByLabel('코드명', { exact: true })).toHaveValue('grade');
  await expect(dialog.getByLabel('타입', { exact: true })).toHaveValue('enum');
  await expect(dialog.getByLabel('선택지 값', { exact: true })).toHaveValue('일반\n희귀');
  await expect(dialog.getByLabel('필수 입력', { exact: true })).toBeChecked();
  expect((await snapshot(request)).schema.columns.grade).toBeUndefined();
  await applied(page, 'structureEdit', () => dialog.getByRole('button', { name: '열 추가', exact: true }).click());
  expect((await snapshot(request)).schema.columns.grade).toMatchObject({ type: 'enum', values: ['일반', '희귀'], required: true });
});

for (const scenario of [
  { action: '열 수정', submit: '변경 적용', message: 'structureEdit' },
  { action: '오른쪽에 열 삽입', submit: '열 추가', message: 'structureEdit' },
  { action: '코드명 바꾸기', submit: '코드명 변경', message: 'columnRename' },
] as const) {
  test(`${scenario.action} keeps its opening revision and draft when an external label change reaches the screen`, async ({ page, request }) => {
    const initial = await snapshot(request);
    await page.goto('/?table=offers');
    const dialog = await open(page, 'price', scenario.action);
    if (scenario.message !== 'columnRename') {
      await dialog.getByLabel('표시명', { exact: true }).fill('GUI label');
      await dialog.getByLabel('타입', { exact: true }).selectOption('enum');
      await dialog.getByLabel('선택지 값', { exact: true }).fill('일반\n희귀');
      await dialog.getByLabel('필수 입력', { exact: true }).check();
    }
    if (scenario.action !== '열 수정') await dialog.getByLabel('코드명', { exact: true }).fill('draft_column');

    const externalResponse = await request.post('/__vibe/apply', { data: {
      type: 'structureEdit', table: 'offers', client: 'external-column-editor', revision: initial.revision,
      operation: { op: 'column-update', table: 'offers', column: 'price', changes: { label: 'External label' } },
    } });
    expect(externalResponse.ok()).toBe(true);
    const external = await externalResponse.json() as Snapshot;
    expect(external.revision).not.toBe(initial.revision);
    // Wait for the watched snapshot, not merely the external write's acknowledgement.
    await expect(columnHeader(page, 'price').locator('strong')).toHaveText('External label');

    // Neither the first failure nor its following snapshot may rebase the draft.
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = responseFor(page, scenario.message);
      await dialog.getByRole('button', { name: scenario.submit, exact: true }).click();
      const response = await rejected;
      expect(response.request().postDataJSON()).toMatchObject({ revision: initial.revision });
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({ type: 'error', code: 'STALE_REVISION' });
      await expect(dialog).toContainText('STALE_REVISION');
      if (scenario.message !== 'columnRename') {
        await expect(dialog.getByLabel('표시명', { exact: true })).toHaveValue('GUI label');
        await expect(dialog.getByLabel('타입', { exact: true })).toHaveValue('enum');
        await expect(dialog.getByLabel('선택지 값', { exact: true })).toHaveValue('일반\n희귀');
        await expect(dialog.getByLabel('필수 입력', { exact: true })).toBeChecked();
      }
      await expect(dialog.getByLabel('코드명', { exact: true })).toHaveValue(scenario.action === '열 수정' ? 'price' : 'draft_column');
    }
    const unchanged = await snapshot(request);
    expect(unchanged.revision).toBe(external.revision);
    expect(unchanged.schema).toEqual(external.schema);
    expect(unchanged.rows).toEqual(initial.rows);
  });
}

test('a deletion preview from a newer revision requires explicit review and fresh confirmation', async ({ page, request }) => {
  const initial = await snapshot(request);
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { arrived = resolve; });
  let first = true;
  await page.route('**/__vibe/action', async route => {
    const body = route.request().postDataJSON() as { type: string };
    if (body.type === 'structurePreview' && first) { first = false; arrived(); await held; }
    await route.continue();
  });
  await page.goto('/?table=offers');
  const pending = responseFor(page, 'structurePreview');
  const dialog = await open(page, 'price', '열 삭제');
  await started;
  let external: Snapshot;
  try {
    const response = await request.post('/__vibe/apply', { data: {
      type: 'structureEdit', table: 'offers', client: 'external-column-editor', revision: initial.revision,
      operation: { op: 'column-update', table: 'offers', column: 'price', changes: { label: 'External label' } },
    } });
    expect(response.ok()).toBe(true);
    external = await response.json() as Snapshot;
    await expect(columnHeader(page, 'price').locator('strong')).toHaveText('External label');
  } finally { release(); }
  const previewResponse = await pending;
  expect(previewResponse.ok()).toBe(true);
  expect(await previewResponse.json()).toMatchObject({ type: 'structurePreview', preview: { revision: external.revision } });
  const confirmation = dialog.getByLabel('열의 데이터가 삭제됨을 확인했습니다', { exact: true });
  await expect(dialog).toContainText('파일이 바뀌었습니다');
  await expect(confirmation).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '열 삭제 확정', exact: true })).toBeDisabled();
  expect((await snapshot(request)).schema).toEqual(external.schema);

  const refreshed = responseFor(page, 'structurePreview');
  await dialog.getByRole('button', { name: '영향 다시 확인', exact: true }).click();
  expect((await refreshed).ok()).toBe(true);
  await expect(dialog).toContainText('External label');
  await expect(confirmation).toBeEnabled();
  await expect(confirmation).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: '열 삭제 확정', exact: true })).toBeDisabled();
  await confirmation.check();
  const submitted = responseFor(page, 'structureEdit');
  await applied(page, 'structureEdit', () => dialog.getByRole('button', { name: '열 삭제 확정', exact: true }).click());
  expect((await submitted).request().postDataJSON()).toMatchObject({ revision: external.revision });
  expect((await snapshot(request)).schema.columns.price).toBeUndefined();
});

test('file changes invalidate deletion confirmation until its impact is refreshed', async ({ page, request }) => {
  await page.goto('/?table=offers');
  const dialog = await open(page, 'price', '열 삭제');
  const confirmation = dialog.getByLabel('열의 데이터가 삭제됨을 확인했습니다', { exact: true });
  await confirmation.check();
  expect((await request.post('/__vibe/external', { data: { table: 'offers', key: 'bundle', values: { price: '123.00' } } })).ok()).toBe(true);
  await expect(dialog).toContainText('파일이 바뀌었습니다');
  await expect(dialog.getByRole('button', { name: '열 삭제 확정', exact: true })).toBeDisabled();
  const refreshed = responseFor(page, 'structurePreview');
  await dialog.getByRole('button', { name: '영향 다시 확인', exact: true }).click();
  expect((await refreshed).ok()).toBe(true);
  await expect(confirmation).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: '열 삭제 확정', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect((await snapshot(request)).rows[0]?.price).toBe('123.00');
});

test('dialogs show host-provided shared-schema table and file impact before any write', async ({ page, request }) => {
  const initial = await snapshot(request);
  await page.route('**/__vibe/snapshot?table=offers*', route => route.fulfill({ json: { ...initial, schemaTables: ['offers', 'items'] } }));
  await page.route('**/__vibe/**', async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const body = route.request().postDataJSON() as { type: string; operation: StructurePreview['operation'] };
    if (body.type !== 'structurePreview') { await route.fallback(); return; }
    const preview: StructurePreview = { operation: body.operation, revision: initial.revision,
      tables: ['offers', 'items'], files: ['schemas/offers.yaml', 'tables/items.yaml', 'tables/offers.yaml'], usages: { references: [], candidates: [] } };
    await route.fulfill({ json: { type: 'structurePreview', preview } });
  });
  await page.goto('/?table=offers');
  let dialog = await open(page, 'price', '열 수정');
  await expect(dialog.getByRole('note')).toContainText('공유 스키마 영향: offers, items');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  dialog = await open(page, 'price', '열 삭제');
  await expect(dialog.getByRole('region', { name: '영향받는 표', exact: true })).toContainText('items');
  await expect(dialog.getByRole('region', { name: '변경 파일', exact: true })).toContainText('tables/items.yaml');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect((await snapshot(request)).revision).toBe(initial.revision);
});

test('legacy uppercase Key and Source codes remain editable without applying new-code validation', async ({ page, request }) => {
  const initial = await snapshot(request, 'items');
  const renamedCode = (code: string) => code === 'code' ? 'Key' : code === 'name' ? 'Source' : code;
  let current: Snapshot = { ...initial, columnOrder: (initial.columnOrder ?? Object.keys(initial.schema.columns)).map(renamedCode), schema: { ...initial.schema, primary_key: 'Key',
    columns: Object.fromEntries(Object.entries(initial.schema.columns).map(([code, definition]) => [renamedCode(code), definition])) },
    rows: initial.rows.map(row => Object.fromEntries(Object.entries(row).map(([code, value]) => [renamedCode(code), value]))) };
  await page.route('**/__vibe/snapshot?table=items*', route => route.fulfill({ json: current }));
  await page.route('**/__vibe/apply', async route => {
    const body = route.request().postDataJSON() as { type: string; requestId: string; operation: { op: string; column: string; changes: Partial<Column> } };
    expect(body.type).toBe('structureEdit');
    expect(body.operation.op).toBe('column-update');
    expect(['Key', 'Source']).toContain(body.operation.column);
    current = { ...current, revision: current.revision + '-edited', schema: { ...current.schema,
      columns: { ...current.schema.columns, [body.operation.column]: { ...current.schema.columns[body.operation.column]!, ...body.operation.changes } } } };
    await route.fulfill({ json: { ...current, requestId: body.requestId } });
  });
  await page.goto('/?table=items');
  for (const code of ['Key', 'Source']) {
    const dialog = await open(page, code, '열 수정');
    await expect(dialog.getByLabel('코드명', { exact: true })).toHaveValue(code);
    await dialog.getByLabel('표시명', { exact: true }).fill(code + '/표시명');
    if (code === 'Source') await dialog.getByLabel('타입', { exact: true }).selectOption('string');
    await applied(page, 'structureEdit', () => dialog.getByRole('button', { name: '변경 적용', exact: true }).click());
    await expect(columnHeader(page, code)).toContainText(code + '/표시명');
  }
  expect(current.rows.map(row => row.Source)).toEqual(initial.rows.map(row => row.name));
});

test('column dialogs report draftState, keep native input undo, and do not submit an IME Enter', async ({ page, request }) => {
  const initial = await snapshot(request);
  await page.addInitScript(initial => {
    const messages: { type: string; active?: boolean }[] = [];
    const bridge = window as unknown as { columnMessages: typeof messages; acquireVsCodeApi: () => unknown };
    bridge.columnMessages = messages;
    bridge.acquireVsCodeApi = () => ({ postMessage(message: { type: string; active?: boolean }) {
      messages.push(message);
      if (message.type === 'ready') queueMicrotask(() => window.postMessage(initial, '*'));
    } });
  }, initial);
  await page.goto('/?table=offers');
  const dialog = await open(page, 'price', '오른쪽에 열 삽입');
  const messages = () => page.evaluate(() => (window as unknown as { columnMessages: { type: string; active?: boolean }[] }).columnMessages);
  await expect.poll(async () => (await messages()).filter(message => message.type === 'draftState').at(-1)?.active).toBe(true);
  const label = dialog.getByLabel('표시명', { exact: true });
  await label.dispatchEvent('compositionstart');
  await label.fill('새 이름');
  await label.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
  await label.dispatchEvent('compositionend', { data: '새 이름' });
  await expect(dialog).toBeVisible();
  await expect(label).toHaveValue('새 이름');
  await label.press('ControlOrMeta+z');
  expect((await messages()).filter(message => ['structureEdit', 'columnRename', 'undo', 'redo'].includes(message.type))).toEqual([]);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect.poll(async () => (await messages()).filter(message => message.type === 'draftState').at(-1)?.active).toBe(false);
});
