import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
const name = '기획 문서';
const source = '\uFEFF# Intro\r\n \r\n<!-- name: note -->\r\n원문\r\n\r\n## Debate\r\n\r\n선택 내용\r\n\r\n# Outside\r\n\r\n그대로  ';
const rich = (page: Page) => page.getByTestId('document-rich-editor');
async function api(request: APIRequestContext, body: Record<string, unknown>, client = 'variant-inspection') {
  const response = await request.post('/__vibe/documents', { data: { ...body, client } });
  const data = await response.json(); expect(data.type, JSON.stringify(data)).not.toBe('error'); return data;
}
async function save(page: Page) {
  page.once('dialog', dialog => dialog.accept('합성 문서 대안 검증'));
  const response = page.waitForResponse(r => r.url().endsWith('/__vibe/documents') && r.request().postDataJSON()?.type === 'documentSnapshot');
  await page.getByRole('button', { name: '변경 사유와 함께 저장', exact: true }).click();
  expect((await (await response).json()).ok).toBe(true);
  await expect(page.locator('.document-save-state')).toHaveText('');
}
test.beforeEach(async ({ request }) => {
  await request.post('/__vibe/reset');
  expect((await request.post('/__vibe/documents/fixture', { data: { source, variants: true } })).ok()).toBe(true);
});
test('selects a paragraph scope, saves only its alternative, detects changed baseline and approves without touching surrounding bytes', async ({ page, request }) => {
  await page.goto('/?mode=documents&document=' + encodeURIComponent(name));
  await expect(rich(page)).toHaveAttribute('contenteditable', 'true');
  await page.getByLabel('문서 편집 대상 선택').selectOption('document-review/A');
  await page.getByRole('checkbox', { name: name + '/Intro/note (이름표 문단)', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: name + '/Intro/note (이름표 문단)', exact: true })).toBeChecked();
  await rich(page).locator('.bn-inline-content').filter({ hasText: /^원문$/ }).fill('A 제안');
  await save(page);
  const baseline = await api(request, { type: 'documentOpen', name }); expect(baseline.view.source).toBe(source);
  const merged = await api(request, { type: 'documentTarget', target: 'document-review/A' });
  expect(merged.view.source).toBe(source.replace('원문', 'A 제안'));
  await save(page); // A second save with no edits must not rewrite the patch or source.
  const again = await api(request, { type: 'documentsRefresh' }); expect(again.revision).toBe(merged.revision);
  await api(request, { type: 'documentOpen', name }, 'external');
  const block = baseline.view.blocks.find((b: { path?: string }) => b.path === name + '/Intro/note');
  await api(request, { type: 'documentEdit', name, revision: again.revision,
    operations: [{ op: 'replace', block: block.index, markdown: '<!-- name: note -->\r\n현재 원문' }] }, 'external');
  await page.goto('/?mode=plans&plan=document-review');
  const warning = page.getByRole('region', { name: '검토 진단' });
  await expect(warning).toContainText('BASE_CHANGED');
  await expect(page.getByTestId('document-added-lines')).toContainText('A 제안');
  await expect(warning).toContainText('이전 기준'); await expect(warning).toContainText('현재 원문'); await expect(warning).toContainText('A 제안');
  await page.getByRole('button', { name: 'A안 확정', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 확정', exact: true }).click();
  await expect(page.locator('.plans-banner')).toContainText('A안 선택');
  const final = await api(request, { type: 'documentsRefresh' }, 'external');
  expect(Buffer.from(final.view.source)).toEqual(Buffer.from(source.replace('원문', 'A 제안')));
});
test('creates an alternative from the document and prevents edits outside selected scopes', async ({ page }) => {
  await page.goto('/?mode=documents&document=' + encodeURIComponent(name));
  await page.getByText('새 기획·대안 만들기', { exact: true }).click();
  await page.getByLabel('기획 이름', { exact: true }).fill('새 검토');
  await page.getByLabel('대안 이름', { exact: true }).fill('C');
  await page.getByRole('button', { name: '대안 만들기', exact: true }).click();
  await expect(page.getByLabel('문서 편집 대상 선택')).toHaveValue('새 검토/C');
  await page.getByRole('checkbox', { name: name + '/Intro/Debate (섹션)', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: name + '/Intro/Debate (섹션)', exact: true })).toBeChecked();
  await rich(page).locator('.bn-inline-content').filter({ hasText: /^선택 내용$/ }).fill('섹션 대안');
  await expect(page.getByLabel('문서 편집 대상 선택')).toBeDisabled();
  await save(page);
  const outside = rich(page).locator('.bn-inline-content').filter({ hasText: /^그대로/ });
  await outside.click(); await page.keyboard.type('forbidden');
  await expect(page.getByRole('alert')).toContainText('상속'); await expect(outside).toHaveText('그대로');
});
