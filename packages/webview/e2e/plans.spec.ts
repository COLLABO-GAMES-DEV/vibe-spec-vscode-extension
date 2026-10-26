import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { PlanView } from '@vibe-spec/core';
import type { PlansState } from '../src/plansProtocol';

const plan = 'price-review';
async function open(page: Page) {
  await page.goto('/?mode=plans&plan=' + plan);
  await expect(page.getByRole('heading', { name: '묶음 가격 검토', exact: true })).toBeVisible();
}
async function inspect(request: APIRequestContext): Promise<PlanView> {
  const response = await request.post('/__vibe/plans', { data: { type: 'ready', name: plan, client: 'inspection' } });
  expect(response.ok()).toBe(true);
  return (await response.json() as PlansState).view!;
}
const row = (page: Page, path: string) => page.getByRole('table', { name: '기준안과 대안 비교' })
  .getByRole('row').filter({ has: page.getByRole('rowheader', { name: path, exact: true }) });
async function external(request: APIRequestContext, values: Record<string, string>) {
  const response = await request.post('/__vibe/external', { data: { table: 'offers', key: 'bundle', values } });
  expect(response.ok()).toBe(true);
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__vibe/reset')).ok()).toBe(true);
  expect((await request.post('/__vibe/plans/fixture')).ok()).toBe(true);
});

test('compares core baseline/A/B values, marks only touched alternatives, and identifies baseline editing', async ({ page }) => {
  await open(page);
  await expect(page.locator('.plan-status')).toContainText('기획중');
  const price = row(page, 'offers/bundle/price');
  await expect(price.getByRole('cell')).toHaveText(['+001.2300E+0002', '150.000', '+001.2300E+0002']);
  await expect(price.getByRole('cell').nth(1)).toHaveAttribute('data-touched', 'true');
  await expect(price.getByRole('cell').nth(2)).toHaveAttribute('data-touched', 'false');
  await expect(row(page, 'offers/bundle/count').getByRole('cell')).toHaveText(['900719925474099312345', '900719925474099312345', '2']);
  await page.getByText('출처', { exact: true }).click();
  await expect(page.getByLabel('기획 정보')).toContainText('source.xlsx');
  await page.goto('/?table=offers');
  await expect(page.getByText('편집 대상: 기준안', { exact: true })).toBeVisible();
});

test('human status changes persist through core and can return from review to draft', async ({ page, request }) => {
  await open(page);
  await page.getByRole('button', { name: '컨펌 전으로 변경' }).click();
  await expect(page.locator('.plan-status')).toContainText('컨펌 전');
  expect((await inspect(request)).plan.status).toBe('review');
  await page.getByRole('button', { name: '기획중으로 변경' }).click();
  await expect(page.locator('.plan-status')).toContainText('기획중');
  expect((await inspect(request)).plan.status).toBe('draft');
});

test('approval requires confirmation and archives both patches while applying only the chosen variant', async ({ page, request }) => {
  const before = await inspect(request);
  await open(page);
  await page.getByRole('button', { name: 'A안 확정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '대안 확정 확인' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  expect((await inspect(request)).revision).toBe(before.revision);
  await page.getByRole('button', { name: 'A안 확정', exact: true }).click();
  await dialog.getByRole('button', { name: '확인하고 확정' }).click();
  await expect(page.getByLabel('기획 정보')).toContainText('A안 선택 · 변경분 보관됨');
  await expect(page.getByRole('button', { name: /안 확정$|으로 변경$/ })).toHaveCount(0);
  const archived = await inspect(request);
  expect(archived.plan).toMatchObject({ status: 'approved', selected: 'A', variants: ['A', 'B'] });
  expect(archived.variants).toEqual(before.variants);
  await expect(row(page, 'offers/bundle/price').getByRole('cell').first()).toHaveText('150.000');
  await expect(row(page, 'offers/bundle/count').getByRole('cell').first()).toHaveText('900719925474099312345');
  await page.reload();
  await expect(page.getByRole('heading', { name: '보관된 변경분' })).toBeVisible();
  await page.getByText('B안 변경분 · plans/price-review/B.yaml', { exact: true }).click();
  await expect(page.getByLabel('대안 변경분')).toContainText('"offers/bundle/count": "2"');
});

test('external changes require explicit reload, then show old/current/alternative warnings and inherited current values', async ({ page, request }) => {
  await open(page);
  await external(request, { price: '200.000' });
  await expect(page.getByRole('alert').filter({ hasText: '파일이 변경되었습니다' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'A안 확정', exact: true })).toBeDisabled();
  await expect(row(page, 'offers/bundle/price').getByRole('cell').first()).toHaveText('+001.2300E+0002');
  await page.getByRole('button', { name: '현재 파일 다시 읽기' }).click();
  await expect(row(page, 'offers/bundle/price').getByRole('cell')).toHaveText(['200.000', '150.000', '200.000']);
  const warnings = page.getByLabel('검토 진단');
  await expect(warnings).toContainText('경고 · BASE_CHANGED');
  await expect(warnings.locator('dt')).toHaveText(['이전 기준', '현재 기준', 'A안']);
  await expect(warnings.locator('dd')).toHaveText(['+001.2300E+0002', '200.000', '150.000']);
  await expect(page.getByRole('button', { name: 'A안 확정', exact: true })).toBeEnabled();
});

for (const operation of ['planStatus', 'planApprove'] as const) {
  test(`a racing ${operation} keeps the opening revision, reports stale rejection, and never retries`, async ({ page, request }) => {
    const before = await inspect(request), sent: unknown[] = [];
    await open(page);
    await page.route('**/__vibe/plans', async route => {
      const body = route.request().postDataJSON();
      if (body.type === operation) {
        sent.push(body);
        await external(request, { price: '222.000' });
      }
      await route.continue();
    });
    if (operation === 'planStatus') await page.getByRole('button', { name: '컨펌 전으로 변경' }).click();
    else {
      await page.getByRole('button', { name: 'A안 확정', exact: true }).click();
      await page.getByRole('button', { name: '확인하고 확정' }).click();
    }
    await expect(page.getByRole('alert').filter({ hasText: 'STALE_REVISION' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: '파일이 변경되었습니다' })).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ revision: before.revision, name: plan });
    expect((await inspect(request)).plan.status).toBe('draft');
    await expect(row(page, 'offers/bundle/price').getByRole('cell').first()).toHaveText('+001.2300E+0002');
    await expect(page.getByRole('button', { name: '컨펌 전으로 변경' })).toBeDisabled();
    await page.unroute('**/__vibe/plans');
    await page.getByRole('button', { name: '현재 파일 다시 읽기' }).click();
    await expect(row(page, 'offers/bundle/price').getByRole('cell').first()).toHaveText('222.000');
    await expect(page.getByRole('alert').filter({ hasText: 'STALE_REVISION' })).toHaveCount(0);
  });
}

test('only the sidebar-selected plan occupies the center, even with dozens of plans; an unselected panel explains where to start', async ({ page, request }) => {
  const view = await inspect(request);
  const plans = Array.from({ length: 45 }, (_, index) => ({ name: `review-${index}`, title: `합성 검토 ${index}`, status: 'review', variants: ['A', 'B'] }));
  const empty = { type: 'plansState', revision: view.revision, plans, replace: true };
  // The real VS Code bridge receives a replace state when a sidebar command opens a plan.
  await page.addInitScript(state => {
    Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: { type: string }) => {
      if (message.type === 'ready') window.postMessage(state, '*');
    } }) });
  }, empty);
  await page.goto('/?mode=plans');
  await expect(page.getByLabel('기획 선택 안내')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '기획 목록' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /합성 검토/ })).toHaveCount(0);
  await page.evaluate(state => window.postMessage(state, '*'), { ...empty, selected: view.plan.name, view });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(view.plan.title);
  await expect(page.getByLabel('기획 선택 안내')).toHaveCount(0);
  expect((await page.getByRole('table').boundingBox())!.y).toBeLessThan(450);
  const next = { ...view, plan: { ...view.plan, name: 'second', title: '두 번째 합성 검토', status: 'review' as const } };
  await page.evaluate(state => window.postMessage(state, '*'), { ...empty, selected: 'second', view: next });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('두 번째 합성 검토');
  await expect(page.locator('.plan-status')).toHaveText('컨펌 전');
  await expect(page.getByRole('heading', { name: view.plan.title, exact: true })).toHaveCount(0);
  await page.evaluate(state => window.postMessage(state, '*'), { ...empty, plans: [] });
  await expect(page.getByLabel('기획 선택 안내')).toContainText('아직 기획이 없습니다');
  await expect(page.getByRole('table')).toHaveCount(0);
});
