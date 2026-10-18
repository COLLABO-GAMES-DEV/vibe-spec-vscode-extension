import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ImportMapping, TableSchema } from '@vibe-spec/core';
import type { ImportHostMessage } from '../src/importProtocol.js';
import type { Snapshot } from '../src/protocol.js';

// Reuse core's installed XLSX fixture writer; no browser or package dependency.
const XLSX = createRequire(new URL('../../core/package.json', import.meta.url))('xlsx');
const cell = (page: Page, key: string, column: string) => page.getByRole('gridcell', { name: `${key}/${column}`, exact: true });
const keyCells = (page: Page) => page.locator('.grid-row .key-cell');

function integerWorkbook(): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['placeholder']]), 'Data');
  const zip = XLSX.CFB.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  // Raw numeric XML is deliberate: a JS number/XLSX writer would erase .0.
  const rows = ['10.0', '2.0', '1.0'].map((raw, index) => `<row r="${index + 2}">
    <c r="A${index + 2}" t="n"><v>${raw}</v></c>
    <c r="B${index + 2}" t="inlineStr"><is><t>1.0</t></is></c></row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
    <dimension ref="A1:B4"/><sheetData><row r="1">
    <c r="A1" t="inlineStr"><is><t>level</t></is></c>
    <c r="B1" t="inlineStr"><is><t>note</t></is></c></row>${rows}</sheetData></worksheet>`;
  XLSX.CFB.utils.cfb_add(zip, '/xl/worksheets/sheet1.xml', Buffer.from(sheet));
  return XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' }) as Buffer;
}

async function snapshot(request: APIRequestContext, table = 'levels'): Promise<Snapshot> {
  const response = await request.get('/__vibe/snapshot', { params: { table } });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function importCsv(request: APIRequestContext, table: string, csv: string, definition: TableSchema) {
  const send = async (data: Record<string, unknown>) => {
    const response = await request.post('/__vibe/import', { data: { client: table, ...data } });
    expect(response.ok()).toBe(true);
    const result = await response.json() as ImportHostMessage;
    expect(result.type).toBe('importState');
    if (result.type !== 'importState') throw new Error(result.message);
    return result;
  };
  const uploaded = await send({ type: 'upload', name: table + '.csv', content: Buffer.from(csv).toString('base64') });
  const sheet = uploaded.inspection!.sheets[0]!;
  const mapping: ImportMapping = { table, schema: table, sheet: sheet.name, header_row: 1, data_start_row: 2,
    numeric: 'stored', definition, columns: Object.fromEntries(sheet.columns.map((source, index) =>
      [source, Object.keys(definition.columns)[index]!])) };
  const planned = await send({ type: 'importPlan', mapping });
  expect(planned.plan?.canApply).toBe(true);
  await send({ type: 'importApply', revision: planned.revision });
}
async function levels(request: APIRequestContext, csv = 'level,note\n10,ten\n2,two\n1,one\n') {
  await importCsv(request, 'levels', csv, { primary_key: 'level', columns: {
    level: { type: 'integer', required: true }, note: { type: 'text' },
  } });
}
async function applied(page: Page, type: string, action: () => Promise<unknown>) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/__vibe/apply'
    && response.request().postDataJSON()?.type === type);
  await action();
  const response = await pending;
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ type: 'snapshot' });
  await expect(page.getByRole('grid')).toHaveAttribute('aria-busy', 'false');
}
async function upload(page: Page, name: string, buffer: Buffer) {
  await page.goto('/?mode=import');
  await page.getByRole('button', { name: '파일 선택', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: name.endsWith('.xlsx')
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv', buffer });
  await expect(page.getByRole('region', { name: '파일 조사', exact: true })).toContainText(name);
}

test.beforeEach(async ({ request }) => { expect((await request.post('/__vibe/reset')).ok()).toBe(true); });

test('XLSX numeric integers infer an integer Key, retain raw provenance and preserve text 1.0', async ({ page, request }) => {
  await upload(page, 'integer.xlsx', integerWorkbook());
  await expect(page.getByLabel('A 열 타입', { exact: true })).toHaveValue('integer');
  await expect(page.getByLabel('B 열 타입', { exact: true })).toHaveValue('text');
  await expect(page.getByLabel('A 열 타입', { exact: true }).locator('option')).toHaveText(['string', 'text', 'integer']);
  await page.getByRole('textbox', { name: '테이블 이름', exact: true }).fill('levels');
  await page.getByRole('textbox', { name: '스키마 이름', exact: true }).fill('levels');
  const raw = page.getByRole('region', { name: '원본 값 미리보기', exact: true });
  const numeric = raw.locator('td').filter({ has: page.locator('code').filter({ hasText: /^A4$/ }) });
  await expect(numeric).toContainText('1.0');
  await expect(numeric).toContainText('정수로 가져올 값: 1');
  await expect(page.getByLabel('A4 숫자 표현', { exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: '계산된 표시 후보', exact: true }).check();
  await expect(page.getByLabel('A 열 타입', { exact: true })).toHaveValue('integer');
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/__vibe/import'
    && response.request().postDataJSON()?.type === 'importPlan');
  await page.getByRole('button', { name: '미리보기', exact: true }).click();
  const result = await (await pending).json() as ImportHostMessage;
  if (result.type !== 'importState') throw new Error(result.message);
  expect(result.plan?.mapping.definition?.columns.level?.type).toBe('integer');
  expect(result.plan?.normalizations).toEqual(expect.arrayContaining([{ cell: 'A4', column: 'level', raw: '1.0', value: '1' }]));
  expect(result.plan?.rows.map(row => row.values)).toEqual([
    { level: '10', note: '1.0' }, { level: '2', note: '1.0' }, { level: '1', note: '1.0' },
  ]);
  const preview = page.getByRole('table', { name: '적용 값 미리보기', exact: true });
  await expect(preview).toContainText('정수 정규화: 1');
  await expect(preview).toContainText('저장 원문: 1.0');
  await page.getByRole('button', { name: '적용', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('불러오기를 적용했습니다.');
  const stored = await snapshot(request);
  expect(stored.rows).toEqual(result.plan!.rows.map(row => row.values));
  expect(stored.schema.columns.level?.type).toBe('integer');
  await page.goto('/?table=levels');
  await expect(keyCells(page)).toHaveText(['10', '2', '1']);
  await expect(cell(page, '1', 'note')).toHaveText('1.0');
});

test('integer Key sorting preserves file order, edits and reference addresses', async ({ page, request }) => {
  await levels(request);
  await importCsv(request, 'rewards', 'code,level\nreward,2\n', { primary_key: 'code', columns: {
    code: { type: 'string', required: true }, level: { type: 'ref', table: 'levels' },
  } });
  await page.goto('/?table=levels');
  const original = await snapshot(request);
  await expect(page.getByLabel('정렬 열', { exact: true })).toHaveValue('');
  await expect(keyCells(page)).toHaveText(['10', '2', '1']);
  await page.getByLabel('정렬 열', { exact: true }).selectOption('level');
  await expect(keyCells(page)).toHaveText(['1', '2', '10']);
  expect((await snapshot(request)).revision).toBe(original.revision);
  await cell(page, '2', 'note').dblclick();
  await page.getByLabel('값 편집', { exact: true }).fill('edited two');
  await applied(page, 'apply', () => page.getByLabel('값 편집', { exact: true }).press('Enter'));
  const edited = await snapshot(request);
  expect(edited.rows.map(row => row.level)).toEqual(['10', '2', '1']);
  expect(edited.rows.find(row => row.level === '2')?.note).toBe('edited two');
  await page.getByRole('button', { name: '보기 초기화', exact: true }).click();
  await expect(keyCells(page)).toHaveText(['10', '2', '1']);
  await page.goto('/?table=rewards');
  await cell(page, 'reward', 'level').click({ modifiers: ['Control'] });
  await expect(page.getByRole('heading', { name: 'levels', exact: true })).toBeVisible();
  await expect(cell(page, '2', 'level')).toHaveAttribute('data-active', 'true');
  await cell(page, '2', 'level').dblclick();
  await page.getByLabel('값 편집', { exact: true }).fill('3');
  await applied(page, 'rename', () => page.getByLabel('값 편집', { exact: true }).press('Enter'));
  expect((await snapshot(request)).rows.map(row => row.level)).toEqual(['10', '3', '1']);
  expect((await snapshot(request, 'rewards')).rows[0]?.level).toBe('3');
  await page.goto('/?table=rewards');
  await cell(page, 'reward', 'level').click({ modifiers: ['Control'] });
  await expect(cell(page, '3', 'level')).toHaveAttribute('data-active', 'true');
});

test('integer Key sorting compares values beyond Number precision exactly', async ({ page, request }) => {
  await levels(request, 'level,note\n900719925474099312346,bigger\n900719925474099312345,smaller\n-10,negative\n');
  await page.goto('/?table=levels');
  await expect(keyCells(page)).toHaveText(['900719925474099312346', '900719925474099312345', '-10']);
  await page.getByLabel('정렬 열', { exact: true }).selectOption('level');
  await expect(keyCells(page)).toHaveText(['-10', '900719925474099312345', '900719925474099312346']);
  await page.getByLabel('정렬 방향', { exact: true }).selectOption('desc');
  await expect(keyCells(page)).toHaveText(['900719925474099312346', '900719925474099312345', '-10']);
});

test('Key column type can change among string, text and integer while deletion stays protected', async ({ page, request }) => {
  await levels(request);
  await page.goto('/?table=levels');
  const original = await snapshot(request);
  for (const type of ['text', 'string', 'integer']) {
    await page.locator('[role=columnheader][data-column="level"]').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: '열 삭제', exact: true })).toBeDisabled();
    await page.getByRole('menuitem', { name: '열 수정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '열 수정', exact: true });
    await expect(dialog.getByLabel('타입', { exact: true }).locator('option')).toHaveCount(3);
    await expect(dialog.getByLabel('필수 입력', { exact: true })).toBeChecked();
    await expect(dialog.getByLabel('필수 입력', { exact: true })).toBeDisabled();
    await dialog.getByLabel('타입', { exact: true }).selectOption(type);
    await applied(page, 'structureEdit', () => dialog.getByRole('button', { name: '변경 적용', exact: true }).click());
    await expect(dialog).not.toBeVisible();
    const stored = await snapshot(request);
    expect(stored.schema.columns.level).toMatchObject({ type, required: true });
    expect(stored.rows).toEqual(original.rows);
  }
});

test('range remapping refreshes suggestions and preserves manually chosen types and existing schemas', async ({ page }) => {
  await upload(page, 'ranges.csv', Buffer.from('level,note\nheading,mixed\n10,10\n2,2\n1,1\n'));
  await expect(page.getByLabel('A 열 타입', { exact: true })).toHaveValue('string');
  await page.getByRole('spinbutton', { name: '데이터 시작 행', exact: true }).fill('3');
  await expect(page.getByLabel('A 열 타입', { exact: true })).toHaveValue('integer');
  await expect(page.getByLabel('B 열 타입', { exact: true })).toHaveValue('integer');
  await page.getByLabel('B 열 타입', { exact: true }).selectOption('text');
  await page.getByRole('radio', { name: 'B 열을 Key로 선택', exact: true }).check();
  await expect(page.getByLabel('B 열 타입', { exact: true })).toHaveValue('text');
  await page.getByRole('spinbutton', { name: '데이터 시작 행', exact: true }).fill('2');
  await expect(page.getByLabel('A 열 타입', { exact: true })).toHaveValue('text');
  await page.getByRole('spinbutton', { name: '데이터 시작 행', exact: true }).fill('3');
  await page.getByRole('spinbutton', { name: '헤더 행', exact: true }).fill('2');
  await page.getByRole('radio', { name: '계산된 표시 후보', exact: true }).check();
  await expect(page.getByLabel('A 열 타입', { exact: true })).toHaveValue('integer');
  await expect(page.getByLabel('B 열 타입', { exact: true })).toHaveValue('text');
  await page.getByRole('combobox', { name: '스키마', exact: true }).selectOption('offers');
  await page.getByLabel('A 열 코드명', { exact: true }).selectOption('sku');
  await page.getByLabel('B 열 코드명', { exact: true }).selectOption('price');
  await expect(page.getByLabel('A 열 타입', { exact: true })).toHaveCount(0);
  const mapping = page.getByRole('table', { name: '열 매핑', exact: true });
  await expect(mapping.getByRole('row').nth(1)).toContainText('string');
  await expect(mapping.getByRole('row').nth(2)).toContainText('decimal');
});
