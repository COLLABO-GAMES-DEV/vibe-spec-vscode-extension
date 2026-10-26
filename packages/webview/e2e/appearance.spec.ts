import { expect, test } from '@playwright/test';

for (const theme of [
  { name: 'dark', background: '#202124', foreground: '#eeeeee', surface: '#28292c', border: '#454649', secondary: '#37383b', input: '#303134', os: 'light' as const },
  { name: 'light', background: '#fafbfc', foreground: '#222324', surface: '#f0f1f2', border: '#c5c6c7', secondary: '#e4e5e6', input: '#ffffff', os: 'dark' as const },
]) test(`document, table and comparison follow the ${theme.name} VS Code palette even when the OS theme differs`, async ({ page, request }) => {
  await request.post('/__vibe/reset');
  await request.post('/__vibe/documents/fixture', { data: { source: '# 합성 문서\n\n읽기 쉬운 **본문**입니다.\n\n## 세부 기준\n\n| 항목 | 값 |\n| --- | --- |\n| 보상 | 12 |\n' } });
  await request.post('/__vibe/plans/fixture');
  await page.emulateMedia({ colorScheme: theme.os });
  async function open(url: string, selector: string) {
    await page.goto(url);
    await expect(page.locator(selector).first()).toBeVisible();
    await page.addStyleTag({ content: `:root { --vscode-editor-background:${theme.background}; --vscode-editor-foreground:${theme.foreground}; --vscode-foreground:${theme.foreground}; --vscode-sideBar-background:${theme.surface}; --vscode-panel-border:${theme.border}; --vscode-button-secondaryBackground:${theme.secondary}; --vscode-button-secondaryForeground:${theme.foreground}; --vscode-input-background:${theme.input}; --vscode-input-foreground:${theme.foreground}; }` });
  }
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
  await open('/?table=items', '[role="grid"]');
  await expect(page.getByRole('grid')).toHaveCSS('background-color', rgb(theme.background));
  await expect(page.getByRole('columnheader').first()).toHaveCSS('background-color', rgb(theme.surface));
  await expect(page.getByRole('button', { name: '찾기', exact: true })).toHaveCSS('background-color', rgb(theme.secondary));
  await open('/?mode=documents&document=' + encodeURIComponent('기획 문서'), '[data-testid="document-rich-editor"]');
  await expect(page.locator('.bn-editor')).toHaveCSS('background-color', rgb(theme.background));
  await expect(page.locator('.bn-editor')).toHaveCSS('color', rgb(theme.foreground));
  await expect(page.getByRole('heading', { name: '합성 문서' })).toHaveCount(1);
  expect(await page.getByRole('heading', { name: '합성 문서' }).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeLessThanOrEqual(32);
  await expect(page.getByLabel('문서 편집 대상 선택')).toHaveCSS('background-color', rgb(theme.input));
  await open('/?mode=plans&plan=price-review', '[aria-label="기준안과 대안 비교"]');
  await expect(page.getByRole('columnheader').first()).toHaveCSS('background-color', rgb(theme.surface));
  await expect(page.getByRole('button', { name: '현재 파일 다시 읽기' })).toHaveCSS('background-color', rgb(theme.secondary));
  await expect(page.getByRole('navigation', { name: '기획 목록' })).toHaveCount(0);
});
