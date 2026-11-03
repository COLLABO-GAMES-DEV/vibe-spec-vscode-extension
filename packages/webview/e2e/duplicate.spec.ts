import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => { await request.post('/__vibe/reset'); });

test('a duplicated table opens and edits independently using the same core write path', async ({ page, request }) => {
  const snapshot = await (await request.get('/__vibe/snapshot?table=offers')).json();
  const copied = await request.post('/__vibe/duplicate', { data: { kind: 'table', name: 'offers', to: 'offers_B', revision: snapshot.revision } });
  expect(copied.ok()).toBe(true);
  await page.goto('/?table=offers_B');
  const cell = page.getByRole('gridcell', { name: 'bundle/price', exact: true });
  await expect(cell).toContainText('+001.2300E+0002');
  await cell.dblclick();
  const input = page.getByRole('textbox', { name: '값 편집', exact: true });
  await input.fill('000.5000'); await input.press('Enter');
  await expect(cell).toContainText('000.5000');
  const original = await (await request.get('/__vibe/snapshot?table=offers')).json();
  expect(original.rows[0].price).toBe('+001.2300E+0002');
  await expect(page.getByText('기준안', { exact: true })).toHaveCount(0);
});

test('a duplicated document is freely editable, no-op save preserves bytes and the source remains unchanged', async ({ page, request }) => {
  const source = '\uFEFF# 비교\r\n\r\n첫 문단  \r\n\r\n## A안\r\n\r\n원문\r\n\r\n## B안\r\n\r\n<aside>그대로</aside>';
  const fixture = await (await request.post('/__vibe/documents/fixture', { data: { source } })).json();
  expect((await request.post('/__vibe/duplicate', { data: { kind: 'document', name: fixture.name, to: 'copy', revision: fixture.revision } })).ok()).toBe(true);
  await page.goto('/?mode=documents&document=copy');
  const editor = page.getByTestId('document-rich-editor');
  await expect(editor.getByRole('heading', { name: 'A안', exact: true })).toBeVisible();
  await expect(page.getByLabel('문서 편집 대상 선택')).toHaveCount(0);
  await expect(page.getByText('쟁점 범위 선택')).toHaveCount(0);
  const save = async () => {
    page.once('dialog', dialog => dialog.accept('합성 복제본 편집'));
    const response = page.waitForResponse(r => r.url().endsWith('/__vibe/documents') && r.request().postDataJSON()?.type === 'documentSnapshot');
    await page.getByRole('button', { name: '변경 사유와 함께 저장', exact: true }).click();
    expect((await (await response).json()).ok).toBe(true);
    await expect(page.locator('.document-save-state')).toHaveText('');
  };
  await save();
  let files = await (await request.get('/__vibe/domains/inspect')).json();
  expect(files.sources['documents/copy.md']).toBe(source);
  await editor.locator('.bn-inline-content').filter({ hasText: /^원문$/ }).fill('자유롭게 수정');
  await save();
  files = await (await request.get('/__vibe/domains/inspect')).json();
  expect(files.sources['documents/copy.md']).toBe(source.replace('원문', '자유롭게 수정'));
  expect(files.sources['documents/' + fixture.name + '.md']).toBe(source);
});
