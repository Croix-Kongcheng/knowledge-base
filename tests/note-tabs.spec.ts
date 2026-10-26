import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/backend';
import { closeTab, EMPTY_NOTE_TABS, openTab, pinTab, reconcileTabs } from '../src/lib/noteTabs';

const notes = [
  { id: 'tabs-alpha', title: '第一篇研究资料', path: '研究资料/第一篇研究资料.md' },
  { id: 'tabs-beta', title: '第二篇实验记录', path: '研究资料/第二篇实验记录.md' },
  { id: 'tabs-gamma', title: '第三篇总结与后续计划以及需要完整保留的长文档名称', path: '研究资料/第三篇总结与后续计划.md' },
];
const strip = (page: Page) => page.getByRole('tablist', { name: '打开的笔记', exact: true });
const tab = (page: Page, index: number) => strip(page).getByRole('tab', { name: notes[index].title, exact: true });
const file = (page: Page, index: number) => page.locator(`aside.sidebar .ft-file[data-note-id="${notes[index].id}"]`);
const reader = (page: Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });
const editor = (page: Page) => page.getByRole('region', { name: '编辑笔记', exact: true });

async function seedWorkspace(page: Page, baseURL: string) {
  const registration = await page.request.post(`${baseURL}/api/auth/register`, { data: {
    name: '标签页验收作者', email: 'note-tabs@isolated.test', password: 'Isolated-note-tabs-2026!',
  } });
  expect(registration.status()).toBe(201);
  const imported = await page.request.post(`${baseURL}/api/notes/import`, { data: { notes: notes.map(note => ({
    ...note, category: '研究资料', content: `# ${note.title}\n\n${note.title}的独立验收正文。`, tags: [],
  })) } });
  expect(imported.status()).toBe(201);
  await page.goto(`${baseURL}/#note/${notes[0].id}`);
  await expect(reader(page).getByRole('heading', { level: 1, name: notes[0].title, exact: true })).toBeVisible();
  await expect(tab(page, 0)).toBeVisible();
}

test('tab state preserves pinned notes and a single replaceable preview through reopen, close and deleted-note reconciliation', () => {
  const original = openTab(EMPTY_NOTE_TABS, 'alpha');
  const pinned = pinTab(original, 'alpha');
  const preview = openTab(pinned, 'beta');
  const activatePinned = openTab(preview, 'alpha');
  const replacement = openTab(activatePinned, 'gamma');
  expect(replacement).toEqual({ ids: ['alpha', 'gamma'], previewId: 'gamma' });
  expect(original).toEqual({ ids: ['alpha'], previewId: 'alpha' });
  expect(preview).toEqual({ ids: ['alpha', 'beta'], previewId: 'beta' });
  expect(openTab(replacement, 'alpha')).toBe(replacement);
  expect(openTab(replacement, 'gamma', true)).toEqual({ ids: ['alpha', 'gamma'], previewId: null });
  expect(closeTab(replacement, 'gamma')).toEqual({ ids: ['alpha'], previewId: null });
  expect(closeTab(replacement, 'alpha')).toEqual({ ids: ['gamma'], previewId: 'gamma' });
  expect(reconcileTabs(replacement, ['alpha'])).toEqual({ ids: ['alpha'], previewId: null });
  expect(reconcileTabs({ ids: ['alpha', 'alpha', 'gamma'], previewId: 'missing' }, ['alpha', 'gamma'])).toEqual({ ids: ['alpha', 'gamma'], previewId: null });
});

test('single click replaces only the italic preview, while double click in the directory or tab strip retains notes', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  await expect(tab(page, 0).locator('.nt-title')).toHaveCSS('font-style', 'italic');
  await file(page, 1).click();
  await expect(tab(page, 0)).toHaveCount(0);
  await expect(tab(page, 1)).toHaveAttribute('aria-selected', 'true');
  await file(page, 2).dblclick();
  await expect(tab(page, 1)).toHaveCount(0);
  await expect(tab(page, 2).locator('.nt-title')).toHaveCSS('font-style', 'normal');

  await file(page, 0).click();
  await file(page, 1).click();
  await expect(strip(page).getByRole('tab')).toHaveCount(2);
  await expect(tab(page, 0)).toHaveCount(0);
  await expect(tab(page, 2)).toBeVisible();
  await expect(tab(page, 1).locator('.nt-title')).toHaveCSS('font-style', 'italic');
  await file(page, 2).click();
  await expect(tab(page, 2)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 2).locator('.nt-title')).toHaveCSS('font-style', 'normal');
  await expect(tab(page, 1)).toBeVisible();

  await tab(page, 1).dblclick();
  await expect(tab(page, 1).locator('.nt-title')).toHaveCSS('font-style', 'normal');
  await file(page, 0).click();
  await expect(strip(page).getByRole('tab')).toHaveCount(3);
  await expect(tab(page, 0)).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: '/tmp/knowledge-note-tabs.png', fullPage: true });
  await strip(page).getByRole('button', { name: `关闭 ${notes[1].title}`, exact: true }).click();
  await expect(tab(page, 1)).toHaveCount(0);
  await expect(tab(page, 0)).toHaveAttribute('aria-selected', 'true');
  await strip(page).getByRole('button', { name: `关闭 ${notes[0].title}`, exact: true }).click();
  await expect(tab(page, 2)).toHaveAttribute('aria-selected', 'true');
  await expect(reader(page).getByRole('heading', { level: 1, name: notes[2].title, exact: true })).toBeVisible();
  await strip(page).getByRole('button', { name: `关闭 ${notes[2].title}`, exact: true }).click();
  await expect(strip(page)).toHaveCount(0);
  await expect(reader(page)).toHaveCount(0);
});

test('tabs support keyboard pinning, switching and closing and restore pinned notes without overflowing mobile pages', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  await file(page, 0).focus();
  await file(page, 0).press('Control+Enter');
  await expect(tab(page, 0).locator('.nt-title')).toHaveCSS('font-style', 'normal');
  await file(page, 1).click();
  await strip(page).getByRole('button', { name: `固定预览文档 ${notes[1].title}`, exact: true }).click();
  await file(page, 2).click();
  await expect(strip(page).getByRole('tab')).toHaveCount(3);
  await tab(page, 2).focus();
  await tab(page, 2).press('Home');
  await expect(tab(page, 0)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 0)).toBeFocused();
  await tab(page, 0).press('ArrowRight');
  await expect(tab(page, 1)).toHaveAttribute('aria-selected', 'true');
  await tab(page, 1).press('End');
  await expect(tab(page, 2)).toHaveAttribute('aria-selected', 'true');
  await tab(page, 2).press('Delete');
  await expect(tab(page, 2)).toHaveCount(0);
  await expect(tab(page, 1)).toHaveAttribute('aria-selected', 'true');

  await page.reload();
  await expect(tab(page, 0)).toBeVisible();
  await expect(tab(page, 1)).toBeVisible();
  await expect(tab(page, 1)).toHaveAttribute('aria-selected', 'true');
  await file(page, 2).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(tab(page, 2)).toBeInViewport();
  const scrollArea = await page.locator('.nt-strip').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
  expect(scrollArea.content).toBeGreaterThan(scrollArea.width);
  await strip(page).getByRole('button', { name: `关闭 ${notes[2].title}`, exact: true }).click();
  await expect(tab(page, 1)).toHaveAttribute('aria-selected', 'true');
});

test('switching or closing a dirty inline editor requires accepting draft discard and never saves silently', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  const draft = '未保存草稿：切换文档或关闭标签之前需要由用户决定。';
  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  await editor(page).getByLabel('笔记内容', { exact: true }).fill(draft);
  page.once('dialog', dialog => dialog.dismiss());
  await file(page, 1).click();
  await expect(editor(page).getByLabel('笔记内容', { exact: true })).toHaveValue(draft);
  await expect(tab(page, 0)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 1)).toHaveCount(0);
  page.once('dialog', dialog => dialog.dismiss());
  await strip(page).getByRole('button', { name: `关闭 ${notes[0].title}`, exact: true }).click();
  await expect(editor(page).getByLabel('笔记内容', { exact: true })).toHaveValue(draft);
  page.once('dialog', dialog => dialog.accept());
  await file(page, 1).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(tab(page, 1)).toHaveAttribute('aria-selected', 'true');
  const saved = await page.request.get(`${backend.baseURL}/api/notes/${notes[0].id}`);
  expect((await saved.json()).note.content).not.toContain(draft);
});
