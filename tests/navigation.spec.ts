import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/backend';

const longTitle = '跨越多级目录的无人机协同巡检研究记录与完整文档标题验收';
const folders = [
  '01科研专题与长期研究资料', '02无人机与电网协同研究', '03输电线路混合巡检模型',
  '04任务分配和路径规划方法', '05论文精读与原始推导记录', '06多阶段算法与实验对照',
  '07约束条件与可行解验证', '08最终方案与复现实验归档',
];
const deepPath = folders.join('/');
const originalContent = `# ${longTitle}\n\n## 研究目标\n\n这是用于检查宽屏阅读、目录浏览与页面内编辑的独立测试文档。\n\n## 模型与约束\n\n阅读正文应当拥有足够空间，多级文件夹和长路径都不应遮挡正文或文档大纲。\n\n### 实验记录\n\n| 参数 | 说明 |\n| --- | --- |\n| 路径长度 | 可重复验证 |\n\n\`\`\`text\n${'long-content-'.repeat(35)}\n\`\`\`\n\n## 后续工作\n\n继续整理公开研究资料。`;

const reader = (page: Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });
const directory = (page: Page) => page.locator('aside.sidebar');
const editor = (page: Page) => page.getByRole('region', { name: '编辑笔记', exact: true });

async function seedWorkspace(page: Page, baseURL: string) {
  const account = await page.request.post(`${baseURL}/api/auth/register`, { data: {
    name: '目录验收作者', email: 'navigation@isolated-browser.test', password: 'Isolated-navigation-password-2026!',
  } });
  expect(account.status()).toBe(201);
  const note = (id: string, title: string, path: string, content = '# 独立测试资料\n\n用于检查目录滚动。') => ({
    id, title, path, content, category: path.split('/')[0], tags: ['界面验收'], color: '#8b7cf8',
  });
  const notes = [
    note('navigation-deep-note', longTitle, `${deepPath}/${longTitle}.md`, originalContent),
    note('navigation-root-note', '其他目录里的参考资料', '99参考资料/其他目录里的参考资料.md'),
    ...Array.from({ length: 34 }, (_, index) => note(`navigation-scroll-${index}`, `目录滚动检查资料${String(index + 1).padStart(2, '0')}`, `${folders[0]}/归档参考资料${String(index + 1).padStart(2, '0')}.md`)),
  ];
  const response = await page.request.post(`${baseURL}/api/notes/import`, { data: { notes } });
  expect(response.status()).toBe(201);
  await page.goto(`${baseURL}/#note/navigation-deep-note`);
  await expect(reader(page).getByRole('heading', { level: 1, name: longTitle, exact: true })).toBeVisible();
}

async function assertNoPageOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

test('the document sidebar can collapse, reopen and persist its keyboard-adjusted width', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const sidebar = directory(page);
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole('button', { name: /^全部文档/ })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: '最近更新', exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: '我的收藏', exact: true })).toHaveCount(0);

  const initialWidth = (await sidebar.boundingBox())!.width;
  expect(initialWidth).toBeGreaterThanOrEqual(240);
  const separator = page.getByRole('separator', { name: '调整侧栏宽度', exact: true });
  await separator.focus();
  for (let count = 0; count < 6; count++) await separator.press('ArrowRight');
  let widerWidth = (await sidebar.boundingBox())!.width;
  expect(widerWidth).toBeGreaterThan(initialWidth);
  expect(widerWidth).toBeLessThanOrEqual(520);
  const grip = (await separator.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 48, grip.y + grip.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())?.width || 0).toBeGreaterThan(widerWidth);
  widerWidth = (await sidebar.boundingBox())!.width;
  await page.reload();
  await expect.poll(async () => (await sidebar.boundingBox())?.width || 0).toBeCloseTo(widerWidth, 0);

  const readerBeforeCollapse = (await reader(page).boundingBox())!.width;
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await expect.poll(async () => (await reader(page).boundingBox())?.width || 0).toBeGreaterThan(readerBeforeCollapse + 200);
  await page.reload();
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await expect(reader(page).getByRole('heading', { level: 1, name: longTitle, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expect(sidebar).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())?.width || 0).toBeCloseTo(widerWidth, 0);
  await assertNoPageOverflow(page);
});

test('clicking a folder toggles it without navigation and deep documents remain reachable by scrolling and search', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const sidebar = directory(page);
  const tree = sidebar.getByRole('tree', { name: '知识库文件夹', exact: true });
  const rootButton = tree.getByRole('button', { name: folders[0], exact: true });
  const childFolder = tree.getByRole('button', { name: folders.slice(0, 2).join('/'), exact: true });
  await expect(childFolder).toBeVisible();
  const before = page.url();
  await rootButton.click();
  await expect(childFolder).toHaveCount(0);
  await expect(page).toHaveURL(before);
  await expect(reader(page).getByRole('heading', { level: 1, name: longTitle, exact: true })).toBeVisible();
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/notes/index' && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect(childFolder).toHaveCount(0);
  await rootButton.click();
  await expect(childFolder).toBeVisible();
  await expect(page).toHaveURL(before);

  const deepFile = tree.getByRole('button', { name: longTitle, exact: true });
  await deepFile.scrollIntoViewIfNeeded();
  await expect(deepFile).toBeVisible();
  await expect(deepFile).toHaveAttribute('title', `${deepPath}/${longTitle}.md`);
  const availableLabelWidth = await deepFile.locator('span').evaluate(element => element.getBoundingClientRect().width);
  expect(availableLabelWidth).toBeGreaterThanOrEqual(90);
  const horizontalScroll = await sidebar.locator('.ft-tree-scroll').evaluate(element => {
    element.scrollLeft = element.scrollWidth;
    return { width: element.clientWidth, content: element.scrollWidth, left: element.scrollLeft };
  });
  expect(horizontalScroll.content).toBeGreaterThan(horizontalScroll.width);
  expect(horizontalScroll.left).toBeGreaterThan(0);

  const lastArchive = tree.getByRole('button', { name: '目录滚动检查资料34', exact: true });
  await lastArchive.scrollIntoViewIfNeeded();
  await expect(lastArchive).toBeVisible();
  const scrollTop = await sidebar.locator('.ft-tree-scroll').evaluate(element => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);

  const search = sidebar.getByRole('textbox', { name: '搜索文档目录', exact: true });
  await search.fill('完整文档标题验收');
  await expect(deepFile).toBeVisible();
  await expect(lastArchive).toHaveCount(0);
  await expect(page).toHaveURL(before);
  await search.clear();
  await expect(lastArchive).toHaveCount(1);
  await assertNoPageOverflow(page);
});

test('the wider reader contains long paths and editing stays in the page with cancel and durable save', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  for (const [width, minimum] of [[1440, 640], [1920, 850]]) {
    await page.setViewportSize({ width, height: 1100 });
    await expect.poll(async () => (await reader(page).locator('.kr-markdown').boundingBox())?.width || 0).toBeGreaterThanOrEqual(minimum);
    const meta = (await reader(page).locator('.kr-meta').boundingBox())!;
    const document = (await reader(page).locator('.kr-document').boundingBox())!;
    const outline = (await reader(page).getByRole('complementary', { name: '文档大纲', exact: true }).boundingBox())!;
    expect(meta.x + meta.width).toBeLessThanOrEqual(document.x + document.width + 1);
    expect(meta.x + meta.width).toBeLessThanOrEqual(outline.x + 1);
    await expect(reader(page).getByRole('combobox', { name: '移动到文件夹', exact: true })).toHaveCount(0);
    const folderPath = reader(page).locator('.kr-folder-path');
    const box = (await folderPath.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(outline.x + 1);
    await assertNoPageOverflow(page);
  }

  await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('region', { name: '编辑笔记', exact: true })).toBeVisible();
  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  await expect.poll(async () => {
    const tools = (await editor(page).locator('.ne-editor-top').boundingBox())!;
    const input = (await editor(page).getByLabel('笔记内容', { exact: true }).boundingBox())!;
    return input.y - (tools.y + tools.height);
  }).toBeGreaterThanOrEqual(-1);
  await page.screenshot({ path: '/tmp/knowledge-inline-editor.png', fullPage: true });
  await editor(page).getByLabel('笔记内容', { exact: true }).fill('这份未保存草稿应在取消后丢弃。');
  page.once('dialog', dialog => dialog.dismiss());
  await editor(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor(page).getByLabel('笔记内容', { exact: true })).toHaveValue('这份未保存草稿应在取消后丢弃。');
  page.once('dialog', dialog => dialog.accept());
  await editor(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(reader(page)).toContainText('这是用于检查宽屏阅读');
  await expect(reader(page)).not.toContainText('这份未保存草稿');

  await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
  const savedContent = `${originalContent}\n\n页面内保存成功，刷新后仍然存在。`;
  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  await editor(page).getByLabel('笔记内容', { exact: true }).fill(savedContent);
  await editor(page).getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(reader(page)).toContainText('页面内保存成功');
  await page.reload();
  await expect(reader(page)).toContainText('刷新后仍然存在');
  const persisted = (await (await page.request.get(`${backend.baseURL}/api/notes`)).json()).notes.find((note: { id: string }) => note.id === 'navigation-deep-note');
  expect(persisted.content).toBe(savedContent);
  await page.screenshot({ path: '/tmp/knowledge-wide-reader.png', fullPage: true });
});

test('mobile navigation opens as a dismissible drawer without horizontal page overflow', async ({ page, backend }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedWorkspace(page, backend.baseURL);
  await assertNoPageOverflow(page);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expect(directory(page)).toBeVisible();
  await expect(directory(page).getByRole('tree', { name: '知识库文件夹', exact: true })).toBeVisible();
  await assertNoPageOverflow(page);
  await page.screenshot({ path: '/tmp/knowledge-mobile-directory.png', fullPage: true });
  await page.getByRole('button', { name: '关闭文档导航', exact: true }).click();
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await assertNoPageOverflow(page);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  const file = directory(page).getByRole('button', { name: '其他目录里的参考资料', exact: true });
  const otherFolder = directory(page).getByRole('button', { name: '99参考资料', exact: true });
  await expect(otherFolder).toBeVisible();
  if (await otherFolder.getAttribute('aria-expanded') !== 'true') await otherFolder.click();
  await expect(file).toBeVisible();
  await file.click();
  await expect(reader(page).getByRole('heading', { level: 1, name: '其他目录里的参考资料', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await assertNoPageOverflow(page);
});
