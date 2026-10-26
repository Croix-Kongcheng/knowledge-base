import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

test.use({ baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5174' });

import { fixtureNotes, primeWorkspace, workflowTitle, markdownTitle, reactTitle, designTitle } from './fixtures/library';

const sidebar = (page: Page) => page.locator('aside.sidebar');

test.beforeEach(async ({ page }) => {
  await primeWorkspace(page, fixtureNotes, { 'zhiyu-stars-v1': ['fixture-workflow', 'fixture-design'] });
  await expect(page.getByRole('heading', { level: 1, name: /知识概览/ })).toBeVisible();
});

test('desktop overview shows actual library totals and working nested navigation', async ({ page }) => {
  const metrics = page.getByRole('region', { name: '知识库统计' });
  await expect(metrics.locator('article')).toHaveCount(4);
  await expect(metrics.locator('.metric-value')).toHaveText(['6篇', '4个', '0个', '1人']);
  await expect(page.getByRole('heading', { name: '知识在生长' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '知识分布' })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: '知识概览', exact: true })).toHaveClass(/active/);
  const parentMenu = sidebar(page).getByRole('button', { name: '知识库', exact: true });
  await parentMenu.click();
  await expect(parentMenu).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar(page).getByRole('button', { name: /^全部文档/ })).toHaveCount(0);
  await parentMenu.click();
  await sidebar(page).getByRole('button', { name: /^全部文档/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: '知识库', exact: true })).toBeVisible();
  await expect(page.locator('.notes-table tbody tr')).toHaveCount(6);
});

test('search filters notes by a matching keyword', async ({ page }) => {
  await page.getByRole('textbox', { name: '搜索笔记' }).fill('React');
  await expect(page.locator('.notes-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.notes-table tbody tr')).toContainText(reactTitle);
  await expect(page.locator('.notes-table tbody')).not.toContainText(workflowTitle);
  await page.getByRole('textbox', { name: '搜索笔记' }).fill('没有这篇笔记的独特关键词');
  await expect(page.getByText('没有找到相关笔记', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索笔记' })).toHaveValue('');
  await expect(page.locator('.notes-table tbody tr')).toHaveCount(5);
});

test('document opens in the main workspace with outline and working internal links', async ({ page }) => {
  await page.locator('.notes-table tbody tr').filter({ hasText: workflowTitle }).click();
  const reader = page.getByRole('region', { name: '知识库阅读区', exact: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(sidebar(page)).toBeVisible();
  await expect(reader.getByRole('heading', { level: 1, name: workflowTitle, exact: true })).toBeVisible();
  await expect(reader.getByRole('heading', { name: '我的工作流', exact: true })).toBeVisible();
  const outline = reader.getByRole('complementary', { name: '文档大纲', exact: true });
  await outline.getByRole('button', { name: '我的工作流', exact: true }).click();
  await expect(reader.locator('#kr-我的工作流')).toBeInViewport();
  await expect(reader.getByRole('heading', { level: 1, name: workflowTitle, exact: true })).toHaveCSS('font-size', '27px');
  await reader.getByRole('link', { name: 'Markdown 写作指南', exact: true }).click();
  await expect(reader.getByRole('heading', { level: 1, name: markdownTitle, exact: true })).toBeVisible();
  await expect(reader.getByRole('table')).toBeVisible();
  await expect(reader.locator('pre')).toContainText('const ideas');
  await expect(reader.getByRole('region', { name: '反向链接', exact: true }).getByRole('button', { name: new RegExp(reactTitle) })).toBeVisible();
  await expect(page).toHaveURL(/#note\/fixture-markdown$/);
  await page.reload();
  await expect(reader.getByRole('heading', { level: 1, name: markdownTitle, exact: true })).toBeVisible();
  await reader.getByRole('button', { name: '返回知识库', exact: true }).click();
  await expect(reader).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: '知识库', exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/#note\//);
});

test('new Markdown note can be previewed, saved, and found after reload', async ({ page }) => {
  const noteTitle = '自动化检查：知识整理实践';
  await sidebar(page).getByRole('button', { name: /^全部文档/ }).click();
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '记录新的灵感' });
  await editor.getByLabel('笔记标题', { exact: true }).fill(noteTitle);
  await editor.getByLabel('知识分类', { exact: true }).selectOption('学习笔记');
  await editor.getByLabel('添加标签', { exact: false }).fill('自动化，知识整理, 自动化');
  await editor.getByLabel('笔记内容', { exact: true }).fill(`# ${noteTitle}\n\n把灵感变成 **可检索的知识**。\n\n## 一个公式\n\n$$\nE = mc^2\n$$\n\n- 收集\n- 整理`);
  await editor.getByRole('tab', { name: '预览', exact: true }).click();
  await expect(editor.getByRole('heading', { name: noteTitle, exact: true })).toBeVisible();
  await expect(editor.locator('.ne-preview strong')).toHaveText('可检索的知识');
  await editor.getByRole('button', { name: '保存笔记', exact: true }).click();
  const reader = page.getByRole('region', { name: '知识库阅读区', exact: true });
  await expect(reader.getByRole('heading', { name: noteTitle, exact: true })).toBeVisible();
  await expect(reader.locator('.kr-tags span')).toHaveText(['# 自动化', '# 知识整理']);
  await expect(reader.locator('.katex-display .katex-html')).toBeVisible();
  await expect(reader.locator('.katex-error')).toHaveCount(0);
  await reader.getByRole('button', { name: '返回知识库', exact: true }).click();
  await page.reload();
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(noteTitle);
  await expect(page.locator('.notes-table tbody tr')).toHaveCount(1);
  await page.locator('.notes-table tbody tr').filter({ hasText: noteTitle }).click();
  await expect(page.getByRole('region', { name: '知识库阅读区', exact: true }).getByRole('heading', { name: noteTitle, exact: true })).toBeVisible();
});

test('favorites can be added and removed from the collection', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: /^全部文档/ }).click();
  const reactRow = page.locator('.notes-table tbody tr').filter({ hasText: reactTitle });
  await reactRow.getByRole('button', { name: `收藏 ${reactTitle}`, exact: true }).click();
  await expect(reactRow.getByRole('button', { name: `取消收藏 ${reactTitle}`, exact: true })).toBeVisible();
  await sidebar(page).getByRole('button', { name: '我的收藏', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '我的收藏', exact: true })).toBeVisible();
  await expect(reactRow).toBeVisible();
  await reactRow.getByRole('button', { name: `取消收藏 ${reactTitle}`, exact: true }).click();
  await expect(reactRow).toHaveCount(0);
  await expect(page.locator('.notes-table tbody tr')).toHaveCount(2);
});

test('category filter narrows notes and restores all categories', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: /^全部文档/ }).click();
  const filter = page.getByRole('combobox', { name: '按分类筛选' });
  await filter.selectOption('产品设计');
  await expect(page.locator('.notes-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.notes-table tbody')).toContainText(designTitle);
  await expect(page.locator('.notes-table tbody')).not.toContainText(reactTitle);
  await filter.selectOption('技术开发');
  await expect(page.locator('.notes-table tbody tr')).toHaveCount(3);
  await expect(page.locator('.notes-table tbody')).toContainText(reactTitle);
  await filter.selectOption('全部分类');
  await expect(page.locator('.notes-table tbody tr')).toHaveCount(6);
});

test('Obsidian theme changes persist and follow the system appearance', async ({ page }) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'obsidian');
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Obsidian 浅色/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('heading', { level: 1, name: /知识概览/ })).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^跟随系统/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'obsidian');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('zhiyu-theme-v1'))).toBe('system');
});

test('nested vault directories remain browsable and documents can move into an existing directory', async ({ page }) => {
  const zip = new JSZip();
  zip.file('ExampleVault/04项目/04无人机课题/目录检查样例.md', '# 目录检查样例\n\n公开的项目知识。\n\n[[项目索引]]');
  zip.file('ExampleVault/04项目/项目索引.md', '# 项目索引\n\n[[04无人机课题/目录检查样例]]');
  await page.getByRole('button', { name: '导入笔记', exact: true }).click();
  const importer = page.getByRole('dialog', { name: '把你的知识，带到这里', exact: true });
  await importer.getByRole('tab', { name: /^ZIP 整库导入/ }).click();
  await importer.locator('input[type="file"]').setInputFiles({ name: 'ExampleVault-directories.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
  await importer.getByRole('button', { name: '导入 2 篇笔记', exact: true }).click();
  await expect(importer).toHaveCount(0);

  const tree = sidebar(page).getByRole('tree', { name: '知识库文件夹', exact: true });
  await expect(tree.getByRole('button', { name: /^04项目/ })).toBeVisible();
  await tree.getByRole('button', { name: /^04无人机课题/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: '知识库', exact: true })).toBeVisible();
  await expect(page.locator('.notes-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.notes-table tbody')).toContainText('目录检查样例');
  await tree.getByRole('button', { name: '目录检查样例', exact: true }).click();
  const reader = page.getByRole('region', { name: '知识库阅读区', exact: true });
  await expect(reader.locator('.kr-breadcrumbs')).toContainText('04项目 / 04无人机课题');
  await expect(reader.getByRole('combobox', { name: '移动到文件夹', exact: true })).toHaveValue('04项目/04无人机课题');
  await reader.getByRole('combobox', { name: '移动到文件夹', exact: true }).selectOption('技术开发');
  await expect(reader.locator('.kr-breadcrumbs')).toContainText('技术开发');
  await reader.getByRole('link', { name: '项目索引', exact: true }).click();
  await expect(reader.getByRole('heading', { level: 1, name: '项目索引', exact: true })).toBeVisible();
  await reader.getByRole('link', { name: '04无人机课题/目录检查样例', exact: true }).click();
  await expect(reader.getByRole('heading', { level: 1, name: '目录检查样例', exact: true })).toBeVisible();
  await expect(reader.getByRole('combobox', { name: '移动到文件夹', exact: true })).toHaveValue('技术开发');
});

test('relationship graph uses real note links and its search opens a document in the workspace', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: '知识图谱', exact: true }).click();
  const graph = page.getByRole('region', { name: '知识库关系图谱', exact: true });
  await expect(graph.getByRole('img', { name: /^知识图谱，6 篇笔记、2 条关联/ })).toBeVisible();
  await expect(graph.locator('canvas')).toBeVisible();
  await graph.getByRole('checkbox', { name: '显示孤立文档', exact: true }).uncheck();
  await expect(graph.locator('.obsidian-graph-counts')).toHaveText('3 篇文档2 条关联');
  await graph.getByRole('button', { name: '放大图谱', exact: true }).click();
  await graph.getByRole('button', { name: '缩小图谱', exact: true }).click();
  await graph.getByRole('button', { name: '图谱复位', exact: true }).click();
  const graphSearch = graph.getByRole('textbox', { name: '筛选图谱中的文档', exact: true });
  await graphSearch.fill('绝无匹配的图谱关键词');
  await expect(graph.getByText('没有符合筛选条件的文档', { exact: true })).toBeVisible();
  await graphSearch.fill('React');
  await expect(graph.getByRole('img', { name: /^知识图谱，1 篇笔记、0 条关联/ })).toBeVisible();
  await graph.getByRole('button', { name: reactTitle, exact: true }).click();
  await expect(page.getByRole('region', { name: '知识库阅读区', exact: true }).getByRole('heading', { level: 1, name: reactTitle, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('registration validates fields and persists only the local profile', async ({ page }) => {
  await page.getByRole('button', { name: '账号菜单', exact: true }).click();
  await page.getByRole('button', { name: '注册 / 登录', exact: true }).click();
  const account = page.getByRole('dialog', { name: '欢迎来到知屿' });
  await account.getByRole('button', { name: '创建我的知识空间', exact: false }).click();
  await expect(account.getByRole('alert')).toHaveText('给自己起一个名字吧。');
  await account.getByLabel('你的名字', { exact: true }).fill('测试小屿');
  await account.getByLabel('邮箱地址', { exact: true }).fill('invalid-email');
  await account.getByRole('button', { name: '创建我的知识空间', exact: false }).click();
  await expect(account.getByRole('alert')).toHaveText('请输入有效的邮箱地址。');
  await account.getByLabel('邮箱地址', { exact: true }).fill('test-island@example.com');
  await account.getByLabel('密码', { exact: true }).fill('short');
  await account.getByLabel('确认密码', { exact: true }).fill('short');
  await account.getByRole('button', { name: '创建我的知识空间', exact: false }).click();
  await expect(account.getByRole('alert')).toHaveText('密码至少需要 8 个字符。');
  await account.getByLabel('密码', { exact: true }).fill('demo-password-123');
  await account.getByRole('button', { name: '创建我的知识空间', exact: false }).click();
  await expect(account.getByRole('alert')).toHaveText('两次输入的密码不一致，请再确认一下。');
  await account.getByLabel('确认密码', { exact: true }).fill('demo-password-123');
  await account.getByRole('button', { name: '创建我的知识空间', exact: false }).click();
  await expect(account).toHaveCount(0);
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('测试小屿');
  const savedProfile = await page.evaluate(() => JSON.parse(localStorage.getItem('zhiyu-user-v1') || 'null'));
  expect(savedProfile).toEqual({ name: '测试小屿', email: 'test-island@example.com' });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('demo-password-123');
  await page.reload();
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('测试小屿');
});

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('sidebar opens, navigates, and closes within the viewport', async ({ page }) => {
    await expect(sidebar(page)).not.toHaveClass(/is-open/);
    await page.getByRole('button', { name: '展开导航', exact: true }).click();
    await expect(sidebar(page)).toHaveClass(/is-open/);
    await expect(sidebar(page).getByRole('button', { name: '知识概览', exact: true })).toBeInViewport();
    await sidebar(page).getByRole('button', { name: /^全部文档/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: '知识库', exact: true })).toBeVisible();
    await expect(sidebar(page)).not.toHaveClass(/is-open/);
    await expect(page.getByRole('button', { name: '展开导航', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
    await page.locator('.notes-table tbody tr').filter({ hasText: workflowTitle }).click();
    const reader = page.getByRole('region', { name: '知识库阅读区', exact: true });
    await expect(reader.getByRole('heading', { level: 1, name: workflowTitle, exact: true })).toBeVisible();
    await expect(reader.getByRole('button', { name: '返回知识库', exact: true })).toBeInViewport();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  });
});
