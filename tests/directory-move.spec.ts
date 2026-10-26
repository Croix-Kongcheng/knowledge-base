import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/backend';

const password = 'Isolated-directory-move-2026!';
const sourceId = 'directory-move-source';
const content = '# 移动正文\n\n拖动目录只修改位置，正文、附件和关联文档保持不变。\n\n![目录测试图](asset:directory-move-svg)\n\n[关联资料](#note/directory-move-link)';
const reader = (page: Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });
const editor = (page: Page) => page.getByRole('region', { name: '编辑笔记', exact: true });
const file = (page: Page, id = sourceId) => page.locator(`aside.sidebar .ft-file[data-note-id="${id}"]`);
const destination = (page: Page) => page.locator('aside.sidebar .ft-folder[data-folder="目标目录"]');

async function register(page: Page, baseURL: string, name = '目录作者', email = 'directory-owner@isolated.test') {
  const response = await page.request.post(`${baseURL}/api/auth/register`, { data: { name, email, password } });
  expect(response.status()).toBe(201);
}

async function noteData(page: Page, baseURL: string, id = sourceId) {
  const response = await page.request.get(`${baseURL}/api/notes/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).note;
}

async function seedWorkspace(page: Page, baseURL: string, includeDuplicate = false) {
  await register(page, baseURL);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="#8064d4"/></svg>';
  const upload = await page.request.post(`${baseURL}/api/assets/directory-move-svg`, {
    data: Buffer.from(svg), headers: { 'Content-Type': 'image/svg+xml', 'X-Asset-Path': encodeURIComponent('附件/目录测试.svg') },
  });
  expect(upload.status()).toBe(201);
  const note = (id: string, title: string, notePath: string, noteContent = '# 目标资料\n\n这是用于保留目标文件夹的独立资料。') => ({
    id, title, path: notePath, category: notePath.split('/')[0], content: noteContent, tags: [],
  });
  const notes = [
    { ...note(sourceId, '可移动资料', '源目录/可移动资料.md', content), attachments: { '附件/目录测试.svg': 'asset:directory-move-svg' } },
    note('directory-move-target', '目标参考', '目标目录/目标参考.md'),
    note('directory-move-link', '关联资料', '参考目录/关联资料.md', '# 关联资料\n\n[返回移动资料](#note/directory-move-source)'),
    ...(includeDuplicate ? [note('directory-move-duplicate', '目标同名资料', '目标目录/可移动资料.md', '# 同名文件\n\n目标内容不能被覆盖。')] : []),
  ];
  const imported = await page.request.post(`${baseURL}/api/notes/import`, { data: { notes } });
  expect(imported.status()).toBe(201);
  await page.goto(`${baseURL}/#note/${sourceId}`);
  await expect(reader(page).getByRole('heading', { level: 1, name: '可移动资料', exact: true })).toBeVisible();
  await expect(file(page)).toHaveAttribute('draggable', 'true');
}

async function assertLinksAndImage(page: Page) {
  await expect(reader(page)).toContainText('正文、附件和关联文档保持不变');
  const image = reader(page).getByRole('img', { name: '目录测试图', exact: true });
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete ? element.naturalWidth : 0)).toBe(24);
  await expect(reader(page).getByRole('link', { name: '关联资料', exact: true })).toHaveAttribute('href', '#note/directory-move-link');
}

// Dispatching dragstart lets the real component issue its private drag token.
// This is used where a native confirm dialog would interrupt pointer replay.
async function dispatchDrag(page: Page, source: Locator, target: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent('dragstart', { dataTransfer });
    await target.dispatchEvent('dragover', { dataTransfer });
    await target.dispatchEvent('drop', { dataTransfer });
    await source.dispatchEvent('dragend', { dataTransfer });
  } finally { await dataTransfer.dispose(); }
}

test('native sidebar dragging preserves the open document, durable content, links and images, including a move to root', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const before = await noteData(page, backend.baseURL);
  const readingUrl = page.url();
  await expect(reader(page).getByRole('combobox', { name: '移动到文件夹', exact: true })).toHaveCount(0);

  // Exercise the browser's native HTML5 drag, rather than directly invoking a callback.
  await file(page).dragTo(destination(page));
  await expect.poll(async () => (await noteData(page, backend.baseURL)).path).toBe('目标目录/可移动资料.md');
  await expect(page).toHaveURL(readingUrl);
  await assertLinksAndImage(page);
  const moved = await noteData(page, backend.baseURL);
  expect(moved).toMatchObject({ content, ownerId: before.ownerId, author: before.author, attachments: before.attachments });
  await page.reload();
  await expect(file(page)).toHaveAttribute('data-parent', '目标目录');
  await assertLinksAndImage(page);
  await reader(page).getByRole('link', { name: '关联资料', exact: true }).click();
  await expect(reader(page).getByRole('heading', { level: 1, name: '关联资料', exact: true })).toBeVisible();
  await reader(page).getByRole('link', { name: '返回移动资料', exact: true }).click();
  await expect(page).toHaveURL(readingUrl);

  // The explicit root destination only appears after a real drag has started.
  const sourceBox = (await file(page).boundingBox())!;
  await page.mouse.move(sourceBox.x + 32, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + 60, sourceBox.y + sourceBox.height / 2, { steps: 5 });
  const root = page.getByRole('button', { name: '移到知识库根目录', exact: true });
  await expect(root).toBeVisible();
  const rootBox = (await root.boundingBox())!;
  await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2, { steps: 10 });
  await page.mouse.move(rootBox.x + rootBox.width / 2 + 1, rootBox.y + rootBox.height / 2, { steps: 2 });
  await page.mouse.up();
  await expect.poll(async () => (await noteData(page, backend.baseURL)).path).toBe('可移动资料.md');
  await expect(page).toHaveURL(readingUrl);
  await page.reload();
  await expect(file(page)).toHaveAttribute('data-parent', '');
  expect((await noteData(page, backend.baseURL)).content).toBe(content);
  await assertLinksAndImage(page);
});

test('sidebar dragging follows author and collaborative edit permissions', async ({ page, browser, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const original = await noteData(page, backend.baseURL);
  const memberContext = await browser.newContext();
  const adminContext = await browser.newContext();
  try {
    const member = await memberContext.newPage();
    await register(member, backend.baseURL, '其他成员', 'directory-member@isolated.test');
    const ownNote = await member.request.post(`${backend.baseURL}/api/notes`, { data: {
      title: '成员自己的资料', path: '成员目录/自己的资料.md', content: '# 成员资料',
    } });
    expect(ownNote.status()).toBe(201);
    const ownId = (await ownNote.json()).note.id;
    await member.goto(`${backend.baseURL}/#note/${sourceId}`);
    await expect(file(member)).toHaveAttribute('draggable', 'false');
    await expect(file(member, ownId)).toHaveAttribute('draggable', 'true');
    await expect(reader(member).getByRole('button', { name: '编辑笔记', exact: true })).toHaveCount(0);

    const setup = JSON.parse(await readFile(path.join(backend.dataDir, 'admin-setup.json'), 'utf8'));
    const activated = await adminContext.request.post(`${backend.baseURL}/api/auth/activate-admin`, { data: { token: setup.token, password } });
    expect(activated.status()).toBe(200);
    const sharing = await adminContext.request.patch(`${backend.baseURL}/api/notes/${sourceId}/sharing`, { data: { collaborative: true } });
    expect(sharing.status()).toBe(200);
    await member.reload();
    await expect(file(member)).toHaveAttribute('draggable', 'true');
    await file(member).dragTo(destination(member));
    await expect.poll(async () => (await noteData(member, backend.baseURL)).path).toBe('目标目录/可移动资料.md');
    const saved = await noteData(member, backend.baseURL);
    expect(saved).toMatchObject({ ownerId: original.ownerId, author: original.author, content, collaborative: true });
    await expect(reader(member).getByRole('button', { name: '删除笔记', exact: true })).toHaveCount(0);
  } finally {
    await memberContext.close();
    await adminContext.close();
  }
});

test('a duplicate destination filename is refused and keeps both source and target unchanged', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL, true);
  const sourceBefore = await noteData(page, backend.baseURL);
  const targetBefore = await noteData(page, backend.baseURL, 'directory-move-duplicate');
  await file(page).dragTo(destination(page));
  await expect(page.locator('.toast')).toContainText('目标文件夹已有同名文档');
  expect(await noteData(page, backend.baseURL)).toMatchObject({ path: sourceBefore.path, content: sourceBefore.content, revision: sourceBefore.revision });
  expect(await noteData(page, backend.baseURL, 'directory-move-duplicate')).toMatchObject({ path: targetBefore.path, content: targetBefore.content, revision: targetBefore.revision });
  await expect(file(page)).toHaveAttribute('data-parent', '源目录');
});

test('moving the document being edited respects unsaved draft cancellation and confirmed discard', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
  const draft = '# 未保存草稿\n\n取消移动必须保留当前编辑内容。';
  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  await editor(page).getByLabel('笔记内容', { exact: true }).fill(draft);
  page.once('dialog', dialog => dialog.dismiss());
  await dispatchDrag(page, file(page), destination(page));
  await expect(editor(page).getByLabel('笔记内容', { exact: true })).toHaveValue(draft);
  expect((await noteData(page, backend.baseURL)).path).toBe('源目录/可移动资料.md');
  await expect(file(page)).toHaveAttribute('data-parent', '源目录');

  page.once('dialog', dialog => dialog.accept());
  await dispatchDrag(page, file(page), destination(page));
  await expect.poll(async () => (await noteData(page, backend.baseURL)).path).toBe('目标目录/可移动资料.md');
  await expect(editor(page)).toHaveCount(0);
  await expect(reader(page)).toContainText('正文、附件和关联文档保持不变');
  expect((await noteData(page, backend.baseURL)).content).toBe(content);
  await page.reload();
  await expect(file(page)).toHaveAttribute('data-parent', '目标目录');
  await assertLinksAndImage(page);
});
