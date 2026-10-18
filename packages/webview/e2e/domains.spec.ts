import { expect, test, type APIRequestContext } from '@playwright/test';
import type { DocumentView, ResourceEntry } from '@vibe-spec/core';
import type { DocumentsHostMessage, DocumentsClientMessage } from '../src/documentsProtocol';
import type { Snapshot } from '../src/protocol';

async function inspect(request: APIRequestContext) {
  const response = await request.get('/__vibe/domains/inspect');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ revision: string; resources: ResourceEntry[]; sources: Record<string, string> }>;
}
async function document(request: APIRequestContext, name = '상점 안내'): Promise<DocumentView> {
  const response = await request.post('/__vibe/documents', { data: { type: 'documentOpen', name, client: 'domains-inspection' } });
  expect(response.ok()).toBe(true);
  const message = await response.json() as DocumentsHostMessage;
  expect(message.type, JSON.stringify(message)).toBe('documentsState');
  if (message.type !== 'documentsState' || !message.view) throw new Error('Missing nested document view');
  return message.view;
}
test.beforeEach(async ({ request }) => {
  const response = await request.post('/__vibe/domains/fixture');
  expect(response.ok(), await response.text()).toBe(true);
  const state = await inspect(request);
  expect(state.resources).toContainEqual({ kind: 'table', name: 'offers', file: 'tables/경제/상점/offers.yaml', folder: '경제/상점' });
  expect(state.resources).toContainEqual({ kind: 'document', name: '상점 안내', file: 'documents/경제/상점/상점 안내.md', folder: '경제/상점' });
});

test('edits a nested table through the real core and follows a document link to its public name', async ({ page, request }) => {
  await page.goto('/?table=offers');
  const cell = page.getByRole('gridcell', { name: 'bundle/price', exact: true });
  await cell.dblclick();
  const editor = page.getByRole('textbox', { name: '값 편집', exact: true });
  await editor.fill('+0001.2500');
  const applied = page.waitForResponse(response => new URL(response.url()).pathname === '/__vibe/apply'
    && response.request().postDataJSON()?.type === 'apply');
  await editor.press('Enter');
  expect((await applied).ok()).toBe(true);
  await expect(cell).toContainText('+0001.2500');
  const snapshot = await (await request.get('/__vibe/snapshot?table=offers')).json() as Snapshot;
  expect(snapshot.rows.find(row => row.sku === 'bundle')?.price).toBe('+0001.2500');
  const state = await inspect(request);
  expect(state.sources['tables/경제/상점/offers.yaml']).toContain('+0001.2500');
  expect(state.sources['tables/offers.yaml']).toBeUndefined();

  await page.goto('/?mode=documents&document=' + encodeURIComponent('상점 안내'));
  const body = page.getByRole('region', { name: '문서 본문' });
  const link = body.getByRole('button', { name: /offers\/bundle\/price/ });
  await expect(link).toContainText('+0001.2500');
  await link.click();
  await expect(page).toHaveURL(/table=offers.*key=bundle.*column=price/);
  await expect(page.getByRole('gridcell', { name: 'bundle/price', exact: true })).toContainText('+0001.2500');
});

test('edits only a nested document block and navigates to another nested document by public name', async ({ page, request }) => {
  const before = await document(request);
  await page.goto('/?mode=documents&document=' + encodeURIComponent('상점 안내'));
  const image = page.getByRole('region', { name: '문서 본문' }).getByRole('img', { name: '상점 이미지', exact: true });
  await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(before.links.find(link => link.kind === 'image')).toMatchObject({ path: expect.stringMatching(/^assets\//), resolved: true });
  const block = before.blocks.find(block => block.markdown.includes('남길 문장'))!;
  const editor = page.getByTestId('document-rich-editor');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.locator('.bn-inline-content').filter({ hasText: '남길 문장' }).fill('수정한 문장 한글 🐈');
  const applied = page.waitForRequest(request => new URL(request.url()).pathname === '/__vibe/documents'
    && request.postDataJSON()?.type === 'documentSnapshot');
  page.once('dialog', dialog => dialog.accept('중첩 문서 내용 수정'));
  await editor.press('ControlOrMeta+s');
  const submitted = (await applied).postDataJSON() as Extract<DocumentsClientMessage, { type: 'documentSnapshot' }>;
  await expect(page.locator('.document-save-state')).toHaveText('');
  expect(submitted.name).toBe('상점 안내');
  const changed = submitted.blocks.filter(block => block.markdown !== undefined);
  expect(changed).toHaveLength(1);
  const operation = changed[0]!;
  expect(operation.original).toBe(block.index);
  const after = await document(request);
  expect(after.source).toBe(before.source.slice(0, block.start) + operation.markdown + before.source.slice(block.end));
  expect(after.source).toContain('수정한 문장 한글 🐈');
  const state = await inspect(request);
  expect(state.sources['documents/경제/상점/상점 안내.md']).toBe(after.source);
  expect(state.sources['documents/상점 안내.md']).toBeUndefined();
  await page.getByRole('region', { name: '문서 본문' }).getByRole('button', { name: /상점 상세\/설명/ }).click();
  await expect(page.getByTestId('document-rich-editor')).toHaveAttribute('contenteditable', 'true');
  await expect(page.getByRole('region', { name: '문서 본문' })).toContainText('상세 본문');
});

test('imports into the selected domain and invalidates the preview when its destination changes', async ({ page, request }) => {
  await page.goto('/?mode=import');
  await page.getByRole('button', { name: '파일 선택', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'domain.csv', mimeType: 'text/csv', buffer: Buffer.from('id,label\none,001\n') });
  await page.getByRole('textbox', { name: '테이블 이름', exact: true }).fill('imported');
  await page.getByRole('textbox', { name: '스키마 이름', exact: true }).fill('imported');
  const destination = page.getByRole('textbox', { name: '대상 폴더', exact: true });
  await destination.fill('경제/상점');
  const preview = page.getByRole('button', { name: '미리보기', exact: true });
  const apply = page.getByRole('button', { name: '적용', exact: true });
  const before = await inspect(request);
  await preview.click();
  await expect(apply).toBeEnabled();
  await expect(page.getByRole('region', { name: '불러오기 미리보기', exact: true })).toContainText('tables/경제/상점/imported.yaml');
  await destination.fill('경제');
  await expect(apply).toBeDisabled();
  expect((await inspect(request)).revision).toBe(before.revision);
  await destination.fill('경제/상점');
  await expect(apply).toBeDisabled();
  await preview.click();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByRole('status')).toContainText('불러오기를 적용했습니다.');
  const after = await inspect(request);
  expect(after.resources).toContainEqual({ kind: 'table', name: 'imported', file: 'tables/경제/상점/imported.yaml', folder: '경제/상점' });
  const snapshot = await (await request.get('/__vibe/snapshot?table=imported')).json() as Snapshot;
  expect(snapshot.rows).toEqual([{ id: 'one', label: '001' }]);
});
