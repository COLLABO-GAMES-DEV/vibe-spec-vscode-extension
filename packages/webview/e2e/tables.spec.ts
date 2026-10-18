import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { tableNameError } from '@vibe-spec/core/names';
import type { Snapshot } from '../src/protocol.js';
import type { TablesClientMessage, TablesHostMessage, TablesMode } from '../src/tablesProtocol.js';

async function snapshot(request: APIRequestContext, table = 'items'): Promise<Snapshot> {
  const response = await request.get('/__vibe/snapshot', { params: { table } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Snapshot>;
}

async function expectMissing(request: APIRequestContext, table: string) {
  const response = await request.get('/__vibe/snapshot', { params: { table } });
  expect(response.ok()).toBe(false);
  expect(await response.json()).toMatchObject({ type: 'error', code: 'PATH_NOT_FOUND' });
}

async function schemas(request: APIRequestContext): Promise<string[]> {
  // The existing import inspection exposes schema names without changing files.
  const response = await request.post('/__vibe/import', { data: { type: 'ready' } });
  expect(response.ok()).toBe(true);
  const state = await response.json() as { type: string; schemas: Record<string, unknown> };
  expect(state.type).toBe('importState');
  return Object.keys(state.schemas);
}

async function openTables(page: Page, action: TablesMode, table?: string) {
  const query = new URLSearchParams({ mode: 'tables', action, ...(table ? { table } : {}) });
  await page.goto('/?' + query);
  await expect(page.getByRole('heading', { level: 1, name: {
    list: '테이블', create: '새 테이블 만들기', rename: '테이블 이름 바꾸기', delete: '테이블 삭제',
  }[action], exact: true })).toBeVisible();
}

const tableRow = (page: Page, name: string) => page.getByRole('table', { name: '테이블 목록', exact: true })
  .getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
const createButton = (page: Page) => page.getByRole('button', { name: '새 테이블 만들기', exact: true });
const deleteButton = (page: Page) => page.getByRole('button', { name: '테이블 삭제', exact: true });
const confirmation = (page: Page) => page.getByRole('checkbox', { name: '삭제할 내용을 확인했습니다', exact: true });
const nameInput = (page: Page) => page.getByRole('textbox', { name: '테이블 이름', exact: true });
const keyLabel = (page: Page) => page.getByRole('textbox', { name: 'Key 표시명', exact: true });
const keyCode = (page: Page) => page.getByRole('textbox', { name: 'Key 코드명', exact: true });
const tablesRequest = (page: Page, type: TablesClientMessage['type']) => page.waitForRequest(request =>
  new URL(request.url()).pathname === '/__vibe/tables' && request.method() === 'POST'
  && (request.postDataJSON() as TablesClientMessage).type === type);
const previewResponse = (page: Page) => page.waitForResponse(response =>
  new URL(response.url()).pathname === '/__vibe/tables' && response.request().method() === 'POST'
  && (response.request().postDataJSON() as TablesClientMessage).type === 'tablePreviewDelete');

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__vibe/reset')).ok()).toBe(true);
});

test('list shows row counts, and creating a table immediately opens an empty grid with its Key header', async ({ page, request }) => {
  const before = await snapshot(request);
  await openTables(page, 'list');
  await expect(tableRow(page, 'items')).toContainText('5,002행');
  await expect(tableRow(page, 'offers')).toContainText('2행');
  await createButton(page).click();
  await expect(keyLabel(page)).toHaveValue('Key');
  await expect(keyCode(page)).toHaveValue('key');
  await expect(createButton(page)).toBeDisabled();
  await nameInput(page).fill('quests');
  const sent = tablesRequest(page, 'tableCreate');
  await createButton(page).click();
  expect((await sent).postDataJSON()).toMatchObject({ type: 'tableCreate', revision: before.revision,
    table: 'quests', key: { label: 'Key', code: 'key' } });
  await expect(page).toHaveURL(/\?table=quests$/);
  await expect(page.getByRole('heading', { level: 1, name: 'quests', exact: true })).toBeVisible();
  const grid = page.getByRole('grid', { name: 'quests 테이블', exact: true });
  await expect(grid).toHaveAttribute('aria-rowcount', '1');
  await expect(grid.getByRole('columnheader')).toHaveCount(1);
  await expect(grid.getByRole('columnheader')).toContainText('Key');
  await expect(grid.getByRole('columnheader')).toHaveAttribute('data-column', 'key');
  await expect(page.getByText('0 / 0행', { exact: true })).toBeVisible();
  const created = await snapshot(request, 'quests');
  expect(created.rows).toEqual([]);
  expect(created.schema).toMatchObject({ primary_key: 'key', columns: { key: { type: 'string', label: 'Key' } } });
  expect(Object.keys(created.schema.columns)).toEqual(['key']);
  expect(created.diagnostics).toEqual([]);
  expect((await snapshot(request)).rows).toEqual(before.rows);
});

test('list opens an existing table', async ({ page }) => {
  await openTables(page, 'list');
  await tableRow(page, 'offers').getByRole('button', { name: '열기', exact: true }).click();
  await expect(page).toHaveURL(/\?table=offers$/);
  await expect(page.getByRole('grid', { name: 'offers 테이블', exact: true })).toBeVisible();
});

test('name and Key code rules validate immediately against every existing table', async ({ page, request }) => {
  const before = await snapshot(request);
  const creates: unknown[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/__vibe/tables' && request.method() === 'POST'
      && (request.postDataJSON() as TablesClientMessage).type === 'tableCreate') creates.push(request.postDataJSON());
  });
  await openTables(page, 'create');
  await expect(page.getByText('테이블 이름을 입력해 주세요.', { exact: true })).toBeVisible();
  for (const name of ['items', 'offers']) {
    await nameInput(page).fill(name);
    await expect(nameInput(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(tableNameError(name, ['items', 'offers'])!, { exact: true })).toBeVisible();
    await expect(createButton(page)).toBeDisabled();
  }
  await nameInput(page).fill('items/new');
  await expect(page.getByText(tableNameError('items/new', ['items', 'offers'])!, { exact: true })).toBeVisible();
  await expect(createButton(page)).toBeDisabled();
  await nameInput(page).fill('items-new');
  await expect(nameInput(page)).toHaveAttribute('aria-invalid', 'false');
  for (const code of ['Key', '키', 'key-code', 'key code', '']) {
    await keyCode(page).fill(code);
    await expect(keyCode(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('영문 소문자, 숫자, _만 사용할 수 있습니다.', { exact: true })).toBeVisible();
    await expect(createButton(page)).toBeDisabled();
  }
  await keyCode(page).fill('key_2');
  await expect(keyCode(page)).toHaveAttribute('aria-invalid', 'false');
  await expect(createButton(page)).toBeEnabled();
  expect(creates).toEqual([]);
  expect((await snapshot(request)).revision).toBe(before.revision);
});

test('Key display names suggest romanized codes and preserve a manually edited code', async ({ page, request }) => {
  await openTables(page, 'create');
  await nameInput(page).fill('quests');
  await keyLabel(page).fill('아이템 코드');
  await expect(keyCode(page)).toHaveValue(/^[a-z0-9_]+$/);
  expect(await keyCode(page).inputValue()).not.toBe('key');
  expect(await keyCode(page).inputValue()).not.toBe('column');
  await keyCode(page).fill('quest_id');
  await keyLabel(page).fill('퀘스트 이름');
  await expect(keyCode(page)).toHaveValue('quest_id');
  await createButton(page).click();
  await expect(page).toHaveURL(/\?table=quests$/);
  await expect(page.getByRole('columnheader').filter({ hasText: '퀘스트 이름' })).toHaveAttribute('data-column', 'quest_id');
  expect((await snapshot(request, 'quests')).schema).toMatchObject({ primary_key: 'quest_id',
    columns: { quest_id: { type: 'string', label: '퀘스트 이름' } } });
});

for (const mode of ['create', 'rename'] as const) {
  test(`${mode} shows core Windows filename suggestions and accepts Korean names`, async ({ page, request }) => {
    const before = await snapshot(request);
    await openTables(page, mode, mode === 'rename' ? 'items' : undefined);
    const submit = page.getByRole('button', { name: mode === 'create' ? '새 테이블 만들기' : '이름 바꾸기', exact: true });
    const existing = mode === 'rename' ? ['offers'] : ['items', 'offers'];
    for (const name of ['CON', 'nul.txt', 'LPT1', '이름.', '이름 ', '보상:목록', '보상\\목록', '보상?목록', 'OFFERS']) {
      await nameInput(page).fill(name);
      const message = tableNameError(name, existing)!;
      expect(message).toContain('이름 제안:');
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await expect(nameInput(page)).toHaveAttribute('aria-invalid', 'true');
      await expect(submit).toBeDisabled();
    }
    expect((await snapshot(request)).revision).toBe(before.revision);
    const name = mode === 'create' ? '한글 보상 목록' : '한글 재화 목록';
    await nameInput(page).fill(name);
    await expect(nameInput(page)).toHaveAttribute('aria-invalid', 'false');
    await submit.click();
    await expect(page.getByRole('grid', { name: name + ' 테이블', exact: true })).toBeVisible();
    expect((await snapshot(request, name)).rows).toEqual(mode === 'create' ? [] : before.rows);
    if (mode === 'rename') {
      expect((await snapshot(request, 'offers')).schema.columns.currency?.table).toBe(name);
    }
  });
}

test('rename excludes the current name from duplicate checks and updates the offers reference', async ({ page, request }) => {
  const itemsBefore = await snapshot(request);
  const offersBefore = await snapshot(request, 'offers');
  await openTables(page, 'list');
  await tableRow(page, 'items').getByRole('button', { name: '이름 바꾸기', exact: true }).click();
  await expect(nameInput(page)).toHaveValue('items');
  await expect(nameInput(page)).toHaveAttribute('aria-invalid', 'false');
  const rename = page.getByRole('button', { name: '이름 바꾸기', exact: true });
  await expect(rename).toBeDisabled();
  await nameInput(page).fill('offers');
  await expect(page.getByText(tableNameError('offers', ['offers'])!, { exact: true })).toBeVisible();
  await expect(rename).toBeDisabled();
  await nameInput(page).fill('resources');
  const sent = tablesRequest(page, 'tableRename');
  await rename.click();
  expect((await sent).postDataJSON()).toMatchObject({ type: 'tableRename', revision: itemsBefore.revision,
    table: 'items', to: 'resources' });
  await expect(page).toHaveURL(/\?table=resources$/);
  await expect(page.getByRole('grid', { name: 'resources 테이블', exact: true })).toBeVisible();
  expect((await snapshot(request, 'resources')).rows).toEqual(itemsBefore.rows);
  const offers = await snapshot(request, 'offers');
  expect(offers.schema.columns.currency).toMatchObject({ type: 'ref', table: 'resources', on_delete: 'restrict' });
  expect(offers.rows).toEqual(offersBefore.rows);
  expect(offers.references.currency).toEqual(offersBefore.references.currency);
  expect(offers.diagnostics).toEqual(offersBefore.diagnostics);
  await expectMissing(request, 'items');
});

test('deleting items is blocked and shows both schema and row usages without writes', async ({ page, request }) => {
  const before = await snapshot(request);
  await openTables(page, 'delete', 'items');
  await expect(page.getByRole('alert').filter({ hasText: '삭제할 수 없습니다' })).toBeVisible();
  const references = page.getByRole('region', { name: '선언된 참조', exact: true });
  await expect(references).toContainText('schemas/offers.yaml');
  await expect(references).toContainText('columns/currency/table');
  await expect(references).toContainText('tables/offers.yaml');
  await expect(references).toContainText('offers/bundle/currency');
  await expect(page.getByRole('region', { name: '영향받는 파일', exact: true })).toContainText('tables/items.yaml');
  await expect(confirmation(page)).toBeDisabled();
  await expect(deleteButton(page)).toBeDisabled();
  expect((await snapshot(request)).revision).toBe(before.revision);
  expect((await snapshot(request)).rows).toHaveLength(5002);
});

test('offers deletion requires the preview, checkbox and explicit delete button', async ({ page, request }) => {
  const before = await snapshot(request);
  await openTables(page, 'list');
  const planned = previewResponse(page);
  await tableRow(page, 'offers').getByRole('button', { name: '테이블 삭제', exact: true }).click();
  const preview = await (await planned).json() as Extract<TablesHostMessage, { type: 'tablesState' }>;
  expect(preview.preview?.blocked).toBeUndefined();
  expect(preview.preview?.revision).toBe(before.revision);
  const files = page.getByRole('region', { name: '영향받는 파일', exact: true });
  await expect(files).toContainText('tables/offers.yaml');
  await expect(files).toContainText('schemas/offers.yaml');
  await expect(confirmation(page)).toBeEnabled();
  await expect(deleteButton(page)).toBeDisabled();
  await confirmation(page).check();
  await expect(deleteButton(page)).toBeEnabled();
  expect((await snapshot(request, 'offers')).rows).toHaveLength(2);
  await confirmation(page).uncheck();
  await expect(deleteButton(page)).toBeDisabled();
  await confirmation(page).check();
  const sent = tablesRequest(page, 'tableDelete');
  await deleteButton(page).click();
  expect((await sent).postDataJSON()).toMatchObject({ type: 'tableDelete', table: 'offers',
    revision: preview.preview!.revision, confirmed: true });
  await expect(page.getByRole('heading', { level: 1, name: '테이블', exact: true })).toBeVisible();
  await expect(tableRow(page, 'offers')).toHaveCount(0);
  await expectMissing(request, 'offers');
  expect((await snapshot(request)).rows).toEqual(before.rows);
});

test('deleting a newly created table removes its otherwise unused schema', async ({ page, request }) => {
  await openTables(page, 'create');
  await nameInput(page).fill('scratch');
  await createButton(page).click();
  await expect(page).toHaveURL(/\?table=scratch$/);
  expect((await snapshot(request, 'scratch')).rows).toEqual([]);
  expect(await schemas(request)).toContain('scratch');
  await openTables(page, 'delete', 'scratch');
  const files = page.getByRole('region', { name: '영향받는 파일', exact: true });
  await expect(files).toContainText('tables/scratch.yaml');
  await expect(files).toContainText('schemas/scratch.yaml');
  await confirmation(page).check();
  await deleteButton(page).click();
  await expect(page.getByRole('heading', { level: 1, name: '테이블', exact: true })).toBeVisible();
  await expectMissing(request, 'scratch');
  expect(await schemas(request)).not.toContain('scratch');
});

test('a change to another file invalidates deletion and requires a new preview and confirmation', async ({ page, request }) => {
  const before = await snapshot(request);
  await openTables(page, 'delete', 'offers');
  await confirmation(page).check();
  await expect(deleteButton(page)).toBeEnabled();
  const changed = await request.post('/__vibe/external', { data: { table: 'items', key: 'currency_gold',
    values: { note: '삭제 확인 뒤 다른 파일 변경' } } });
  expect(changed.ok()).toBe(true);
  const current = await snapshot(request);
  expect(current.revision).not.toBe(before.revision);
  await expect(page.getByRole('alert').filter({ hasText: '파일이 변경되었습니다.' })).toBeVisible();
  await expect(confirmation(page)).not.toBeChecked();
  await expect(confirmation(page)).toBeDisabled();
  await expect(deleteButton(page)).toBeDisabled();
  const planned = previewResponse(page);
  await page.getByRole('button', { name: '삭제 내용 다시 확인', exact: true }).click();
  const preview = await (await planned).json() as Extract<TablesHostMessage, { type: 'tablesState' }>;
  expect(preview.preview?.revision).toBe(current.revision);
  await expect(confirmation(page)).toBeEnabled();
  await expect(deleteButton(page)).toBeDisabled();
  await confirmation(page).check();
  const sent = tablesRequest(page, 'tableDelete');
  await deleteButton(page).click();
  expect((await sent).postDataJSON()).toMatchObject({ type: 'tableDelete', revision: current.revision, confirmed: true });
  await expect(page.getByRole('heading', { level: 1, name: '테이블', exact: true })).toBeVisible();
  await expectMissing(request, 'offers');
  expect((await snapshot(request)).rows.find(row => row.code === 'currency_gold')?.note).toBe('삭제 확인 뒤 다른 파일 변경');
});

test('failed submissions preserve the draft and show local validation alongside the server error', async ({ page, request }) => {
  const before = await snapshot(request);
  await page.route('**/__vibe/tables', async route => {
    if ((route.request().postDataJSON() as TablesClientMessage).type === 'tableCreate') {
      await route.fulfill({ status: 409, json: { type: 'error', code: 'NAME_EXISTS', message: '서버에서 확인한 중복 이름입니다.' } });
    } else await route.continue();
  });
  await openTables(page, 'create');
  await nameInput(page).fill('draft-table');
  await keyLabel(page).fill('내 Key');
  await keyCode(page).fill('custom_key');
  await createButton(page).click();
  const serverError = page.getByRole('alert').filter({ hasText: 'NAME_EXISTS: 서버에서 확인한 중복 이름입니다.' });
  await expect(serverError).toBeVisible();
  await expect(nameInput(page)).toHaveValue('draft-table');
  await expect(keyLabel(page)).toHaveValue('내 Key');
  await expect(keyCode(page)).toHaveValue('custom_key');
  await nameInput(page).fill('items/invalid');
  await expect(page.getByText(tableNameError('items/invalid', ['items', 'offers'])!, { exact: true })).toBeVisible();
  await expect(serverError).toBeVisible();
  await expect(createButton(page)).toBeDisabled();
  await nameInput(page).fill('draft-table-fixed');
  await expect(createButton(page)).toBeEnabled();
  await expect(serverError).toBeVisible();
  expect((await snapshot(request)).revision).toBe(before.revision);
});
