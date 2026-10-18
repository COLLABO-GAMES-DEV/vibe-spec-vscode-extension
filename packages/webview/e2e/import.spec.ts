import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Snapshot } from '../src/protocol.js';
import type { ImportHostMessage } from '../src/importProtocol.js';

const fixture = (extension: 'csv' | 'xlsx') =>
  fileURLToPath(new URL(`../../core/test/fixtures/import/items.${extension}`, import.meta.url));

async function snapshot(request: APIRequestContext, table = 'items'): Promise<Snapshot> {
  const response = await request.get('/__vibe/snapshot', { params: { table } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Snapshot>;
}

async function upload(page: Page, extension: 'csv' | 'xlsx') {
  await page.goto('/?mode=import');
  await page.getByRole('button', { name: '파일 선택', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(fixture(extension));
  await expect(page.getByRole('region', { name: '파일 조사', exact: true })).toContainText(extension.toUpperCase());
}

async function mapItems(page: Page) {
  await expect(page.getByRole('spinbutton', { name: '헤더 행', exact: true })).toHaveValue('2');
  await expect(page.getByRole('combobox', { name: '시작 열', exact: true })).toHaveValue('B');
  await expect(page.getByRole('spinbutton', { name: '데이터 시작 행', exact: true })).toHaveValue('3');
  await page.getByRole('spinbutton', { name: '헤더 행', exact: true }).fill('2');
  await page.getByRole('spinbutton', { name: '데이터 시작 행', exact: true }).fill('3');
  await page.getByRole('textbox', { name: '테이블 이름', exact: true }).fill('imported-items');
  await page.getByRole('combobox', { name: '스키마', exact: true }).selectOption('');
  await page.getByRole('textbox', { name: '스키마 이름', exact: true }).fill('imported-items');
  for (const [source, code] of Object.entries({ B: 'key', C: 'source', D: 'lore', E: 'note' })) {
    await page.getByRole('textbox', { name: `${source} 열 코드명`, exact: true }).fill(code);
  }
  await page.getByRole('radio', { name: 'B 열을 Key로 선택', exact: true }).check();
  await expect(page.getByRole('combobox', { name: 'B 열 타입', exact: true })).toHaveValue('string');
  for (const source of ['C', 'D', 'E']) {
    await expect(page.getByRole('combobox', { name: `${source} 열 타입`, exact: true })).toHaveValue('text');
  }
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__vibe/reset')).ok()).toBe(true);
});

for (const field of ['테이블 이름', '스키마 이름']) {
  test(`import ${field} displays core filename suggestions and preserves the mapping`, async ({ page, request }) => {
    const before = await snapshot(request);
    await page.goto('/?mode=import');
    await page.getByRole('button', { name: '파일 선택', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles({ name: '한글 불러오기.csv', mimeType: 'text/csv', buffer: await readFile(fixture('csv')) });
    await expect(page.getByRole('region', { name: '파일 조사', exact: true })).toContainText('한글 불러오기.csv');
    await mapItems(page);
    const input = page.getByRole('textbox', { name: field, exact: true });
    const apply = page.getByRole('button', { name: '적용', exact: true });
    for (const name of ['CON', '보상?목록', 'ITEMS']) {
      await input.fill(name);
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/__vibe/import'
        && response.request().postDataJSON()?.type === 'importPlan');
      await page.getByRole('button', { name: '미리보기', exact: true }).click();
      const result = await (await response).json() as ImportHostMessage;
      if (name === 'ITEMS') {
        expect(result.type).toBe('importState');
        if (result.type !== 'importState') throw new Error('Expected a core import plan.');
        expect(result.plan?.canApply).toBe(false);
        const issue = result.plan?.issues.find(issue => issue.code === 'IMPORT_NAME_EXISTS');
        expect(issue?.message).toContain('이름 제안:');
        await expect(page.getByRole('region', { name: '불러오기 미리보기', exact: true })).toContainText(issue!.message);
      } else {
        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('Expected a core filename error.');
        expect(result.message).toContain('이름 제안:');
        await expect(page.getByRole('alert')).toHaveText(result.code + ': ' + result.message);
      }
      await expect(input).toHaveValue(name);
      await expect(page.getByRole('textbox', { name: 'B 열 코드명', exact: true })).toHaveValue('key');
      await expect(apply).toBeDisabled();
      expect((await snapshot(request)).revision).toBe(before.revision);
    }
    await page.getByRole('textbox', { name: '테이블 이름', exact: true }).fill('불러온 보상');
    await page.getByRole('textbox', { name: '스키마 이름', exact: true }).fill('보상 스키마');
    await page.getByRole('button', { name: '미리보기', exact: true }).click();
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page.getByRole('status')).toContainText('불러오기를 적용했습니다.');
    expect((await snapshot(request, '불러온 보상')).rows.length).toBeGreaterThan(0);
  });
}

for (const extension of ['csv', 'xlsx'] as const) {
  test(`${extension}: choose a file, map B2 headers, preview without writes, then explicitly apply`, async ({ page, request }) => {
    const before = await snapshot(request);
    const expectedRows = 145; // CSV records, not physical lines: one Note contains an embedded LF.
    await upload(page, extension);
    await mapItems(page);
    const apply = page.getByRole('button', { name: '적용', exact: true });
    await expect(apply).toBeDisabled();
    const raw = page.getByRole('region', { name: '원본 값 미리보기', exact: true });
    await expect(raw).toContainText('B3');
    await expect(raw).toContainText('sample_item_001');
    await expect(raw).toContainText('합성 아이템 001');
    await expect(page.getByText('계산된 표시 후보는 서식으로 계산한 값이며 원문이 아닙니다.', { exact: false })).toBeVisible();

    await page.getByRole('button', { name: '미리보기', exact: true }).click();
    const plan = page.getByRole('region', { name: '불러오기 미리보기', exact: true });
    await expect(apply).toBeEnabled();
    await expect(plan).toContainText('tables/imported-items.yaml');
    await expect(plan).toContainText('schemas/imported-items.yaml');
    await expect(page.getByTestId('import-row-count')).toHaveText(`전체 ${expectedRows}행 · 처음 50행 미리보기`);
    const values = page.getByRole('table', { name: '적용 값 미리보기', exact: true });
    await expect(values).toContainText('B3');
    await expect(values).toContainText('합성 아이템 001');
    await expect(values.getByRole('row')).toHaveCount(51);
    expect((await snapshot(request)).revision).toBe(before.revision);
    expect((await snapshot(request)).rows).toEqual(before.rows);

    // Even reverting the draft must require a new preview before any write.
    await page.getByRole('textbox', { name: 'C 열 코드명', exact: true }).fill('source-edited');
    await expect(apply).toBeDisabled();
    await expect(plan).toContainText('미리보기를 다시 생성하세요.');
    await page.getByRole('textbox', { name: 'C 열 코드명', exact: true }).fill('source');
    await expect(apply).toBeDisabled();
    await page.getByRole('button', { name: '미리보기', exact: true }).click();
    await expect(apply).toBeEnabled();
    expect((await snapshot(request)).revision).toBe(before.revision);

    await apply.click();
    await expect(page.getByRole('status')).toContainText('불러오기를 적용했습니다.');
    await expect(page.getByRole('status')).toContainText('tables/imported-items.yaml');
    await expect(page.getByRole('status')).toContainText('schemas/imported-items.yaml');
    await expect(apply).toBeDisabled();
    const imported = await snapshot(request, 'imported-items');
    expect(imported.revision).not.toBe(before.revision);
    expect(imported.rows).toHaveLength(expectedRows);
    expect(imported.schema.primary_key).toBe('key');
    expect(Object.keys(imported.schema.columns)).toEqual(['key', 'source', 'lore', 'note']);
    expect(imported.schema.columns).toMatchObject({ key: { type: 'string' }, source: { type: 'text' },
      lore: { type: 'text' }, note: { type: 'text' } });
    expect(imported.rows.find(row => row.key === 'sample_item_001')).toMatchObject({
      key: 'sample_item_001', source: '합성 아이템 001', lore: '합성 설명 001입니다.', note: '',
    });
    expect(imported.rows.find(row => row.key === 'sample_item_004')?.lore)
      .toBe('합성 설명 004입니다. ');
    expect(imported.rows.find(row => row.key === 'sample_item_011')?.note)
      .toBe('  합성 메모 \"인용\", 구분\n두 번째 줄  ');
    expect((await snapshot(request)).rows).toEqual(before.rows);
  });
}

test('a single Key source can be changed, and duplicate mapped codes require correction', async ({ page, request }) => {
  const before = await snapshot(request);
  await upload(page, 'csv');
  await mapItems(page);
  await page.getByRole('radio', { name: 'C 열을 Key로 선택', exact: true }).check();
  await expect(page.getByRole('radio', { name: 'B 열을 Key로 선택', exact: true })).not.toBeChecked();
  await expect(page.getByRole('combobox', { name: 'C 열 타입', exact: true })).toHaveValue('string');
  await expect(page.getByRole('combobox', { name: 'B 열 타입', exact: true })).toHaveValue('text');
  await page.getByRole('radio', { name: 'B 열을 Key로 선택', exact: true }).check();
  await page.getByRole('textbox', { name: 'C 열 코드명', exact: true }).fill('key');
  await expect(page.getByRole('button', { name: '미리보기', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'C 열 코드명', exact: true }).fill('source');
  await expect(page.getByRole('button', { name: '미리보기', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '적용', exact: true })).toBeDisabled();
  expect((await snapshot(request)).revision).toBe(before.revision);
});

test('a preview arriving after a mapping edit cannot enable applying the older mapping', async ({ page, request }) => {
  const before = await snapshot(request);
  await upload(page, 'csv');
  await mapItems(page);
  let release!: () => void;
  let submitted!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { submitted = resolve; });
  await page.route('**/__vibe/import', async route => {
    if (route.request().postDataJSON().type === 'importPlan') {
      submitted();
      await held;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '미리보기', exact: true }).click();
  await started;
  try {
    await page.getByRole('textbox', { name: 'C 열 코드명', exact: true }).fill('source-edited');
    await expect(page.getByRole('button', { name: '적용', exact: true })).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole('table', { name: '적용 값 미리보기', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '적용', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: '불러오기 미리보기', exact: true }))
    .toContainText('미리보기를 다시 생성하세요.');
  expect((await snapshot(request)).revision).toBe(before.revision);
});

test('an existing schema maps its Key and is reused without adding a schema file', async ({ page, request }) => {
  const before = await snapshot(request);
  await page.goto('/?mode=import');
  await page.getByRole('button', { name: '파일 선택', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'existing.csv', mimeType: 'text/csv',
    buffer: Buffer.from('code,name,kind,note\nimported-code,원문 이름,consumable,000123.4500\n') });
  await expect(page.getByRole('spinbutton', { name: '헤더 행', exact: true })).toHaveValue('1');
  await page.getByRole('textbox', { name: '테이블 이름', exact: true }).fill('imported-existing');
  await page.getByRole('combobox', { name: '스키마', exact: true }).selectOption('items');
  await expect(page.getByRole('textbox', { name: '스키마 이름', exact: true })).toHaveCount(0);
  for (const [source, code] of Object.entries({ A: 'code', B: 'name', C: 'kind', D: 'note' })) {
    await page.getByRole('combobox', { name: `${source} 열 코드명`, exact: true }).selectOption(code);
  }
  await page.getByRole('radio', { name: 'A 열을 Key로 선택', exact: true }).check();
  await page.getByRole('button', { name: '미리보기', exact: true }).click();
  const apply = page.getByRole('button', { name: '적용', exact: true });
  await expect(apply).toBeEnabled();
  const plan = page.getByRole('region', { name: '불러오기 미리보기', exact: true });
  await expect(plan).toContainText('tables/imported-existing.yaml');
  await expect(plan).not.toContainText('schemas/items.yaml');
  expect((await snapshot(request)).revision).toBe(before.revision);
  await apply.click();
  await expect(page.getByRole('status')).toContainText('불러오기를 적용했습니다.');
  await expect(page.getByRole('status')).not.toContainText('schemas/items.yaml');
  const imported = await snapshot(request, 'imported-existing');
  expect(imported.schema).toEqual(before.schema);
  expect(imported.rows).toEqual([{ code: 'imported-code', name: '원문 이름', kind: 'consumable', note: '000123.4500' }]);
});

test('normal validation errors remain visible after a successful import', async ({ page, request }) => {
  await page.goto('/?mode=import');
  await page.getByRole('button', { name: '파일 선택', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'negative.csv', mimeType: 'text/csv', buffer: Buffer.from('Key,Price\nnew_offer,-1\n') });
  await page.getByRole('textbox', { name: '테이블 이름', exact: true }).fill('offers');
  await page.getByRole('combobox', { name: '스키마', exact: true }).selectOption('offers');
  await page.getByRole('combobox', { name: 'A 열 코드명', exact: true }).selectOption('sku');
  await page.getByRole('combobox', { name: 'B 열 코드명', exact: true }).selectOption('price');
  await page.getByRole('button', { name: '미리보기', exact: true }).click();
  await expect(page.getByRole('button', { name: '적용', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '적용', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('불러오기를 적용했습니다.');
  const diagnostics = page.getByRole('region', { name: '적용 후 검증 결과', exact: true });
  await expect(diagnostics).toContainText('offers/new_offer/price');
  await expect(diagnostics).toContainText('minimum');
  expect((await snapshot(request, 'offers')).rows.find(row => row.sku === 'new_offer')?.price).toBe('-1');
});
