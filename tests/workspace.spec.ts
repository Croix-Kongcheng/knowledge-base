import { expect, test, type Page } from '@playwright/test';
import type { ImportedNote } from '../src/lib/importer';
import legacyVault from './fixtures/legacy-vault';
import { fixtureNotes, primeWorkspace } from './fixtures/library';

test.use({ baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5174' });

const sidebar = (page: Page) => page.locator('aside.sidebar');
const metrics = (page: Page) => page.getByRole('region', { name: '知识库统计' }).locator('.metric-value');
const memberRows = (page: Page) => page.locator('.member-table tbody tr');

async function storedNotes(page: Page): Promise<ImportedNote[]> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('zhiyu-knowledge');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('workspace', 'readonly').objectStore('workspace').get('notes');
      get.onsuccess = () => { db.close(); resolve(get.result || []); };
      get.onerror = () => reject(get.error);
    };
  }));
}

test('a fresh workspace is empty and contains only the configured administrator without signing visitors in', async ({ page }) => {
  await page.goto('/');
  await expect(metrics(page)).toHaveText(['0篇', '0个', '0个', '1人']);
  const account = page.getByRole('button', { name: '账号菜单', exact: true });
  await expect(account).toContainText('访客');
  await expect(account).not.toContainText('空间管理员');
  await expect(page.getByText('这里还没有笔记', { exact: true })).toBeVisible();
  await expect(sidebar(page).locator('.sidebar-directory .folder-row')).toHaveCount(0);
  await sidebar(page).getByRole('button', { name: /^空间成员/ }).click();
  await expect(memberRows(page)).toHaveCount(1);
  await expect(memberRows(page)).toContainText('Project Admin');
  await expect(memberRows(page)).toContainText('admin@example.com');
  await expect(memberRows(page)).toContainText('空间管理员');
  for (const demo of ['林予', '陈一', '苏禾', '周也', '@example.com']) await expect(memberRows(page)).not.toContainText(demo);
  await sidebar(page).getByRole('button', { name: '知识图谱', exact: true }).click();
  await expect(page.getByText('知识从第一篇文档开始连接', { exact: true })).toBeVisible();
  await page.reload();
  await expect(metrics(page)).toHaveText(['0篇', '0个', '0个', '1人']);
  expect(await storedNotes(page)).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('zhiyu-user-v1'))).toBeNull();
});

test('upgrading removes built-in and previously imported demo notes while retaining real documents and their favorites', async ({ page }) => {
  const real = { ...fixtureNotes[0], id: 'real-created-document', title: '我的知识工作流', path: '04项目/我的知识工作流.md', category: '04项目', content: '# 我的知识工作流\n\n这是我自行编写的实际项目记录，不属于旧示例。' };
  const imported = { ...fixtureNotes[1], id: 'real-imported-document', title: '真实导入的项目资料', path: '03学习/真实项目.md', category: '03学习', author: '林予', avatar: '予' };
  const builtIns = Array.from({ length: 6 }, (_, i) => ({ ...fixtureNotes[0], id: `note-${i + 1}`, title: `旧内置示例 ${i + 1}` }));
  const oldNotes = [...builtIns, ...legacyVault, real, imported] as ImportedNote[];
  await primeWorkspace(page, oldNotes, {
    'zhiyu-notes-v1': oldNotes,
    'zhiyu-stars-v1': ['note-1', legacyVault[0].id, real.id, real.id, imported.id, 'deleted-document'],
    'zhiyu-user-v1': { name: '林予', email: 'linyu@example.com' },
  });
  await expect(metrics(page)).toHaveText(['2篇', '2个', '0个', '1人']);
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('访客');
  await expect.poll(async () => (await storedNotes(page)).map(note => note.id).sort()).toEqual([real.id, imported.id].sort());
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('zhiyu-stars-v1') || '[]'))).toEqual([real.id, imported.id]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zhiyu-notes-v1') || '[]').map((note: { id: string }) => note.id).sort())).toEqual([real.id, imported.id].sort());
  await sidebar(page).getByRole('button', { name: '我的收藏', exact: true }).click();
  await expect(page.locator('.notes-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.notes-table tbody')).toContainText(real.title);
  await expect(page.locator('.notes-table tbody')).toContainText(imported.title);
  await page.reload();
  await expect(metrics(page)).toHaveText(['2篇', '2个', '0个', '1人']);
  expect((await storedNotes(page)).map(note => note.id).sort()).toEqual([real.id, imported.id].sort());
  expect((await storedNotes(page)).find(note => note.id === imported.id)).toMatchObject({ author: 'Project Admin', avatar: 'PA', content: imported.content, path: imported.path });
});

test('a workspace containing only old examples stays empty after cleanup and reload', async ({ page }) => {
  const oldNotes = [...legacyVault, { ...fixtureNotes[0], id: 'note-1' }] as ImportedNote[];
  await primeWorkspace(page, oldNotes, { 'zhiyu-stars-v1': oldNotes.map(note => note.id) });
  await expect(metrics(page)).toHaveText(['0篇', '0个', '0个', '1人']);
  await expect.poll(() => storedNotes(page)).toEqual([]);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('zhiyu-stars-v1') || '[]'))).toEqual([]);
  await page.reload();
  await expect(metrics(page)).toHaveText(['0篇', '0个', '0个', '1人']);
});

test('the first cleanup resets old trial identities while retaining real notes and the selected theme', async ({ page }) => {
  await primeWorkspace(page, [fixtureNotes[0]], {
    'zhiyu-user-v1': { name: '以前注册的测试成员', email: 'old-trial@example.org' },
    'zhiyu-theme-v1': 'light',
  });
  await expect(metrics(page)).toHaveText(['1篇', '1个', '0个', '1人']);
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('访客');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await sidebar(page).getByRole('button', { name: /^空间成员/ }).click();
  await expect(memberRows(page)).toHaveCount(1);
  await expect(memberRows(page)).not.toContainText('old-trial@example.org');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zhiyu-workspace-cleanup-v1') || 'false'))).toBe(true);
});

test('the configured owner is normalized case insensitively, persists, and appears only once as administrator', async ({ page }) => {
  await primeWorkspace(page, [], { 'zhiyu-user-v1': { name: '旧显示名', email: ' admin@example.com ' } });
  const account = page.getByRole('button', { name: '账号菜单', exact: true });
  await expect(account).toContainText('Project Admin');
  await expect(account).toContainText('空间管理员');
  await sidebar(page).getByRole('button', { name: /^空间成员/ }).click();
  await expect(memberRows(page)).toHaveCount(1);
  await expect(memberRows(page).locator('.role-pill.admin')).toHaveText(/空间管理员/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zhiyu-user-v1') || 'null'))).toEqual({ name: 'Project Admin', email: 'admin@example.com' });
  await page.reload();
  await expect(account).toContainText('空间管理员');
  await expect(metrics(page)).toHaveText(['0篇', '0个', '0个', '1人']);
});

test('another email cannot gain the administrator role through a display name or stored role field', async ({ page }) => {
  await primeWorkspace(page, [], { 'zhiyu-workspace-cleanup-v1': true, 'zhiyu-user-v1': { name: 'Project Admin', email: 'reader@example.org', role: '空间管理员' } });
  const account = page.getByRole('button', { name: '账号菜单', exact: true });
  await expect(account).toContainText('协作成员');
  await expect(account).not.toContainText('空间管理员');
  await sidebar(page).getByRole('button', { name: /^空间成员/ }).click();
  await expect(memberRows(page)).toHaveCount(2);
  await expect(page.locator('.member-table .role-pill.admin')).toHaveCount(1);
  await expect(memberRows(page).filter({ hasText: 'reader@example.org' })).toContainText('协作成员');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zhiyu-user-v1') || 'null'))).toEqual({ name: 'Project Admin', email: 'reader@example.org' });
});
