import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { EditOperation, GitStatus } from '@vibe-spec/core';
import type { GitClientMessage, GitHostMessage } from '../src/gitProtocol.js';
import type { Snapshot } from '../src/protocol.js';

type GitState = Extract<GitHostMessage, { type: 'gitState' }>;
type Fixture = { action: 'prepare' | 'remoteFailure' }
  | { action: 'edit' | 'remote'; operations: EditOperation[]; reason?: string };
const saveLabel = '변경 사유와 함께 저장';
const stateRegion = (page: Page) => page.getByRole('region', { name: '현재 상태', exact: true });
const outgoing = (page: Page) => page.getByRole('region', { name: '올릴 변경', exact: true });
const priceEdit = (price: string): EditOperation => ({ op: 'update', table: 'offers', key: 'bundle', values: { price } });

async function fixture(request: APIRequestContext, data: Fixture): Promise<GitState> {
  const response = await request.post('/__vibe/git/fixture', { data });
  expect(response.ok(), await response.text()).toBe(true);
  const message = await response.json() as GitHostMessage;
  expect(message.type).toBe('gitState');
  if (message.type !== 'gitState') throw new Error(message.message);
  return message;
}

async function gitState(request: APIRequestContext): Promise<GitState> {
  const response = await request.get('/__vibe/git');
  expect(response.ok()).toBe(true);
  const message = await response.json() as GitHostMessage;
  expect(message.type).toBe('gitState');
  if (message.type !== 'gitState') throw new Error(message.message);
  return message;
}

async function stored(request: APIRequestContext, table: string, key: string, column: string) {
  const response = await request.get('/__vibe/snapshot', { params: { table } });
  expect(response.ok()).toBe(true);
  const snapshot = await response.json() as Snapshot;
  return snapshot.rows.find(row => row[snapshot.schema.primary_key] === key)?.[column];
}

async function refresh(page: Page) {
  await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  await expect(page.getByRole('button', { name: '상태 새로고침', exact: true })).toBeEnabled();
}

async function save(page: Page, reason: string) {
  await page.getByRole('textbox', { name: '변경 사유', exact: true }).fill(reason);
  await page.getByRole('button', { name: saveLabel, exact: true }).click();
  await expect(page.getByRole('status', { name: '저장 결과', exact: true })).toContainText(reason);
  await expect(stateRegion(page)).toContainText('올리기 전');
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__vibe/reset')).ok()).toBe(true);
});

test('save requires a reason and publishes the actual saved change', async ({ page, request }) => {
  expect((await fixture(request, { action: 'prepare' })).status.state).toBe('published');
  await page.goto('/?mode=git');
  await expect(stateRegion(page)).toContainText('올리기 완료');
  const saveButton = page.getByRole('button', { name: saveLabel, exact: true });
  await expect(saveButton).toBeDisabled();
  const price = '+000123.4500e-0002';
  await fixture(request, { action: 'edit', operations: [priceEdit(price)] });
  await refresh(page);
  await expect(stateRegion(page)).toContainText('저장 전');
  await expect(page.getByRole('region', { name: '저장할 변경', exact: true })).toContainText('tables/offers.yaml');
  await expect(saveButton).toBeDisabled();
  await page.getByRole('textbox', { name: '변경 사유', exact: true }).fill('   ');
  await expect(saveButton).toBeDisabled();
  await save(page, '묶음 가격 조정');
  await expect(outgoing(page)).toContainText('묶음 가격 조정');
  const saved = await gitState(request);
  expect(saved.status.changes).toEqual([]);
  expect(saved.status.outgoing).toHaveLength(1);
  expect(saved.status.outgoing[0]?.reason).toBe('묶음 가격 조정');
  expect(await stored(request, 'offers', 'bundle', 'price')).toBe(price);
  await page.getByRole('button', { name: '올리기', exact: true }).click();
  await expect(stateRegion(page)).toContainText('올리기 완료');
  expect((await gitState(request)).status.outgoing).toEqual([]);
  expect(await stored(request, 'offers', 'bundle', 'price')).toBe(price);
});

test('pull applies a change published by the peer', async ({ page, request }) => {
  await fixture(request, { action: 'prepare' });
  await page.goto('/?mode=git');
  await expect(stateRegion(page)).toContainText('올리기 완료');
  await fixture(request, { action: 'remote', reason: '공유된 재화 이름 수정', operations: [
    { op: 'update', table: 'items', key: 'currency_gold', values: { name: '공유된 골드' } },
  ] });
  expect(await stored(request, 'items', 'currency_gold', 'name')).toBe('골드');
  await page.getByRole('button', { name: '받아오기', exact: true }).click();
  await expect(page.getByRole('status', { name: '작업 결과', exact: true })).toHaveText('받아오기를 완료했습니다.');
  await expect(stateRegion(page)).toContainText('올리기 완료');
  expect(await stored(request, 'items', 'currency_gold', 'name')).toBe('공유된 골드');
});

test('same-cell conflict shows all three exact numeric strings and applies the chosen row', async ({ page, request }) => {
  await fixture(request, { action: 'prepare' });
  const ours = '+000245.6700E-0001', theirs = '000345.67000e+0000';
  await fixture(request, { action: 'edit', operations: [priceEdit(ours)] });
  await page.goto('/?mode=git');
  await save(page, '내 묶음 가격');
  await fixture(request, { action: 'remote', operations: [priceEdit(theirs)], reason: '동료 묶음 가격' });
  await page.getByRole('button', { name: '받아오기', exact: true }).click();
  await expect(stateRegion(page)).toContainText('충돌 해결 필요');
  const conflict = page.getByRole('group', { name: 'offers / bundle', exact: true });
  await expect(conflict.getByRole('columnheader')).toHaveText(['기준', '내 변경', '받은 변경']);
  await expect(conflict.locator('[data-column="price"]')).toHaveText(['+001.2300E+0002', ours, theirs]);
  const apply = page.getByRole('button', { name: '충돌 선택 적용', exact: true });
  await expect(apply).toBeDisabled();
  await conflict.getByRole('radio', { name: '받은 변경 사용', exact: true }).check();
  await apply.click();
  await expect(page.getByRole('status', { name: '작업 결과', exact: true })).toHaveText('충돌 선택을 적용했습니다.');
  await expect(page.getByRole('region', { name: '충돌 해결', exact: true })).toHaveCount(0);
  expect((await gitState(request)).status.conflicts).toEqual([]);
  expect(await stored(request, 'offers', 'bundle', 'price')).toBe(theirs);
});

test('failed push retains the saved commit and its reason after a status refresh', async ({ page, request }) => {
  await fixture(request, { action: 'prepare' });
  await fixture(request, { action: 'edit', operations: [priceEdit('000321.000')] });
  await page.goto('/?mode=git');
  await save(page, '오프라인에서도 보관할 가격');
  const saved = await gitState(request);
  expect(saved.status.outgoing).toHaveLength(1);
  await fixture(request, { action: 'remoteFailure' });
  await page.getByRole('button', { name: '올리기', exact: true }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  const failure = await alert.textContent();
  expect(failure?.length).toBeGreaterThan(0);
  await expect(page.getByRole('status', { name: '저장 결과', exact: true })).toContainText('저장 완료');
  await expect(stateRegion(page)).toContainText('올리기 전');
  await refresh(page);
  await expect(alert).toHaveText(failure!);
  await expect(outgoing(page)).toContainText('오프라인에서도 보관할 가격');
  const after = await gitState(request);
  expect(after.status.changes).toEqual([]);
  expect(after.status.outgoing).toEqual(saved.status.outgoing);
  expect(await stored(request, 'offers', 'bundle', 'price')).toBe('000321.000');
});

// Inject the same host protocol used in VS Code to exercise message ordering and drafts.
const cleanStatus = (): GitStatus => ({ root: '/project', repository: '/project', gitDir: '/project/.git',
  branch: 'main', revision: 'revision-1', state: 'published', remote: { name: 'origin', url: '/remote' },
  ahead: 0, behind: 0, changes: [], otherChanges: [], outgoing: [], conflicts: [], mergeInProgress: false });

async function mockHost(page: Page, state: GitState) {
  await page.addInitScript(initial => {
    const messages: unknown[] = [];
    Object.assign(window, { gitMessages: messages, acquireVsCodeApi: () => ({ postMessage(message: { type: string }) {
      messages.push(message);
      if (message.type === 'ready') window.dispatchEvent(new MessageEvent('message', { data: initial }));
    } }) });
  }, state);
  await page.goto('/?mode=git');
  await expect(stateRegion(page)).toContainText(state.editing ? '편집 중' : {
    unsaved: '저장 전', unpublished: '올리기 전', published: '올리기 완료', conflict: '충돌 해결 필요',
  }[state.status.state]);
}

async function deliver(page: Page, message: GitHostMessage) {
  await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
}

async function messages(page: Page) {
  return page.evaluate(() => (window as unknown as { gitMessages: GitClientMessage[] }).gitMessages);
}

test('editing blocks save; status notifications keep a submitted save busy; errors last until success', async ({ page }) => {
  const status: GitStatus = { ...cleanStatus(), repository: null, gitDir: null, branch: null,
    state: 'unsaved', changes: ['tables/offers.yaml'] };
  await mockHost(page, { type: 'gitState', status, editing: true });
  const saveButton = page.getByRole('button', { name: saveLabel, exact: true });
  const reason = page.getByRole('textbox', { name: '변경 사유', exact: true });
  await reason.fill('저장 사유 유지');
  await expect(saveButton).toBeDisabled();
  expect(await messages(page)).toEqual([{ type: 'ready' }]);
  await deliver(page, { type: 'gitState', status, editing: false });
  await saveButton.click();
  expect((await messages(page)).at(-1)).toEqual({ type: 'gitSave', revision: 'revision-1', reason: '저장 사유 유지' });
  await deliver(page, { type: 'gitState', status, editing: false });
  for (const button of await page.getByRole('button').all()) await expect(button).toBeDisabled();
  await expect(reason).toBeDisabled();
  await deliver(page, { type: 'error', action: 'save', code: 'STALE_REVISION', message: '파일이 바뀌었습니다.' });
  await deliver(page, { type: 'gitState', status: { ...status, revision: 'revision-2' }, editing: false });
  await expect(page.getByRole('alert')).toHaveText('STALE_REVISION: 파일이 바뀌었습니다.');
  await expect(reason).toHaveValue('저장 사유 유지');
  await saveButton.click();
  expect((await messages(page)).at(-1)).toEqual({ type: 'gitSave', revision: 'revision-2', reason: '저장 사유 유지' });
  await expect(page.getByRole('alert')).toBeVisible();
  const saved: GitStatus = { ...status, repository: '/project', gitDir: '/project/.git', branch: 'main',
    state: 'unpublished', changes: [], ahead: 1,
    outgoing: [{ hash: 'saved-commit', reason: '저장 사유 유지', otherFiles: true }], otherChanges: ['src/game.ts'] };
  await deliver(page, { type: 'gitState', status: saved, editing: false,
    result: { action: 'save', completed: true, commit: 'saved-commit', status: saved, diagnostics: [] } });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(reason).toHaveValue('');
  await expect(outgoing(page)).toContainText('기획 외 파일 포함');
  await expect(page.getByText('기획 외 변경 파일 1개', { exact: true })).toBeVisible();
});

test('all conflict choices are required and preserved after a failed resolution', async ({ page }) => {
  const status: GitStatus = { ...cleanStatus(), state: 'conflict', mergeInProgress: true, conflicts: [
    { kind: 'row', file: 'tables/offers.yaml', table: 'offers', key: 'bundle',
      base: { sku: 'bundle', price: '+001.2300E+0002' }, ours: null, theirs: { sku: 'bundle', price: '0002.00' } },
    { kind: 'file', file: 'schemas/offers.yaml', managed: true, reason: '파일 전체를 선택하세요.',
      base: 'price: "+001.2300E+0002"\n', ours: 'price: "0002.00"\n', theirs: 'price: "0003.00"\n' },
  ] };
  await mockHost(page, { type: 'gitState', status, editing: false });
  const row = page.getByRole('group', { name: 'offers / bundle', exact: true });
  await expect(row.getByText('삭제', { exact: true })).toBeVisible();
  const file = page.getByRole('group', { name: 'schemas/offers.yaml', exact: true });
  expect(await file.locator('.git-literal').allTextContents()).toEqual([
    'price: "+001.2300E+0002"\n', 'price: "0002.00"\n', 'price: "0003.00"\n',
  ]);
  await row.getByRole('radio', { name: '내 변경 사용', exact: true }).check();
  const apply = page.getByRole('button', { name: '충돌 선택 적용', exact: true });
  await expect(apply).toBeDisabled();
  await file.getByRole('radio', { name: '기준 사용', exact: true }).check();
  await apply.click();
  const choices = [{ file: 'tables/offers.yaml', key: 'bundle', choice: 'ours' }, { file: 'schemas/offers.yaml', choice: 'base' }];
  expect((await messages(page)).at(-1)).toEqual({ type: 'gitResolve', revision: status.revision, choices });
  await expect(apply).toBeDisabled();
  for (const radio of await page.getByRole('radio').all()) await expect(radio).toBeDisabled();
  await deliver(page, { type: 'error', action: 'resolve', code: 'WRITE_FAILED', message: '선택을 적용하지 못했습니다.' });
  await deliver(page, { type: 'gitState', status: { ...status, revision: 'retry-revision' }, editing: false });
  await expect(row.getByRole('radio', { name: '내 변경 사용', exact: true })).toBeChecked();
  await expect(file.getByRole('radio', { name: '기준 사용', exact: true })).toBeChecked();
  await expect(page.getByRole('alert')).toContainText('WRITE_FAILED');
  await apply.click();
  expect((await messages(page)).at(-1)).toEqual({ type: 'gitResolve', revision: 'retry-revision', choices });
  const resolved = { ...cleanStatus(), state: 'unpublished' as const };
  await deliver(page, { type: 'gitState', status: resolved, editing: false,
    result: { action: 'resolve', completed: true, status: resolved, diagnostics: [
      { code: 'REF_MISSING', file: 'tables/offers.yaml', path: 'offers/bundle/currency', message: '옛 Key currency_gold 참조를 확인하세요.' },
    ] } });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('status', { name: '작업 결과', exact: true })).toHaveText('충돌 선택을 적용했습니다.');
  const diagnostics = page.getByRole('region', { name: '작업 후 검증 결과', exact: true });
  await expect(diagnostics).toContainText('offers/bundle/currency');
  await expect(diagnostics).toContainText('옛 Key currency_gold');
});

test('unmanaged file conflicts explain the restriction and never submit choices', async ({ page }) => {
  const status: GitStatus = { ...cleanStatus(), state: 'conflict', mergeInProgress: true, conflicts: [
    { kind: 'file', file: 'src/game.ts', managed: false, reason: '기획 외 파일은 별도로 해결하세요.',
      base: 'const price = "+001.2300E+0002";\n', ours: null, theirs: 'const price = "0002.00";\n' },
  ] };
  await mockHost(page, { type: 'gitState', status, editing: false });
  const conflict = page.getByRole('group', { name: 'src/game.ts', exact: true });
  await expect(conflict).toContainText('기획 외 파일은 별도로 해결하세요.');
  await expect(conflict.getByText('삭제', { exact: true })).toBeVisible();
  expect(await conflict.locator('.git-literal').allTextContents()).toEqual([
    'const price = "+001.2300E+0002";\n', 'const price = "0002.00";\n',
  ]);
  for (const radio of await conflict.getByRole('radio').all()) await expect(radio).toBeDisabled();
  await expect(page.getByRole('button', { name: '충돌 선택 적용', exact: true })).toBeDisabled();
  expect(await messages(page)).toEqual([{ type: 'ready' }]);
});
