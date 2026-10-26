import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { fixtureNotes, primeWorkspace } from './fixtures/library';

const welcomeTitle = '导入检查：公开项目首页';
const workflowTitle = '导入检查：公开项目流程';
const syntaxTitle = '导入检查：格式指南';

async function publicVault() {
  const zip = new JSZip();
  zip.file('公开项目库/学习笔记/项目首页.md', `---\ntitle: ${welcomeTitle}\n---\n# ${welcomeTitle}\n\n![[附件/项目图.svg]]\n\n[[技术开发/项目流程|${workflowTitle}]]\n\n[${syntaxTitle}](../技术开发/格式指南.md)`);
  zip.file('公开项目库/技术开发/项目流程.md', `# ${workflowTitle}\n\n公开的项目流程。\n\n[[学习笔记/项目首页|首页]]`);
  zip.file('公开项目库/技术开发/格式指南.md', `# ${syntaxTitle}\n\nMarkdown 格式。\n\n[[学习笔记/项目首页|首页]]`);
  zip.file('公开项目库/附件/项目图.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="purple"/></svg>');
  return { name: 'public-vault.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) };
}

test.use({ baseURL: 'http://127.0.0.1:5174' });

async function openImport(page: Page) {
  await page.getByRole('button', { name: '导入笔记', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '把你的知识，带到这里', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function allNotes(page: Page) {
  await page.locator('aside.sidebar').getByRole('button', { name: /^全部文档/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: '知识库', exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await primeWorkspace(page, fixtureNotes);
  await expect(page.getByRole('heading', { level: 1, name: /知识概览/ })).toBeVisible();
});

test('Obsidian ZIP retains folder categories, images, note links, and data after reload', async ({ page }) => {
  const importer = await openImport(page);
  await expect(importer.getByRole('link', { name: /下载示例知识库/ })).toHaveCount(0);

  await importer.getByRole('tab', { name: /ZIP 整库导入/ }).click();
  await importer.locator('input[type="file"]').setInputFiles(await publicVault());
  const stats = importer.locator('.im-stats > div');
  await expect(stats).toHaveCount(4);
  await expect(stats.nth(0).locator('strong')).toHaveText('3');
  await expect(stats.nth(1).locator('strong')).toHaveText('1');
  // Four cross-note links and one image reference are resolved in this vault.
  await expect(stats.nth(2).locator('strong')).toHaveText('5');
  await expect(stats.nth(3).locator('strong')).toHaveText('0');
  await expect(importer.locator('.im-warnings')).toHaveCount(0);
  await importer.getByRole('button', { name: '导入 3 篇笔记', exact: true }).click();
  await expect(importer).toHaveCount(0);

  await allNotes(page);
  const welcomeRow = page.locator('.notes-table tbody tr').filter({ hasText: welcomeTitle });
  await expect(welcomeRow).toBeVisible();
  await expect(welcomeRow.locator('.category-pill')).toHaveText('学习笔记');
  await expect(page.locator('.notes-table tbody tr').filter({ hasText: workflowTitle }).locator('.category-pill')).toHaveText('技术开发');
  await welcomeRow.click();

  const reader = page.getByRole('main').getByRole('region', { name: '知识库阅读区', exact: true });
  await expect(page.getByRole('dialog', { name: '笔记预览', exact: true })).toHaveCount(0);
  await expect(reader.getByRole('heading', { level: 1, name: welcomeTitle, exact: true })).toBeVisible();
  const importedImage = reader.getByRole('img', { name: '附件/项目图.svg', exact: true });
  await expect(importedImage).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => importedImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);

  await reader.getByRole('link', { name: workflowTitle, exact: true }).click();
  await expect(reader.getByRole('heading', { level: 1, name: workflowTitle, exact: true })).toBeVisible();
  await reader.getByRole('link', { name: '首页', exact: true }).click();
  await expect(reader.getByRole('heading', { level: 1, name: welcomeTitle, exact: true })).toBeVisible();
  await reader.getByRole('link', { name: syntaxTitle, exact: true }).click();
  await expect(reader.getByRole('heading', { level: 1, name: syntaxTitle, exact: true })).toBeVisible();
  await reader.getByRole('button', { name: '返回知识库', exact: true }).click();

  await page.reload();
  await allNotes(page);
  await page.locator('.notes-table tbody tr').filter({ hasText: welcomeTitle }).click();
  await expect(reader.getByRole('heading', { level: 1, name: welcomeTitle, exact: true })).toBeVisible();
  await expect.poll(() => reader.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await reader.getByRole('link', { name: workflowTitle, exact: true }).click();
  await expect(reader.getByRole('heading', { level: 1, name: workflowTitle, exact: true })).toBeVisible();
});

test('standalone Markdown warns about missing files and still imports into a chosen category', async ({ page }) => {
  const title = '独立笔记的链接检查';
  const importer = await openImport(page);
  await importer.getByRole('tab', { name: 'Markdown 文件', exact: true }).click();
  await importer.locator('input[type="file"]').setInputFiles({
    name: 'standalone-link-check.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# ${title}\n\n这篇笔记仍然可以阅读。\n\n[[不存在的关联笔记]]\n\n![[missing-image.png]]`, 'utf8'),
  });

  const stats = importer.locator('.im-stats > div');
  await expect(stats.nth(0).locator('strong')).toHaveText('1');
  await expect(stats.nth(1).locator('strong')).toHaveText('0');
  await expect(stats.nth(2).locator('strong')).toHaveText('0');
  await expect(stats.nth(3).locator('strong')).toHaveText('2');
  await expect(importer.locator('.im-warning-heading')).toContainText('部分链接需要补充文件，笔记内容仍可导入');
  await expect(importer.getByText(/本次没有包含附件/)).toBeVisible();
  await importer.getByRole('button', { name: '查看全部 3 项提示', exact: true }).click();
  await expect(importer.getByText(/missing-image\.png.*未找到/)).toBeVisible();
  await importer.getByLabel('知识库分类', { exact: true }).selectOption('生活灵感');
  await importer.getByRole('button', { name: '导入 1 篇笔记', exact: true }).click();

  await allNotes(page);
  const row = page.locator('.notes-table tbody tr').filter({ hasText: title });
  await expect(row.locator('.category-pill')).toHaveText('生活灵感');
  await row.click();
  const reader = page.getByRole('main').getByRole('region', { name: '知识库阅读区', exact: true });
  await expect(reader.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  await expect(reader).toContainText('这篇笔记仍然可以阅读。');
});
