import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/backend';

const password = 'Isolated-directory-context-2026!';
const sourceId = 'context-primary';
const nestedId = 'context-nested';
const sourceTitle = '01.巡检计划';
const sourceFolder = '研究资料/待整理';
const imageAlias = 'asset:context-diagram';
const sourceContent = '# 原始 Markdown 标题\n\n重命名只改变文件名，保留原始正文。\n\n![巡检示意](asset:context-diagram)\n\n[参考链接](#note/context-reference)';
const reader = (page: Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });
const editor = (page: Page) => page.getByRole('region', { name: '编辑笔记', exact: true });
const file = (page: Page, id = sourceId) => page.locator(`aside.sidebar .ft-file[data-note-id="${id}"]`);
const folder = (page: Page, folderPath = sourceFolder) => page.locator(`aside.sidebar .ft-folder[data-folder="${folderPath}"]`);
const menu = (page: Page) => page.getByRole('menu');
const folderName = (page: Page) => page.getByRole('textbox', { name: '文件夹名称', exact: true });
const noteName = (page: Page) => page.getByRole('textbox', { name: '笔记名称', exact: true });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}

async function waitForDocumentCache(page: Page, revision: number) {
  await expect.poll(() => page.evaluate(({ id, expectedRevision }) => new Promise<boolean>(resolve => {
    const request = indexedDB.open('zhiyu-server-cache-v1', 2);
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('index') || !db.objectStoreNames.contains('documents')) { db.close(); resolve(false); return; }
      const transaction = db.transaction(['index', 'documents']);
      const index = transaction.objectStore('index').get('current');
      const note = transaction.objectStore('documents').get(id);
      transaction.oncomplete = () => {
        resolve(Boolean(index.result?.notes?.some((entry: { id: string }) => entry.id === id) && note.result?.content && note.result?.revision === expectedRevision));
        db.close();
      };
      transaction.onerror = () => { db.close(); resolve(false); };
    };
  }), { id: sourceId, expectedRevision: revision })).toBe(true);
}

async function register(page: Page, baseURL: string, name = '右键目录作者', email = 'context-owner@isolated.test') {
  const response = await page.request.post(`${baseURL}/api/auth/register`, { data: { name, email, password } });
  expect(response.status()).toBe(201);
}

async function noteData(page: Page, baseURL: string, id = sourceId) {
  const response = await page.request.get(`${baseURL}/api/notes/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).note;
}

async function libraryIndex(page: Page, baseURL: string) {
  const response = await page.request.get(`${baseURL}/api/notes/index`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function seedWorkspace(page: Page, baseURL: string) {
  await register(page, baseURL);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="#8064d4"/></svg>';
  const upload = await page.request.post(`${baseURL}/api/assets/context-diagram`, {
    data: Buffer.from(svg), headers: { 'Content-Type': 'image/svg+xml', 'X-Asset-Path': encodeURIComponent('附件/示意.svg') },
  });
  expect(upload.status()).toBe(201);
  const note = (id: string, title: string, notePath: string, content = '# 独立目录验收正文') => ({
    id, title, path: notePath, category: notePath.split('/')[0], content, tags: ['目录验收'],
  });
  const imported = await page.request.post(`${baseURL}/api/notes/import`, { data: { notes: [
    { ...note(sourceId, sourceTitle, `${sourceFolder}/${sourceTitle}.md`, sourceContent), attachments: { '附件/示意.svg': imageAlias } },
    note(nestedId, '02.实验明细', `${sourceFolder}/深层记录/02.实验明细.md`, '# 深层记录\n\n子目录里的原始实验数据。'),
    note('context-collision', '保留文件', `${sourceFolder}/保留文件.md`, '# 不应覆盖\n\n同名文档需要完整保留。'),
    note('context-destination', '目标资料', '研究资料/目标目录/目标资料.md'),
    note('context-reference', '03.参考链接', '参考资料/03.参考链接.md', '# 关联文档\n\n[返回巡检计划](#note/context-primary)'),
  ] } });
  expect(imported.status()).toBe(201);
  await page.goto(`${baseURL}/#note/${sourceId}`);
  await expect(reader(page).getByRole('heading', { level: 1, name: sourceTitle, exact: true })).toBeVisible();
  await expect(file(page)).toHaveAttribute('draggable', 'true');
}

async function chooseFolderAction(page: Page, action: string, folderPath = sourceFolder) {
  await folder(page, folderPath).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: action, exact: true }).click();
}

async function chooseNoteAction(page: Page, action: string, id = sourceId) {
  await file(page, id).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: action, exact: true }).click();
}

async function assertBodyAndAsset(page: Page) {
  await expect(reader(page)).toContainText('重命名只改变文件名，保留原始正文。');
  const image = reader(page).getByRole('img', { name: '巡检示意', exact: true });
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete ? element.naturalWidth : 0)).toBe(30);
  await expect(reader(page).getByRole('link', { name: '参考链接', exact: true })).toHaveAttribute('href', '#note/context-reference');
}

test('folder context actions create durable empty nested folders and open new notes directly in the inline editor', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const readingUrl = page.url();
  const expanded = await folder(page).getAttribute('aria-expanded');
  await chooseFolderAction(page, '新建文件夹');
  await expect(folderName(page)).toBeFocused();
  await expect(folderName(page)).toHaveValue('');
  await folderName(page).fill('新实验');
  await folderName(page).press('Enter');
  const newFolder = `${sourceFolder}/新实验`;
  await expect(folder(page, newFolder)).toBeVisible();
  await expect(folder(page)).toHaveAttribute('aria-expanded', expanded!);
  await expect(page).toHaveURL(readingUrl);
  expect((await libraryIndex(page, backend.baseURL)).folders).toEqual(expect.arrayContaining([expect.objectContaining({ path: newFolder })]));
  await page.reload();
  await expect(folder(page, newFolder)).toBeVisible();

  await chooseFolderAction(page, '新建笔记', newFolder);
  await expect(noteName(page)).toBeFocused();
  await noteName(page).fill('03.新建实验记录');
  await noteName(page).press('Enter');
  await expect(editor(page)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(editor(page).getByLabel('笔记标题', { exact: true })).toHaveValue('03.新建实验记录');
  const content = '# 新实验记录\n\n直接在目标文件夹下新建并保存。';
  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  await editor(page).getByLabel('笔记内容', { exact: true }).fill(content);
  await editor(page).getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(reader(page)).toContainText('直接在目标文件夹下新建并保存。');
  const saved = (await libraryIndex(page, backend.baseURL)).notes.find((note: { path: string }) => note.path === `${newFolder}/03.新建实验记录.md`);
  expect(saved).toBeTruthy();
  expect((await noteData(page, backend.baseURL, saved.id)).content).toBe(content);
  await page.reload();
  await expect(reader(page)).toContainText('直接在目标文件夹下新建并保存。');
  await expect(file(page, saved.id)).toHaveAttribute('data-parent', newFolder);
});

test('renaming a folder moves all descendant paths while preserving document bodies, attachments and pinned tabs', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const before = await noteData(page, backend.baseURL);
  const nestedBefore = await noteData(page, backend.baseURL, nestedId);
  const emptyFolder = await page.request.post(`${backend.baseURL}/api/folders`, { data: { parent: sourceFolder, name: '空目录' } });
  expect(emptyFolder.status()).toBe(201);
  await page.reload();
  await expect(folder(page, `${sourceFolder}/空目录`)).toBeVisible();
  await file(page).dblclick();
  const nestedFolder = folder(page, `${sourceFolder}/深层记录`);
  if (await nestedFolder.getAttribute('aria-expanded') !== 'true') await nestedFolder.click();
  await file(page, nestedId).dblclick();
  const strip = page.getByRole('tablist', { name: '打开的笔记', exact: true });
  await expect(strip.getByRole('tab')).toHaveCount(2);
  await chooseFolderAction(page, '重命名');
  await expect(folderName(page)).toHaveValue('待整理');
  await folderName(page).fill('已整理研究');
  await folderName(page).press('Enter');
  const renamed = '研究资料/已整理研究';
  await expect(folder(page, renamed)).toBeVisible();
  await expect(folder(page)).toHaveCount(0);
  await expect(file(page, nestedId)).toHaveAttribute('data-parent', `${renamed}/深层记录`);
  expect(await noteData(page, backend.baseURL)).toMatchObject({
    id: before.id, path: `${renamed}/${sourceTitle}.md`, title: before.title,
    content: before.content, ownerId: before.ownerId, attachments: before.attachments,
  });
  expect(await noteData(page, backend.baseURL, nestedId)).toMatchObject({
    path: `${renamed}/深层记录/02.实验明细.md`, content: nestedBefore.content, ownerId: nestedBefore.ownerId,
  });
  const index = await libraryIndex(page, backend.baseURL);
  expect(index.notes.some((note: { path: string }) => note.path.startsWith(`${sourceFolder}/`))).toBe(false);
  expect(index.folders).toEqual(expect.arrayContaining([expect.objectContaining({ path: `${renamed}/空目录` })]));
  await strip.getByRole('tab', { name: sourceTitle, exact: true }).click();
  await assertBodyAndAsset(page);
  await page.reload();
  await expect(strip.getByRole('tab')).toHaveCount(2);
  await expect(file(page)).toHaveAttribute('data-parent', renamed);
  await expect(folder(page, `${renamed}/空目录`)).toBeVisible();
  await assertBodyAndAsset(page);
});

test('note renaming updates the filename, reader and pinned tab without rewriting Markdown or breaking ID links', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const before = await noteData(page, backend.baseURL);
  await file(page).dblclick();
  const readingUrl = page.url();
  await chooseNoteAction(page, '重命名');
  await expect(noteName(page)).toHaveValue(sourceTitle);
  await noteName(page).fill('01.巡检计划修订');
  await noteName(page).press('Enter');
  await expect(reader(page).getByRole('heading', { level: 1, name: '01.巡检计划修订', exact: true })).toBeVisible();
  await expect(file(page)).toHaveAttribute('title', `${sourceFolder}/01.巡检计划修订.md`);
  const tab = page.getByRole('tablist', { name: '打开的笔记', exact: true }).getByRole('tab', { name: '01.巡检计划修订', exact: true });
  await expect(tab).toBeVisible();
  await expect(tab.locator('.nt-title')).toHaveCSS('font-style', 'normal');
  await expect(page).toHaveURL(readingUrl);
  expect(await noteData(page, backend.baseURL)).toMatchObject({
    id: before.id, title: '01.巡检计划修订', path: `${sourceFolder}/01.巡检计划修订.md`,
    content: sourceContent, ownerId: before.ownerId, attachments: before.attachments,
  });
  await assertBodyAndAsset(page);
  await reader(page).getByRole('link', { name: '参考链接', exact: true }).click();
  await reader(page).getByRole('link', { name: '返回巡检计划', exact: true }).click();
  await expect(reader(page).getByRole('heading', { level: 1, name: '01.巡检计划修订', exact: true })).toBeVisible();
  await page.reload();
  await expect(tab).toBeVisible();
  await assertBodyAndAsset(page);
});

test('context menus keep other members read-only and deletion requires the owner confirmation', async ({ page, browser, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const original = await noteData(page, backend.baseURL);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await register(other, backend.baseURL, '其他右键成员', 'context-other@isolated.test');
    await other.goto(`${backend.baseURL}/#note/${sourceId}`);
    await expect(reader(other).getByRole('heading', { level: 1, name: sourceTitle, exact: true })).toBeVisible();
    await file(other).click({ button: 'right' });
    await expect(menu(other).getByRole('menuitem', { name: '重命名', exact: true })).toBeDisabled();
    await expect(menu(other).getByRole('menuitem', { name: '删除笔记', exact: true })).toBeDisabled();
    await other.keyboard.press('Escape');
    await folder(other).click({ button: 'right' });
    await expect(menu(other).getByRole('menuitem', { name: '重命名', exact: true })).toBeDisabled();
    await expect(menu(other).getByRole('menuitem', { name: '删除文件夹', exact: true })).toBeDisabled();
    await expect(menu(other).getByRole('menuitem', { name: '新建笔记', exact: true })).toBeEnabled();
    await expect(menu(other).getByRole('menuitem', { name: '新建文件夹', exact: true })).toBeEnabled();
    expect((await other.request.patch(`${backend.baseURL}/api/notes/${sourceId}/rename`, { data: { name: '越权重命名', revision: original.revision } })).status()).toBe(403);
    expect((await other.request.delete(`${backend.baseURL}/api/notes/${sourceId}`)).status()).toBe(403);
    expect((await other.request.patch(`${backend.baseURL}/api/folders`, { data: { path: sourceFolder, name: '越权文件夹' } })).status()).toBe(403);
    expect((await other.request.delete(`${backend.baseURL}/api/folders`, { data: { path: sourceFolder } })).status()).toBe(403);
    expect(await noteData(page, backend.baseURL)).toMatchObject({ path: original.path, content: original.content, revision: original.revision });
  } finally { await otherContext.close(); }

  await chooseNoteAction(page, '删除笔记');
  const confirmation = page.getByRole('dialog', { name: '删除笔记', exact: true });
  await expect(confirmation).toContainText(sourceTitle);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(file(page)).toBeVisible();
  await chooseNoteAction(page, '删除笔记');
  await confirmation.getByRole('button', { name: /确认删除|删除笔记/, exact: true }).click();
  await expect(file(page)).toHaveCount(0);
  expect((await page.request.get(`${backend.baseURL}/api/notes/${sourceId}`)).status()).toBe(404);
  await page.reload();
  await expect(file(page)).toHaveCount(0);
  expect((await libraryIndex(page, backend.baseURL)).notes).toHaveLength(4);
});

test('deleting a folder confirms the whole subtree, retries failed writes and preserves unrelated open notes', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const original = await noteData(page, backend.baseURL);
  await waitForDocumentCache(page, original.revision);
  expect((await page.request.post(`${backend.baseURL}/api/folders`, { data: { parent: sourceFolder, name: '空目录' } })).status()).toBe(201);
  await page.reload();
  await expect(folder(page, `${sourceFolder}/空目录`)).toBeVisible();
  await file(page).dblclick();
  const nestedFolder = folder(page, `${sourceFolder}/深层记录`);
  if (await nestedFolder.getAttribute('aria-expanded') !== 'true') await nestedFolder.click();
  await file(page, nestedId).dblclick();
  const references = folder(page, '参考资料');
  if (await references.getAttribute('aria-expanded') !== 'true') await references.click();
  await file(page, 'context-reference').dblclick();
  await expect(reader(page).getByRole('heading', { level: 1, name: '03.参考链接', exact: true })).toBeVisible();
  const readingUrl = page.url();
  const tabs = page.getByRole('tablist', { name: '打开的笔记', exact: true });
  await expect(tabs.getByRole('tab')).toHaveCount(3);
  const confirmation = page.getByRole('dialog', { name: '删除文件夹', exact: true });
  let deleteRequests = 0;
  page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/folders') deleteRequests += 1; });
  await chooseFolderAction(page, '删除文件夹');
  await expect(confirmation).toContainText(sourceFolder);
  await expect(confirmation).toContainText('2 个子文件夹');
  await expect(confirmation).toContainText('3 篇笔记');
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(deleteRequests).toBe(0);
  expect((await libraryIndex(page, backend.baseURL)).notes).toHaveLength(5);

  let attempts = 0;
  const deleteStarted = deferred();
  const deleteGate = deferred();
  await page.route('**/api/folders', async route => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return; }
    attempts += 1;
    if (attempts === 1) { await route.fulfill({ status: 503, json: { error: '暂时无法删除，请重试。' } }); return; }
    deleteStarted.resolve();
    await deleteGate.promise;
    await route.continue();
  });
  try {
    await chooseFolderAction(page, '删除文件夹');
    await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(confirmation.getByRole('alert')).toContainText('暂时无法删除');
    await expect(folder(page)).toBeVisible();
    expect((await libraryIndex(page, backend.baseURL)).notes).toHaveLength(5);
    await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
    await deleteStarted.promise;
    await expect(confirmation.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled();
    await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeVisible();
    expect(attempts).toBe(2);
    deleteGate.resolve();
    await expect(confirmation).toHaveCount(0);
  } finally {
    deleteGate.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await expect(folder(page)).toHaveCount(0);
  await expect(file(page)).toHaveCount(0);
  await expect(file(page, nestedId)).toHaveCount(0);
  await expect(page).toHaveURL(readingUrl);
  await expect(reader(page).getByRole('heading', { level: 1, name: '03.参考链接', exact: true })).toBeVisible();
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  expect((await libraryIndex(page, backend.baseURL)).notes).toHaveLength(2);
  expect((await libraryIndex(page, backend.baseURL)).folders.some((entry: { path: string }) => entry.path.startsWith(`${sourceFolder}/`))).toBe(false);
  expect((await page.request.get(`${backend.baseURL}/api/notes/${sourceId}`)).status()).toBe(404);
  expect((await page.request.get(`${backend.baseURL}/api/notes/${nestedId}`)).status()).toBe(404);
  await expect.poll(() => page.evaluate(id => new Promise<boolean>(resolve => {
    const request = indexedDB.open('zhiyu-server-cache-v1', 2);
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(['index', 'documents']);
      const index = transaction.objectStore('index').get('current');
      const note = transaction.objectStore('documents').get(id);
      transaction.oncomplete = () => { resolve(Boolean(index.result && !index.result.notes.some((entry: { id: string }) => entry.id === id) && !note.result)); db.close(); };
      transaction.onerror = () => { db.close(); resolve(false); };
    };
  }), sourceId)).toBe(true);
  await page.reload();
  await expect(folder(page)).toHaveCount(0);
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  await expect(reader(page).getByRole('heading', { level: 1, name: '03.参考链接', exact: true })).toBeVisible();
});

test('folder deletion preserves a declined unsaved edit and removes an accepted editor only after success', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
  const draft = `${sourceContent}\n\n还没有保存的实验记录。`;
  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  await editor(page).getByLabel('笔记内容', { exact: true }).fill(draft);
  await chooseFolderAction(page, '删除文件夹');
  const confirmation = page.getByRole('dialog', { name: '删除文件夹', exact: true });
  page.once('dialog', dialog => dialog.dismiss());
  await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('未保存的修改已保留');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor(page).getByLabel('笔记内容', { exact: true })).toHaveValue(draft);
  expect((await noteData(page, backend.baseURL)).content).toBe(sourceContent);
  expect((await libraryIndex(page, backend.baseURL)).notes).toHaveLength(5);

  await chooseFolderAction(page, '删除文件夹');
  page.once('dialog', dialog => dialog.accept());
  await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(editor(page)).toHaveCount(0);
  await expect(folder(page)).toHaveCount(0);
  expect((await libraryIndex(page, backend.baseURL)).notes).toHaveLength(2);
  expect((await page.request.get(`${backend.baseURL}/api/notes/${sourceId}`)).status()).toBe(404);
  await page.reload();
  await expect(folder(page)).toHaveCount(0);
});

test('an empty folder can be deleted from its keyboard menu with a confirmation that fits mobile screens', async ({ page, backend }) => {
  await register(page, backend.baseURL);
  expect((await page.request.post(`${backend.baseURL}/api/folders`, { data: { parent: '', name: '可删除空目录' } })).status()).toBe(201);
  await page.goto(backend.baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByRole('button', { name: /打开侧栏|展开侧栏|打开文档目录|展开文档目录/ });
  if (!(await folder(page, '可删除空目录').isVisible())) await toggle.click();
  const empty = folder(page, '可删除空目录');
  await empty.focus();
  await empty.press('Shift+F10');
  await menu(page).getByRole('menuitem', { name: '删除文件夹', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '删除文件夹', exact: true });
  await expect(confirmation).toContainText('0 个子文件夹');
  await expect(confirmation).toContainText('0 篇笔记');
  const box = (await confirmation.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(empty).toHaveCount(0);
  expect((await libraryIndex(page, backend.baseURL)).folders).toEqual([]);
  await page.reload();
  await expect(empty).toHaveCount(0);
});

test('name collisions never overwrite files and context menus support cancellation, keyboard use and viewport edges', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const before = await noteData(page, backend.baseURL);
  const collisionBefore = await noteData(page, backend.baseURL, 'context-collision');
  const nestedBefore = await noteData(page, backend.baseURL, nestedId);
  await chooseFolderAction(page, '重命名');
  await folderName(page).fill('目标目录');
  await folderName(page).press('Enter');
  await expect(page.getByRole('alert')).toContainText(/同名|已存在/);
  await expect(folderName(page)).toHaveValue('目标目录');
  await folderName(page).press('Escape');
  await expect(folderName(page)).toHaveCount(0);
  await expect(folder(page)).toBeVisible();
  expect(await noteData(page, backend.baseURL, nestedId)).toMatchObject({ path: nestedBefore.path, content: nestedBefore.content, revision: nestedBefore.revision });

  await chooseNoteAction(page, '重命名');
  await noteName(page).fill('保留文件');
  await noteName(page).press('Enter');
  await expect(page.getByRole('alert')).toContainText(/同名|已存在/);
  await expect(noteName(page)).toHaveValue('保留文件');
  await noteName(page).press('Escape');
  expect(await noteData(page, backend.baseURL)).toMatchObject({ path: before.path, content: before.content, revision: before.revision });
  expect(await noteData(page, backend.baseURL, 'context-collision')).toMatchObject({ path: collisionBefore.path, content: collisionBefore.content, revision: collisionBefore.revision });

  await file(page).focus();
  await file(page).press('Shift+F10');
  await expect(menu(page)).toBeVisible();
  await menu(page).getByRole('menuitem', { name: '重命名', exact: true }).focus();
  await page.keyboard.press('Enter');
  await noteName(page).fill('取消后不保存的名字');
  await noteName(page).press('Escape');
  await expect(file(page)).toHaveAccessibleName(sourceTitle);
  await file(page).dispatchEvent('contextmenu', { button: 2, clientX: 1438, clientY: 1098, bubbles: true });
  await expect(menu(page)).toBeVisible();
  const box = (await menu(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
  expect(box.y + box.height).toBeLessThanOrEqual(1100);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(file(page)).toBeFocused();
  expect((await noteData(page, backend.baseURL)).title).toBe(before.title);
});

test('a folder rename revalidates a pending older document response before the next inline edit is saved', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const original = await noteData(page, backend.baseURL);
  await waitForDocumentCache(page, original.revision);
  const oldResponseReady = deferred();
  const oldResponseGate = deferred();
  const returnedRevisions: number[] = [];
  let detailRequests = 0;
  let capturedRevision: number | undefined;
  await page.route(`**/api/notes/${sourceId}`, async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const requestNumber = ++detailRequests;
    const response = await route.fetch();
    const { note } = await response.json();
    if (requestNumber === 1) {
      // The backend has already produced this revision. Delaying only its
      // delivery reproduces a response that arrives after a successful rename.
      capturedRevision = note.revision;
      oldResponseReady.resolve();
      await oldResponseGate.promise;
    }
    returnedRevisions.push(note.revision);
    await route.fulfill({ response });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await oldResponseReady.promise;
    expect(capturedRevision).toBe(original.revision);
    // The old live response is still blocked; the editable reader can only
    // have recovered this body from the previously persisted browser cache.
    await expect(reader(page)).toContainText('重命名只改变文件名，保留原始正文。');
    await expect(file(page)).toHaveAttribute('draggable', 'true');
    await chooseFolderAction(page, '重命名');
    await folderName(page).fill('请求完成前已改名');
    await folderName(page).press('Enter');
    const renamedFolder = '研究资料/请求完成前已改名';
    await expect(file(page)).toHaveAttribute('data-parent', renamedFolder);
    const renamed = await noteData(page, backend.baseURL);
    expect(renamed.revision).toBeGreaterThan(original.revision);
    expect(renamed.content).toBe(sourceContent);
    expect(detailRequests).toBe(1);

    oldResponseGate.resolve();
    // Joining the old in-flight request must not satisfy the newer directory
    // revision: a second real detail request must fetch the renamed document.
    await expect.poll(() => detailRequests).toBeGreaterThanOrEqual(2);
    await expect.poll(() => returnedRevisions).toContain(renamed.revision);
    await waitForDocumentCache(page, renamed.revision);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
    const savedContent = `${sourceContent}\n\n旧请求晚到后仍可正常保存这份修改。`;
    await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
    await editor(page).getByLabel('笔记内容', { exact: true }).fill(savedContent);
    const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/notes/${sourceId}` && response.request().method() === 'PATCH');
    await editor(page).getByRole('button', { name: '保存修改', exact: true }).click();
    expect((await savedResponse).status()).toBe(200);
    await expect(editor(page)).toHaveCount(0);
    await expect(reader(page)).toContainText('旧请求晚到后仍可正常保存这份修改。');
    const saved = await noteData(page, backend.baseURL);
    expect(saved).toMatchObject({ path: `${renamedFolder}/${sourceTitle}.md`, content: savedContent, ownerId: original.ownerId, attachments: original.attachments });
    expect(saved.revision).toBeGreaterThan(renamed.revision);
  } finally { oldResponseGate.resolve(); }
});
