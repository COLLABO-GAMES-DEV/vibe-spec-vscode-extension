import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';
import type { DocumentView } from '@vibe-spec/core';
import type { DocumentsClientMessage, DocumentsHostMessage } from '../src/documentsProtocol';

const name = '기획 문서';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const rich = (page: Page) => page.getByTestId('document-rich-editor');
const paragraph = (page: Page, text: string) => rich(page).locator('.bn-inline-content').filter({ hasText: text }).first();
async function editableRich(page: Page) {
  await expect(rich(page)).toHaveAttribute('contenteditable', 'true');
  return rich(page);
}
const documentMenu = async (page: Page) => { const menu = page.locator('.document-header details'); if (await menu.getAttribute('open') === null) await menu.locator('summary').click(); };
async function message(request: APIRequestContext, data: DocumentsClientMessage): Promise<DocumentsHostMessage> {
  const response = await request.post('/__vibe/documents', { data: { ...data, client: 'documents-test-inspection' } });
  expect(response.ok()).toBe(true);
  const result = await response.json() as DocumentsHostMessage;
  expect(result.type, JSON.stringify(result)).not.toBe('error');
  return result;
}
async function inspect(request: APIRequestContext, documentName = name): Promise<DocumentView> {
  const result = await message(request, { type: 'documentOpen', name: documentName });
  if (result.type !== 'documentsState' || !result.view) throw new Error('Document view missing');
  return result.view;
}
async function fixture(request: APIRequestContext, source?: string) {
  expect((await request.post('/__vibe/documents/fixture', { data: source === undefined ? {} : { source } })).ok()).toBe(true);
}
async function open(page: Page) {
  await page.goto('/?mode=documents&document=' + encodeURIComponent(name));
  await editableRich(page);
  await expect(rich(page)).toHaveCount(1);
}
function sent(page: Page, type: DocumentsClientMessage['type']): Promise<Request> {
  return page.waitForRequest(request => request.url().endsWith('/__vibe/documents')
    && request.method() === 'POST' && request.postDataJSON().type === type);
}
type Snapshot = Extract<DocumentsClientMessage, { type: 'documentSnapshot' }>;
async function save(page: Page, keyboard = false): Promise<Snapshot> {
  const submission = sent(page, 'documentSnapshot');
  page.once('dialog', dialog => dialog.accept('문서 편집 회귀 검증'));
  if (keyboard) await rich(page).press('ControlOrMeta+s');
  else await page.getByRole('button', { name: '변경 사유와 함께 저장', exact: true }).click();
  const data = (await submission).postDataJSON() as Snapshot;
  await expect(page.locator('.document-save-state')).toHaveText('');
  await editableRich(page);
  return data;
}
function expectOnlyReplacement(before: DocumentView, after: DocumentView, submitted: Snapshot) {
  const changed = submitted.blocks.filter(block => block.markdown !== undefined);
  expect(changed).toHaveLength(1);
  const operation = changed[0]!;
  expect(operation.original).toBeDefined();
  const block = before.blocks[operation.original!]!;
  expect(submitted.blocks.filter(item => item.markdown === undefined)).toEqual(before.blocks.filter(item => item.index !== block.index).map(item => ({ original: item.index })));
  const expected = before.source.slice(0, block.start) + operation.markdown + before.source.slice(block.end);
  expect(Buffer.from(after.source)).toEqual(Buffer.from(expected));
}
async function appendParagraph(page: Page) {
  await (await editableRich(page)).press('ControlOrMeta+End');
  await rich(page).press('Enter');
}
async function selectAll(page: Page) {
  await rich(page).click();
  await rich(page).press('ControlOrMeta+a');
  await expect.poll(() => rich(page).evaluate(element => {
    const selection = window.getSelection();
    return Boolean(selection?.rangeCount && !selection.isCollapsed && element.contains(selection.anchorNode) && element.contains(selection.focusNode));
  })).toBe(true);
}
test.beforeEach(async ({ request }) => {
  expect((await request.post('/__vibe/reset')).ok()).toBe(true);
  await fixture(request);
});

test('one continuously editable document renders Markdown, local images, raw source and exact cell text', async ({ page }) => {
  await open(page);
  const body = page.getByRole('region', { name: '문서 본문' });
  await expect(body.getByRole('heading', { name: '기획', exact: true })).toBeVisible();
  await expect(page.locator('.document-header h1')).toHaveCount(0);
  await expect(body.locator('strong')).toHaveText('강조');
  await expect(body.getByRole('table')).toContainText('12.5000');
  await expect(body.getByRole('checkbox')).toBeEnabled();
  await expect(body.locator('blockquote')).toHaveText('인용문');
  await expect(body.locator('pre code')).toHaveText('코드');
  const image = body.getByRole('img', { name: '그림', exact: true });
  await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const reference = body.getByRole('button', { name: /items\/currency_gold\/name/ });
  await expect(reference).toContainText('골드');
  await expect(body.locator('aside')).toHaveCount(0);
  await expect(body.getByRole('textbox', { name: '원문 Markdown' })).toHaveValue('<aside>보존할 원문</aside>');
  await reference.click();
  await expect(page).toHaveURL(/table=items.*key=currency_gold.*column=name/);
});

test('opening, focusing and saving unchanged content never normalizes BOM CRLF or trivia', async ({ page, request }) => {
  const source = '\uFEFF# 제목\r\n\r\n문장 __굵게__\t  \r\n다음 줄 👋\r\n\r\n끝';
  await fixture(request, source);
  const before = await inspect(request);
  await open(page);
  await paragraph(page, '문장').click();
  await page.locator('.document-header').click();
  const submitted = await save(page);
  expect(submitted.dirty).toBe(false);
  expect(submitted.blocks).toEqual(before.blocks.map(block => ({ original: block.index })));
  expect(Buffer.from((await inspect(request)).source)).toEqual(Buffer.from(source));
});

test('typing changes only one source block and preserves BOM CRLF trivia and final newline absence', async ({ page, request }) => {
  await fixture(request, '\uFEFF# 제목\r\n \t\r\n첫 문단 👋\r\n\r\n-  남길 항목\r\n- 둘\r\n\r\n끝  ');
  const before = await inspect(request);
  await open(page);
  await paragraph(page, '첫 문단').fill('바뀐 문단 한글 🐈');
  const submitted = await save(page, true);
  expect(submitted.revision).toBe(before.revision);
  const after = await inspect(request);
  expectOnlyReplacement(before, after, submitted);
  expect(after.source.endsWith('끝  ')).toBe(true);
});

test('table cell and checkbox use native rich controls and change only their source group', async ({ page, request }) => {
  await open(page);
  let before = await inspect(request);
  await rich(page).locator('td').first().fill('변경 항목');
  let submitted = await save(page);
  let after = await inspect(request);
  expect(after.source).toContain('변경 항목');
  expectOnlyReplacement(before, after, submitted);
  before = after;
  await rich(page).getByRole('checkbox').check();
  expect((await inspect(request)).source).toBe(before.source);
  submitted = await save(page);
  after = await inspect(request);
  expect(after.source).toContain('[x] 확인');
  expectOnlyReplacement(before, after, submitted);
});

test('named paragraphs retain the exact name comment and public path', async ({ page, request }) => {
  await fixture(request, '# 제목\r\n\r\n<!--  name: 보상  -->\r\n기존 내용\r\n\r\n남길 내용');
  const before = await inspect(request);
  await open(page);
  await expect(rich(page)).not.toContainText('name:');
  await paragraph(page, '기존 내용').fill('보상 설명을 수정했습니다');
  const submitted = await save(page);
  const after = await inspect(request);
  expect(after.source).toContain('<!--  name: 보상  -->\r\n');
  expect(after.blocks.some(block => block.path?.endsWith('/보상'))).toBe(true);
  expectOnlyReplacement(before, after, submitted);
});

test('unsupported HTML remains inert and raw editing preserves surrounding bytes', async ({ page, request }) => {
  await fixture(request, '# 제목\n\n<aside><script>window.documentExecuted = true</script>원문</aside>\n\n남길 문단');
  const before = await inspect(request);
  await open(page);
  expect(await page.evaluate(() => Object.hasOwn(window, 'documentExecuted'))).toBe(false);
  await page.getByRole('textbox', { name: '원문 Markdown' }).fill('<aside>직접 수정한 원문</aside>');
  const submitted = await save(page);
  expectOnlyReplacement(before, await inspect(request), submitted);
});

test('external insertion keeps the dirty document and frozen revision through failed save and refresh', async ({ page, request }) => {
  const before = await inspect(request);
  await open(page);
  await paragraph(page, '원문').fill('아직 저장하지 않은 내 초안');
  await message(request, { type: 'documentEdit', name, revision: before.revision, operations: [{ op: 'insert', before: 0, markdown: '외부에서 추가한 블록' }] });
  await expect(page.getByRole('alert').filter({ hasText: '파일이 변경되었습니다' })).toBeVisible();
  await page.locator('.document-current summary').click();
  await expect(page.locator('.document-current pre')).toContainText('외부에서 추가한 블록');
  await expect(rich(page)).toContainText('아직 저장하지 않은 내 초안');
  const submission = sent(page, 'documentSnapshot');
  page.once('dialog', dialog => dialog.accept('충돌 검증'));
  await page.getByRole('button', { name: '변경 사유와 함께 저장' }).click();
  expect((await submission).postDataJSON().revision).toBe(before.revision);
  await expect(page.getByRole('alert').filter({ hasText: 'STALE_REVISION' })).toBeVisible();
  await editableRich(page);
  await documentMenu(page);
  await page.getByRole('button', { name: '문서 새로 고침' }).click();
  await expect(rich(page)).toContainText('아직 저장하지 않은 내 초안');
  await expect(page.getByRole('alert').filter({ hasText: 'STALE_REVISION' })).toBeVisible();
  expect((await inspect(request)).source).not.toContain('아직 저장하지 않은 내 초안');
});

test('sidebar-created document stays editable and title menu renames and deletes it', async ({ page, request }) => {
  const current = await inspect(request);
  await message(request, { type: 'documentCreate', name: '새 기획', revision: current.revision });
  await page.goto('/?mode=documents&document=' + encodeURIComponent('새 기획'));
  await editableRich(page);
  await expect(page.getByRole('heading', { name: '새 기획', exact: true })).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: '문서 목록' })).toHaveCount(0);
  await appendParagraph(page);
  await page.keyboard.insertText('추가한 본문');
  await save(page);
  expect((await inspect(request, '새 기획')).source).toContain('추가한 본문');
  await documentMenu(page);
  await page.getByRole('button', { name: '문서 이름 바꾸기' }).click();
  const form = page.getByRole('form', { name: '문서 작업' });
  await form.getByRole('textbox', { name: '이름', exact: true }).fill('바뀐 기획');
  await form.getByRole('button', { name: '이름 변경 적용' }).click();
  await expect(form).toHaveCount(0);
  await documentMenu(page);
  await page.getByRole('button', { name: '문서 삭제', exact: true }).click();
  await expect(form.getByRole('button', { name: '삭제 적용' })).toBeDisabled();
  await form.getByRole('checkbox', { name: '문서 전체를 삭제합니다' }).check();
  await form.getByRole('button', { name: '삭제 적용' }).click();
  await expect(rich(page)).toHaveCount(0);
  const result = await message(request, { type: 'documentsRefresh' });
  expect(result.type === 'documentsState' && result.documents.some(item => item.name === '바뀐 기획')).toBe(false);
});

test('slash image upload sends base64 and saves only the relative asset path', async ({ page, request }) => {
  await fixture(request, '# 제목\n\n끝');
  await open(page);
  await appendParagraph(page);
  await page.keyboard.type('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('option').filter({ hasText: /^이미지/ }).click();
  const upload = sent(page, 'documentImage');
  await (await chooser).setFiles({ name: '추가 그림.png', mimeType: 'image/png', buffer: png });
  const data = (await upload).postDataJSON();
  expect(data.name).toBe('추가 그림.png'); expect(Buffer.from(data.data, 'base64')).toEqual(png);
  await expect(rich(page).locator('img')).toHaveCount(1);
  await save(page);
  const after = await inspect(request);
  expect(after.source).toMatch(/!\[추가 그림\.png\]\(assets\/[^ )]+\)/);
  expect(after.source).not.toContain('data:image/'); expect(after.source).not.toContain('vscode-webview');
  const image = page.getByRole('img', { name: '추가 그림.png', exact: true });
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

test('native side menu deletes a block only on explicit save and preserves other ranges', async ({ page, request }) => {
  await fixture(request, '# 제목\n\n> 삭제할 인용\n\n남길 문장');
  const before = await inspect(request), block = before.blocks[1]!;
  await open(page);
  await rich(page).locator('blockquote').hover();
  await page.getByRole('button', { name: /블록 메뉴|Drag|드래그/i }).click();
  await page.getByRole('menuitem', { name: /삭제|Delete/ }).click();
  expect((await inspect(request)).source).toBe(before.source);
  const submitted = await save(page);
  expect(submitted.blocks).toEqual([{ original: 0 }, { original: 2 }]);
  expect(Buffer.from((await inspect(request)).source)).toEqual(Buffer.from(before.source.slice(0, block.start) + before.source.slice(block.end)));
});

test('slash menu exposes supported Markdown controls without lossy styles or embeds', async ({ page }) => {
  await fixture(page.request, ''); await open(page);
  await rich(page).pressSequentially('/');
  const menu = page.getByRole('listbox');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option').filter({ hasText: '체크리스트' })).toBeVisible();
  await expect(menu.getByRole('option').filter({ hasText: /접을 수|비디오|오디오|이모지|색상|글꼴/ })).toHaveCount(0);
  await menu.getByRole('option').filter({ hasText: /^표/ }).click();
  await expect(rich(page).getByRole('table')).toBeVisible();
  await save(page);
});

test('external images never load and cell annotations show exact strings rather than tables', async ({ page, request }) => {
  await fixture(request, '# 연결\n\n![외부](https://example.invalid/tracking.png)\n\n[표](items)\n\n[셀](offers/bundle/price)');
  const external: string[] = [];
  page.on('request', request => { if (request.url().startsWith('https://example.invalid/')) external.push(request.url()); });
  await page.route('https://example.invalid/**', route => route.abort());
  await open(page);
  await expect(rich(page).locator('img[src^="https://example.invalid"]')).toHaveCount(0);
  await expect(page.locator('.document-references .document-value')).toHaveText(['+001.2300E+0002']);
  expect(external).toEqual([]);
});

test('encoded native links and where-used navigate by the stored relative address', async ({ page, request }) => {
  const target = '연결 문서', heading = '보상 규칙';
  await fixture(request, '# 기획\n\n[연결 보기](' + encodeURIComponent(target) + '/' + encodeURIComponent(heading) + ')');
  let current = await inspect(request);
  await message(request, { type: 'documentCreate', name: target, revision: current.revision });
  current = await inspect(request, target);
  await message(request, { type: 'documentEdit', name: target, revision: current.revision, operations: [{ op: 'replace', block: 0, markdown: '# ' + heading }] });
  await open(page);
  await page.getByRole('link', { name: '연결 보기', exact: true }).click();
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await documentMenu(page);
  await page.getByRole('button', { name: '문서 사용처', exact: true }).click();
  const usages = page.getByRole('region', { name: '문서 사용처 결과' });
  await expect(usages).toContainText('선언된 참조');
  await usages.getByRole('button', { name: '위치로 이동', exact: true }).first().click();
  await expect(rich(page).getByRole('heading', { name: '기획', exact: true })).toBeVisible();
});

test('blur and clicking another paragraph retain both edits without any source write', async ({ page, request }) => {
  await fixture(request, '\uFEFF# 제목\r\n\r\n첫 문단\r\n\r\n다음 문단\r\n\r\n끝  ');
  const before = await inspect(request); await open(page);
  const writes: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/__vibe/documents') && ['documentEdit','documentSnapshot'].includes(request.postDataJSON().type)) writes.push(request.postDataJSON()); });
  await paragraph(page, '첫 문단').fill('첫 수정');
  await paragraph(page, '다음 문단').fill('둘째 수정');
  await page.locator('.document-header').click();
  expect((await inspect(request)).source).toBe(before.source); expect(writes).toHaveLength(0);
  await save(page); expect(writes).toHaveLength(1);
  expect((await inspect(request)).source).toContain('둘째 수정');
});

test('raw invalid boundaries fail explicit save and retain the exact editable draft', async ({ page, request }) => {
  await fixture(request, '# 제목\n\n<aside>원문</aside>\n\n남길 문단');
  const before = await inspect(request); await open(page);
  await page.getByRole('textbox', { name: '원문 Markdown' }).fill('```\n닫지 않은 코드');
  page.once('dialog', dialog => dialog.accept('경계 검증'));
  await page.getByRole('button', { name: '변경 사유와 함께 저장' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'DOCUMENT_BOUNDARY' })).toBeVisible();
  await editableRich(page);
  await expect(page.getByRole('textbox', { name: '원문 Markdown' })).toHaveValue('```\n닫지 않은 코드');
  expect((await inspect(request)).source).toBe(before.source);
});

for (const cpuRate of [1, 6]) {
  test(`formatting link portal and real whole-document selection retain draft until save (CPU ${cpuRate}x)`, async ({ page, request }) => {
    const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    await fixture(request, '\uFEFF기존 문단\r\n'); const before = await inspect(request); await open(page);
    await paragraph(page, '기존 문단').fill('링크를 만들 수정 문단');
    await selectAll(page);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('링크를 만들 수정 문단');
    await page.getByRole('button', { name: /링크 만들기/ }).click();
    const url = page.getByPlaceholder('URL 수정', { exact: true });
    await expect(url).toBeFocused(); await url.fill('https://example.com');
    expect((await inspect(request)).source).toBe(before.source);
    await url.press('Enter');
    await expect(rich(page).getByRole('link')).toHaveAttribute('href', 'https://example.com');
    const submitted = await save(page);
    expectOnlyReplacement(before, await inspect(request), submitted);
  });
}

test('external deletion preserves dirty document and refuses to recreate the file', async ({ page, request }) => {
  await open(page); const before = await inspect(request);
  await paragraph(page, '원문').fill('삭제 후에도 남아야 하는 입력');
  await message(request, { type: 'documentDelete', name, revision: before.revision, confirmed: true });
  await expect(page.getByText('문서가 삭제되었거나 이동했습니다. 초안은 유지됩니다.')).toBeVisible();
  page.once('dialog', dialog => dialog.accept('삭제 충돌 검증'));
  await page.getByRole('button', { name: '변경 사유와 함께 저장' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'STALE_REVISION' })).toBeVisible();
  await editableRich(page); await expect(rich(page)).toContainText('삭제 후에도 남아야 하는 입력');
  const state = await message(request, { type: 'documentsRefresh' });
  expect(state.type === 'documentsState' && state.documents.some(item => item.name === name)).toBe(false);
});

test('slash image cancellation retains dirty text without writing source', async ({ page, request }) => {
  await fixture(request, '# 제목\n\n기존 문단\n\n끝'); const before = await inspect(request); await open(page);
  await paragraph(page, '기존 문단').fill('변경한 문단');
  await appendParagraph(page); await page.keyboard.type('/');
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('option').filter({ hasText: /^이미지/ }).click(); await chooser;
  expect((await inspect(request)).source).toBe(before.source);
  await page.getByLabel('문서 이미지 파일').dispatchEvent('cancel');
  await expect(rich(page)).toBeFocused();
  const submitted = await save(page);
  expectOnlyReplacement(before, await inspect(request), submitted);
});

test('a pristine external insertion updates the baseline before the next edit', async ({ page, request }) => {
  await fixture(request, '# 제목\n\n첫 문단\n\n다음 문단\n\n끝'); const original = await inspect(request); await open(page);
  await message(request, { type: 'documentEdit', name, revision: original.revision, operations: [{ op: 'insert', before: 0, markdown: '외부 삽입' }] });
  await expect(rich(page)).toContainText('외부 삽입'); const external = await inspect(request);
  await paragraph(page, '다음 문단').fill('다음 문단을 수정');
  const submitted = await save(page);
  expect(submitted.revision).toBe(external.revision);
  expect(submitted.blocks.find(block => block.markdown !== undefined)).toMatchObject({ original: 3 });
  expectOnlyReplacement(external, await inspect(request), submitted);
});

test('empty document, select all deletion, undo and repeated saves preserve a single editor', async ({ page, request }) => {
  await fixture(request, ''); await open(page);
  await rich(page).fill('첫 내용'); await save(page);
  const identity = await rich(page).locator('[data-node-type="blockContainer"]').first().getAttribute('data-id');
  await paragraph(page, '첫 내용').fill('둘째 내용'); await save(page);
  expect(await rich(page).locator('[data-node-type="blockContainer"]').first().getAttribute('data-id')).toBe(identity);
  await rich(page).press('ControlOrMeta+z'); await expect(rich(page)).toContainText('첫 내용');
  await save(page);
  await selectAll(page); await page.keyboard.press('Backspace'); await save(page);
  expect((await inspect(request)).blocks).toHaveLength(0);
  await rich(page).fill('다시 시작'); await save(page);
  expect((await inspect(request)).source).toContain('다시 시작');
});

test('repeated identical paragraphs map by local identity and retain other exact ranges', async ({ page, request }) => {
  await fixture(request, '\uFEFF# 제목\r\n\r\n동일\r\n \t\r\n동일\r\n\r\n끝'); const before = await inspect(request); await open(page);
  await rich(page).locator('p').filter({ hasText: /^동일$/ }).nth(1).fill('두 번째만 수정');
  const submitted = await save(page);
  expect(submitted.blocks.find(block => block.markdown !== undefined)?.original).toBe(2);
  expectOnlyReplacement(before, await inspect(request), submitted);
});

test('list member insertion and deletion serialize only the affected source group', async ({ page, request }) => {
  await fixture(request, '# 제목\r\n\r\n-  하나\r\n- 둘\r\n\r\n끝  '); const before = await inspect(request); await open(page);
  await paragraph(page, '하나').click();
  await paragraph(page, '하나').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  }); await page.keyboard.press('Enter'); await page.keyboard.insertText('새 항목');
  const submitted = await save(page); expectOnlyReplacement(before, await inspect(request), submitted);
  const after = await inspect(request);
  await paragraph(page, '새 항목').hover();
  await page.getByRole('button', { name: '블록 메뉴 열기', exact: true }).click();
  await page.getByRole('menuitem', { name: '삭제', exact: true }).click();
  const next = await save(page); expectOnlyReplacement(after, await inspect(request), next);
});

test('IME composition retains entered text and saves after composition finishes', async ({ page, request }) => {
  await fixture(request, '# 제목\n\n기존'); await open(page);
  await paragraph(page, '기존').click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '한글', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '한글' });
  await expect(rich(page)).toContainText('한글');
  await save(page); expect((await inspect(request)).source).toContain('한글');
});

test('native dragging raw blocks up and down preserves their exact bytes and untouched gap slots', async ({ page, request }) => {
  await fixture(request, '\uFEFF# 제목\r\n \t\r\n첫 문단 👋\r\n\r\n<aside>  원문\r\n보존 </aside>\r\n\r\n끝  ');
  await open(page);
  for (const up of [true, false]) {
    const before = await inspect(request);
    const rawIndex = before.blocks.findIndex(block => !block.editable);
    const otherIndex = up ? rawIndex - 1 : rawIndex + 1;
    const raw = page.getByRole('textbox', { name: '원문 Markdown' });
    await raw.hover();
    const handle = page.getByRole('button', { name: '블록 메뉴 열기', exact: true });
    await expect(handle).toBeVisible();
    const destination = paragraph(page, '첫 문단');
    const box = await destination.boundingBox(); if (!box) throw new Error('Missing drop target');
    const origin = await handle.boundingBox(); if (!origin) throw new Error('Missing drag handle');
    await page.mouse.move(origin.x + origin.width / 2, origin.y + origin.height / 2);
    await page.mouse.down();
    // Real dragstart requires crossing Chromium's drag threshold before entering
    // the editor. Two moves over the drop position deliver native dragover.
    await page.mouse.move(origin.x + origin.width / 2 + 5, origin.y + origin.height / 2 - 5, { steps: 5 });
    const dropY = up ? box.y - 3 : box.y + box.height + 3;
    await page.mouse.move(box.x + 12, dropY, { steps: 20 });
    await page.mouse.move(box.x + 13, dropY);
    await page.mouse.up();
    await expect(page.locator('.document-save-state')).toHaveText('저장하지 않은 변경');
    expect((await inspect(request)).source).toBe(before.source);
    const submitted = await save(page);
    const order = before.blocks.map(block => block.index);
    [order[rawIndex], order[otherIndex]] = [order[otherIndex]!, order[rawIndex]!];
    expect(submitted.blocks).toEqual(order.map(original => ({ original })));
    let expected = '', end = 0;
    for (const [index, block] of before.blocks.entries()) {
      expected += before.source.slice(end, block.start) + before.blocks[order[index]!]!.markdown;
      end = block.end;
    }
    expected += before.source.slice(end);
    expect(Buffer.from((await inspect(request)).source)).toEqual(Buffer.from(expected));
  }
});

test('deleting a paragraph between lists changes only the newly merged list group', async ({ page, request }) => {
  await fixture(request, '\uFEFF# 제목\r\n\r\n-  앞\r\n\r\n지울 문단\r\n\r\n-  뒤\r\n\r\n마지막  ');
  const before = await inspect(request); await open(page);
  await paragraph(page, '지울 문단').hover();
  await page.getByRole('button', { name: '블록 메뉴 열기', exact: true }).click();
  await page.getByRole('menuitem', { name: /삭제/ }).click();
  const submitted = await save(page);
  expect(submitted.blocks).toEqual([{ original: 0 }, { original: 1, markdown: expect.stringContaining('앞') }, { original: 4 }]);
  const after = await inspect(request);
  expect(after.blocks[1]?.markdown).toContain('뒤');
  expect(after.blocks[0]?.markdown).toBe(before.blocks[0]?.markdown);
  expect(after.source.endsWith('마지막  ')).toBe(true);
});

test('raw textarea editing keys stay inside its text and H1 after raw hides filename', async ({ page, request }) => {
  await fixture(request, '<aside>원문</aside>\n\n# 뒤의 제목\n\n끝'); await open(page);
  await expect(page.locator('.document-header h1')).toHaveCount(0);
  const raw = page.getByRole('textbox', { name: '원문 Markdown' });
  await raw.fill('<aside>한글 원문</aside>'); await raw.press('Home'); await raw.press('Backspace');
  await expect(raw).toHaveCount(1); await expect(raw).toHaveValue('<aside>한글 원문</aside>');
  await raw.press('ControlOrMeta+a'); await raw.press('Backspace');
  await expect(raw).toHaveCount(1); await expect(rich(page).getByRole('heading')).toHaveText('뒤의 제목');
  await raw.fill('<aside>다시 입력</aside>'); await save(page);
  expect((await inspect(request)).source).toContain('<aside>다시 입력</aside>');
});

test('native list reordering changes the group and leaves surrounding source byte-exact', async ({ page, request }) => {
  await fixture(request, '\uFEFF# 제목\r\n\r\n-  하나\r\n- 둘\r\n- 셋\r\n\r\n끝  ');
  const before = await inspect(request); await open(page);
  await paragraph(page, '둘').click(); await page.keyboard.press('ControlOrMeta+Shift+ArrowUp');
  await expect(rich(page).locator('[data-content-type="bulletListItem"]')).toHaveText(['둘', '하나', '셋']);
  const submitted = await save(page); expectOnlyReplacement(before, await inspect(request), submitted);
});

test('save preserves native empty insertion points and undo history', async ({ page, request }) => {
  await fixture(request, '# 제목\n\n본문'); await open(page);
  await paragraph(page, '본문').fill('수정한 본문'); await appendParagraph(page);
  const ids = await rich(page).locator('[data-node-type="blockContainer"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-id')));
  await save(page);
  expect(await rich(page).locator('[data-node-type="blockContainer"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-id')))).toEqual(ids);
  await rich(page).press('ControlOrMeta+z');
  await expect(page.locator('.document-save-state')).toHaveText('저장하지 않은 변경');
});

test('reason cancellation keeps draft without flushing and in-flight flush freezes input', async ({ page, request }) => {
  await fixture(request, '# 제목\n\n본문'); const before = await inspect(request); await open(page);
  await paragraph(page, '본문').fill('보관할 초안');
  page.once('dialog', dialog => dialog.dismiss());
  const cancel = page.waitForResponse(response => response.url().endsWith('/__vibe/documents') && response.request().postDataJSON().type === 'documentSaveCancel');
  await rich(page).press('ControlOrMeta+s'); await cancel;
  expect((await inspect(request)).source).toBe(before.source);
  await expect(page.locator('.document-save-state')).toHaveText('저장하지 않은 변경');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/__vibe/documents', async route => {
    if (route.request().postDataJSON().type === 'documentSnapshot') await gate;
    await route.continue();
  });
  const submission = sent(page, 'documentSnapshot');
  page.once('dialog', dialog => dialog.accept('보관할 변경'));
  await rich(page).press('ControlOrMeta+s'); await submission;
  await expect(rich(page)).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('button', { name: '변경 사유와 함께 저장' })).toBeDisabled();
  release();
  await expect(page.locator('.document-save-state')).toHaveText(''); await editableRich(page);
  expect((await inspect(request)).source).toContain('보관할 초안');
});

test('original adjacent list groups stay byte-exact when only a later paragraph changes', async ({ page, request }) => {
  await fixture(request, '\uFEFF- 하나\r\n\r\n* 둘\r\n\r\n1. 셋\r\n\r\n문단  ');
  const before = await inspect(request); expect(before.blocks).toHaveLength(4); await open(page);
  await paragraph(page, '문단').fill('문단만 변경');
  const submitted = await save(page);
  expect(submitted.blocks.slice(0, 3)).toEqual([{ original: 0 }, { original: 1 }, { original: 2 }]);
  expectOnlyReplacement(before, await inspect(request), submitted);
});

test('named raw paragraphs preserve their comment, path and CRLF when another block changes', async ({ page, request }) => {
  await fixture(request, '# 제목\r\n\r\n<!--  name: 원문 태그  -->\r\n본문 <em>HTML</em>\r\n\r\n마지막');
  const before = await inspect(request); await open(page);
  await expect(page.getByRole('textbox', { name: '원문 Markdown' })).toHaveValue('<!--  name: 원문 태그  -->\n본문 <em>HTML</em>');
  await paragraph(page, '마지막').fill('마지막만 변경');
  const submitted = await save(page); expectOnlyReplacement(before, await inspect(request), submitted);
  expect((await inspect(request)).blocks[1]?.path).toBe(before.blocks[1]?.path);
});

test('incompatible named-paragraph conversion reports snapshot error without losing its tag or draft', async ({ page, request }) => {
  await fixture(request, '# 제목\n\n<!-- name: 보상 -->\n태그 본문\n\n끝'); const before = await inspect(request); await open(page);
  await paragraph(page, '태그 본문').click(); await page.keyboard.press('ControlOrMeta+Shift+8');
  page.once('dialog', dialog => dialog.accept('태그 보호 확인'));
  await rich(page).press('ControlOrMeta+s');
  await expect(page.getByRole('alert')).toContainText('주소가 있는 문단');
  await editableRich(page); await expect(rich(page)).toContainText('태그 본문');
  expect((await inspect(request)).source).toBe(before.source);
  await rich(page).press('ControlOrMeta+z');
  await save(page);
  expect((await inspect(request)).blocks[1]?.path).toBe(before.blocks[1]?.path);
});

test('initial document loading never enters native undo history', async ({ page, request }) => {
  await fixture(request, '\uFEFF# 제목\r\n\r\n원래 본문\r\n\r\n- 하나\r\n- 둘');
  const before = await inspect(request); await open(page);
  const initial = await rich(page).innerText();
  await rich(page).press('ControlOrMeta+z');
  await expect(rich(page)).toHaveText(initial, { useInnerText: true });
  await expect(page.locator('.document-save-state')).toHaveText('');
  await paragraph(page, '원래 본문').fill('사용자 수정');
  await rich(page).press('ControlOrMeta+z');
  await expect(rich(page)).toHaveText(initial, { useInnerText: true });
  await rich(page).press('ControlOrMeta+z');
  await expect(rich(page)).toHaveText(initial, { useInnerText: true });
  expect((await inspect(request)).source).toBe(before.source);
});

test('editing one adjacent list preserves every other list source group', async ({ page, request }) => {
  await fixture(request, '\uFEFF-  하나\r\n\r\n*  둘\r\n\r\n1) 셋\r\n\r\n문단  ');
  const before = await inspect(request); await open(page);
  await paragraph(page, '하나').fill('첫 목록만 변경');
  const submitted = await save(page);
  expectOnlyReplacement(before, await inspect(request), submitted);
});

test('editing an ordered list preserves the adjacent unordered list marker and spaces', async ({ page, request }) => {
  await fixture(request, '1. 첫 목록\n\n*  둘 목록\n\n문단');
  const before = await inspect(request); await open(page);
  await paragraph(page, '첫 목록').fill('첫 목록 수정');
  const submitted = await save(page); expectOnlyReplacement(before, await inspect(request), submitted);
  expect((await inspect(request)).source).toContain('*  둘 목록');
});

test('repeated paragraph saves do not append serializer newlines to original gaps', async ({ page, request }) => {
  const source = '\uFEFF# 제목\r\n\r\n첫 문단\r\n \t\r\n끝';
  await fixture(request, source); await open(page);
  for (const text of ['첫 문단 수정', '첫 문단 다시 수정']) {
    await paragraph(page, '첫 문단').fill(text);
    await save(page);
    expect(Buffer.from((await inspect(request)).source)).toEqual(Buffer.from(source.replace('첫 문단', text)));
  }
});
