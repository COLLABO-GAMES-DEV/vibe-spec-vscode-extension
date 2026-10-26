import { expect, test, type APIRequestContext } from '@playwright/test';
const name = '기획 문서';
async function api(request: APIRequestContext, body: Record<string, unknown>, client = 'escape-test') {
  const response = await request.post('/__vibe/documents', { data: { ...body, client } });
  const data = await response.json(); expect(data.type, JSON.stringify(data)).not.toBe('error'); return data;
}
test.beforeEach(async ({ request }) => { await request.post('/__vibe/reset'); });
test('edits a slash-named paragraph alternative and shows baseline conflicts without rewriting raw names', async ({ page, request }) => {
  const source = '\uFEFF# 공격 / 방어\r\n\r\n<!-- name: 기본/값~1 -->\r\n원문\r\n\r\n# 바깥\r\n\r\n보존  ';
  const path = './기획 문서/공격 ~1 방어/기본~1값~01';
  expect((await request.post('/__vibe/documents/fixture', { data: { source, variants: true } })).ok()).toBe(true);
  await page.goto('/?mode=documents&document=' + encodeURIComponent(name));
  const rich = page.getByTestId('document-rich-editor');
  await expect(rich.getByRole('heading', { name: '공격 / 방어', exact: true })).toBeVisible();
  await page.getByLabel('문서 편집 대상 선택').selectOption('document-review/A');
  await page.getByRole('checkbox', { name: path + ' (이름표 문단)', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: path + ' (이름표 문단)', exact: true })).toBeChecked();
  await rich.locator('.bn-inline-content').filter({ hasText: /^원문$/ }).fill('대안 원문');
  page.once('dialog', dialog => dialog.accept('합성 주소 확인'));
  const response = page.waitForResponse(r => r.url().endsWith('/__vibe/documents') && r.request().postDataJSON()?.type === 'documentSnapshot');
  await page.getByRole('button', { name: '변경 사유와 함께 저장', exact: true }).click();
  expect((await (await response).json()).ok).toBe(true);
  await expect(page.locator('.document-save-state')).toHaveText('');
  const baseline = await api(request, { type: 'documentOpen', name }); expect(baseline.view.source).toBe(source);
  await api(request, { type: 'documentEdit', name, revision: baseline.revision,
    operations: [{ op: 'replace', block: 1, markdown: '<!-- name: 기본/값~1 -->\r\n새 기준' }] });
  await page.reload();
  await page.getByLabel('문서 편집 대상 선택').selectOption('document-review/A');
  await expect(page.getByRole('region', { name: '문서 진단' })).toContainText('BASE_CHANGED');
  await expect(rich).toContainText('대안 원문');
});
test('renders raw slash Keys, edits them, follows cell references and marks invalid cells at the escaped address', async ({ page, request }) => {
  let snapshot = await (await request.get('/__vibe/snapshot?table=offers')).json();
  const renamed = await request.post('/__vibe/apply', { data: { type: 'rename', table: 'offers', key: 'bundle', to: 'bundle/30~1', revision: snapshot.revision, client: 'setup' } });
  expect(renamed.ok()).toBe(true);
  const source = '# 참조\n\n[값](./offers/bundle~130~01/price)';
  await request.post('/__vibe/documents/fixture', { data: { source } });
  await page.goto('/?mode=documents&document=' + encodeURIComponent(name));
  const link = page.getByRole('button', { name: /\.\/offers\/bundle~130~01\/price/ });
  await expect(link).toContainText('+001.2300E+0002'); await link.click();
  const cell = page.getByRole('gridcell', { name: 'bundle/30~1/price', exact: true });
  await expect(cell).toBeVisible(); await cell.dblclick();
  const input = page.getByRole('textbox', { name: '값 편집', exact: true });
  await input.fill('-1'); await input.press('Enter');
  await expect(cell).toHaveAttribute('aria-invalid', 'true');
  await expect(cell).toContainText('-1');
  await page.getByRole('gridcell', { name: 'bundle/30~1/sku', exact: true }).click();
  await page.getByRole('button', { name: '행 사용처 보기', exact: true }).click();
  await expect(page.getByRole('region', { name: '선언된 참조', exact: true }).getByRole('button', { name: /기획 문서/ })).toBeVisible();
});
