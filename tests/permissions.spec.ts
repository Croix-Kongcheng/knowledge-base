import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import { test, expect } from './fixtures/backend';

const password = 'Isolated-browser-password-2026!';
const reader = (page: Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });

async function localNoteCount(page: Page) {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('zhiyu-knowledge');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('workspace').objectStore('workspace').get('notes');
      get.onsuccess = () => { db.close(); resolve(get.result.length); };
      get.onerror = () => reject(get.error);
    };
  }));
}

async function register(page: Page, baseURL: string, name: string, email: string) {
  await page.goto(baseURL);
  const account = page.getByRole('dialog', { name: '欢迎来到知屿', exact: true });
  await expect(account).toBeVisible();
  await account.getByLabel('你的名字', { exact: true }).fill(name);
  await account.getByLabel('邮箱地址', { exact: true }).fill(email);
  await account.getByLabel('密码', { exact: true }).fill(password);
  await account.getByLabel('确认密码', { exact: true }).fill(password);
  await account.getByRole('button', { name: '创建我的知识空间', exact: false }).click();
  await expect(account).toHaveCount(0);
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText(name);
}

test('real accounts can create, search, edit, collaborate and delete with server ownership checks', async ({ page, browser, backend }) => {
  test.setTimeout(180_000);
  await register(page, backend.baseURL, 'Alice', 'alice@browser-isolated.test');

  await page.locator('.page-heading').getByRole('button', { name: '导入笔记', exact: true }).click();
  const importer = page.getByRole('dialog', { name: '把你的知识，带到这里', exact: true });
  await expect(importer).not.toContainText('02私有资料');
  await expect(importer).not.toContainText('私人目录');
  await expect(importer).not.toContainText('ExampleWorkspace');
  await importer.getByRole('button', { name: '关闭导入窗口', exact: true }).click();
  await page.getByRole('button', { name: '查看全部文档', exact: true }).click();

  const title = 'Alice 的杏树项目';
  const editedTitle = 'Alice 的杏树项目修订';
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  let editor = page.getByRole('region', { name: '记录新的灵感', exact: true });
  await editor.getByLabel('笔记标题', { exact: true }).fill(title);
  await editor.getByLabel('添加标签', { exact: false }).fill('权限, 杏树');
  await editor.getByRole('tab', { name: '源码', exact: true }).click();
  await editor.getByLabel('笔记内容', { exact: true }).fill('# 杏树项目\n\n只有作者可以修改这份知识。');
  await editor.getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(reader(page).getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();

  await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
  editor = page.getByRole('region', { name: '编辑笔记', exact: true });
  await editor.getByLabel('笔记标题', { exact: true }).fill(editedTitle);
  await editor.getByRole('tab', { name: '源码', exact: true }).click();
  await editor.getByLabel('笔记内容', { exact: true }).fill('# 杏树项目\n\n作者修改后的项目知识。');
  await editor.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(reader(page).getByRole('heading', { level: 1, name: editedTitle, exact: true })).toBeVisible();
  const { notes } = await (await page.request.get(`${backend.baseURL}/api/notes`)).json();
  const note = notes.find((value: { title: string }) => value.title === editedTitle);
  expect(note).toMatchObject({ author: 'Alice', ownerEmail: 'alice@browser-isolated.test', collaborative: false });

  await reader(page).getByRole('button', { name: '返回知识库', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill('杏树');
  await expect(page.locator('.notes-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.notes-table tbody')).toContainText(editedTitle);
  await page.locator('.notes-table tbody tr').click();
  await page.reload();
  await expect(reader(page).getByRole('heading', { level: 1, name: editedTitle, exact: true })).toBeVisible();
  await expect(reader(page)).toContainText('作者修改后的项目知识');
  await page.screenshot({ path: '/tmp/knowledge-crud-reader.png', fullPage: true });

  const bobContext = await browser.newContext();
  const adminContext = await browser.newContext();
  try {
    const bob = await bobContext.newPage();
    await register(bob, backend.baseURL, 'Bob', 'bob@browser-isolated.test');
    await bob.goto(`${backend.baseURL}/#note/${note.id}`);
    await expect(reader(bob).getByRole('heading', { level: 1, name: editedTitle, exact: true })).toBeVisible();
    await expect(reader(bob).getByRole('button', { name: '编辑笔记', exact: true })).toHaveCount(0);
    await expect(reader(bob).getByRole('button', { name: '删除笔记', exact: true })).toHaveCount(0);
    const folderControl = reader(bob).getByRole('combobox', { name: '移动到文件夹', exact: true });
    if (await folderControl.count()) await expect(folderControl).toBeDisabled();

    const admin = await adminContext.newPage();
    const setup = JSON.parse(await readFile(path.join(backend.dataDir, 'admin-setup.json'), 'utf8'));
    const activated = await adminContext.request.post(`${backend.baseURL}/api/auth/activate-admin`, { data: { token: setup.token, password } });
    expect(activated.ok()).toBe(true);
    await admin.goto(`${backend.baseURL}/#note/${note.id}`);
    const collaboration = reader(admin).getByRole('switch', { name: '允许所有成员编辑', exact: true });
    await expect(collaboration).toHaveAttribute('aria-checked', 'false');
    await collaboration.click();
    await expect(collaboration).toHaveAttribute('aria-checked', 'true');

    await bob.reload();
    await reader(bob).getByRole('button', { name: '编辑笔记', exact: true }).click();
    const bobEditor = bob.getByRole('region', { name: '编辑笔记', exact: true });
    await bobEditor.getByRole('tab', { name: '源码', exact: true }).click();
    await bobEditor.getByLabel('笔记内容', { exact: true }).fill('# 杏树项目\n\nBob 补充了协作知识。');
    await bobEditor.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(reader(bob)).toContainText('Bob 补充了协作知识');
    const afterCollaboration = (await (await bob.request.get(`${backend.baseURL}/api/notes`)).json()).notes.find((value: { id: string }) => value.id === note.id);
    expect(afterCollaboration).toMatchObject({ author: 'Alice', ownerEmail: 'alice@browser-isolated.test', ownerId: note.ownerId });
    await expect(reader(bob).getByRole('button', { name: '删除笔记', exact: true })).toHaveCount(0);

    // Revoke permission while Bob already has the editor open. Saving must be
    // refused by the server even if the browser still displays an edit control.
    await reader(bob).getByRole('button', { name: '编辑笔记', exact: true }).click();
    await admin.reload();
    await collaboration.click();
    await expect(collaboration).toHaveAttribute('aria-checked', 'false');
    const revokedEditor = bob.getByRole('region', { name: '编辑笔记', exact: true });
    await revokedEditor.getByRole('tab', { name: '源码', exact: true }).click();
    await revokedEditor.getByLabel('笔记内容', { exact: true }).fill('这次越权修改不应保存。');
    await revokedEditor.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(revokedEditor.getByRole('alert')).toBeVisible();
    bob.once('dialog', dialog => dialog.accept());
    await revokedEditor.getByRole('button', { name: '取消', exact: true }).click();
    await bob.reload();
    await expect(reader(bob)).toContainText('Bob 补充了协作知识');
    await expect(reader(bob)).not.toContainText('这次越权修改不应保存');
    await expect(reader(bob).getByRole('button', { name: '编辑笔记', exact: true })).toHaveCount(0);

    await page.reload();
    await expect(reader(page)).toContainText('Bob 补充了协作知识');
    await reader(page).getByRole('button', { name: '删除笔记', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '删除笔记', exact: true });
    await expect(confirm).toContainText(editedTitle);
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await expect(reader(page).getByRole('heading', { level: 1, name: editedTitle, exact: true })).toBeVisible();
    await reader(page).getByRole('button', { name: '删除笔记', exact: true }).click();
    await page.getByRole('dialog', { name: '删除笔记', exact: true }).getByRole('button', { name: /确认删除|删除笔记/, exact: true }).click();
    await expect(reader(page)).toHaveCount(0);
    await page.reload();
    expect((await (await page.request.get(`${backend.baseURL}/api/notes`)).json()).notes).toEqual([]);
    await expect(page.locator('.notes-table tbody tr')).toHaveCount(0);
  } finally {
    await bobContext.close();
    await adminContext.close();
  }
});

test('an imported vault persists its images and note links on the server for a separate reader', async ({ page, browser, backend }) => {
  test.setTimeout(120_000);
  await register(page, backend.baseURL, 'Alice', 'vault-owner@browser-isolated.test');
  const archive = new JSZip();
  archive.file('公开知识库/项目/项目首页.md', '# 共享项目首页\n\n![[附件/架构.svg]]\n\n[[项目/项目流程|项目流程]]\n\n[查看 PDF](../附件/说明.pdf)');
  archive.file('公开知识库/项目/项目流程.md', '# 共享项目流程\n\n[[项目/项目首页|项目首页]]');
  archive.file('公开知识库/附件/架构.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="32"><rect width="40" height="32" fill="#8b70e5"/></svg>');
  archive.file('公开知识库/附件/说明.pdf', '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
  await page.locator('.page-heading').getByRole('button', { name: '导入笔记', exact: true }).click();
  const importer = page.getByRole('dialog', { name: '把你的知识，带到这里', exact: true });
  await importer.getByRole('tab', { name: /^ZIP 整库导入/ }).click();
  await importer.locator('input[type="file"]').setInputFiles({
    name: 'isolated-public-vault.zip', mimeType: 'application/zip', buffer: await archive.generateAsync({ type: 'nodebuffer' }),
  });
  await importer.getByRole('button', { name: '导入 2 篇笔记', exact: true }).click();
  await expect(importer).toHaveCount(0);
  const { notes } = await (await page.request.get(`${backend.baseURL}/api/notes`)).json();
  expect(notes).toHaveLength(2);
  for (const note of notes) expect(note).toMatchObject({ author: 'Alice', ownerEmail: 'vault-owner@browser-isolated.test', collaborative: false });
  const home = notes.find((note: { path: string }) => note.path.endsWith('项目首页.md'));
  expect(home.content).toContain('asset:');
  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    await guest.goto(`${backend.baseURL}/#note/${home.id}`);
    await guest.getByRole('button', { name: '关闭账号窗口', exact: true }).click();
    const image = reader(guest).getByRole('img', { name: '附件/架构.svg', exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(40);
    const pdf = reader(guest).getByRole('link', { name: '查看 PDF', exact: true });
    await expect(pdf).toHaveAttribute('href', /^\/api\/assets\//);
    const pdfResponse = await guest.request.get(`${backend.baseURL}${await pdf.getAttribute('href')}`);
    expect(pdfResponse.status()).toBe(200);
    expect(pdfResponse.headers()['content-type']).toContain('application/pdf');
    expect((await pdfResponse.body()).toString()).toContain('%PDF-1.4');
    await expect(reader(guest).getByRole('button', { name: '编辑笔记', exact: true })).toHaveCount(0);
    await reader(guest).getByRole('link', { name: '项目流程', exact: true }).click();
    await expect(reader(guest).getByRole('heading', { level: 1, name: '共享项目流程', exact: true })).toBeVisible();
    await reader(guest).getByRole('link', { name: '项目首页', exact: true }).click();
    await guest.reload();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(40);
    await expect(reader(guest).getByRole('heading', { level: 1, name: '共享项目首页', exact: true })).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

test('only an authenticated administrator can migrate existing local notes and both attachment formats without losing the source', async ({ page, browser, backend }) => {
  test.setTimeout(180_000);
  await page.route('**/__permissions_legacy_seed__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated legacy migration fixture</title>' }));
  await page.goto(`${backend.baseURL}/__permissions_legacy_seed__`);
  await page.evaluate(async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="#78c5ac"/></svg>';
    const inlineImage = `data:image/svg+xml;base64,${btoa(svg)}`;
    const base = { category: '历史项目', tags: ['真实旧数据'], author: '旧作者', avatar: '旧', color: '#eae3f8', updatedAt: '2026-10-25T01:00:00Z' };
    const notes = [
      { ...base, id: 'legacy-real-note-a', title: '历史知识', path: '历史项目/历史知识.md', content: `# 历史知识\n\n![Blob 附件](asset:legacy-image-check)\n\n![旧版内联附件](${inlineImage})\n\n[关联知识](#note/legacy-real-note-b)`, attachments: { 'Blob.svg': 'asset:legacy-image-check', 'Inline.svg': inlineImage }, attachmentSizes: { 'asset:legacy-image-check': new Blob([svg]).size } },
      { ...base, id: 'legacy-real-note-b', title: '关联知识', path: '历史项目/关联知识.md', content: '# 关联知识\n\n[历史知识](#note/legacy-real-note-a)' },
    ];
    localStorage.setItem('zhiyu-user-v1', JSON.stringify({ name: 'Project Admin', email: 'admin@example.com', role: 'admin' }));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('zhiyu-knowledge', 2);
      request.onupgradeneeded = () => { request.result.createObjectStore('workspace'); request.result.createObjectStore('assets'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['workspace', 'assets'], 'readwrite');
        tx.objectStore('workspace').put(notes, 'notes');
        tx.objectStore('assets').put({ id: 'legacy-image-check', path: '附件/Blob.svg', blob: new Blob([svg], { type: 'image/svg+xml' }) }, 'legacy-image-check');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.goto(backend.baseURL);
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('访客');
  await expect(page.getByRole('button', { name: '迁移本机已有笔记', exact: true })).toHaveCount(0);
  expect((await (await page.request.get(`${backend.baseURL}/api/notes`)).json()).notes).toEqual([]);
  await register(page, backend.baseURL, '普通成员', 'legacy-member@browser-isolated.test');
  await expect(page.getByRole('button', { name: '迁移本机已有笔记', exact: true })).toHaveCount(0);

  const setup = JSON.parse(await readFile(path.join(backend.dataDir, 'admin-setup.json'), 'utf8'));
  const activated = await page.context().request.post(`${backend.baseURL}/api/auth/activate-admin`, { data: { token: setup.token, password } });
  expect(activated.ok()).toBe(true);
  await page.reload();
  const migration = page.getByRole('button', { name: '迁移本机已有笔记', exact: true });
  await expect(migration).toBeVisible();

  // A failed server commit must keep the old browser DB available for a retry.
  await page.route('**/api/notes/import', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离测试模拟迁移失败' }) }));
  await migration.click();
  await expect(page.locator('.migration-banner')).toContainText('隔离测试模拟迁移失败');
  await expect(migration).toBeEnabled();
  expect((await (await page.request.get(`${backend.baseURL}/api/notes`)).json()).notes).toEqual([]);
  expect(await localNoteCount(page)).toBe(2);
  await page.unroute('**/api/notes/import');
  await migration.click();
  await expect(page.locator('.migration-banner')).toHaveCount(0);
  const migratedNotes = (await (await page.request.get(`${backend.baseURL}/api/notes`)).json()).notes;
  expect(migratedNotes).toHaveLength(2);
  for (const note of migratedNotes) expect(note).toMatchObject({ ownerEmail: 'admin@example.com', author: 'Project Admin', collaborative: false });
  await page.reload();
  await expect(migration).toHaveCount(0);
  expect(await localNoteCount(page)).toBe(2);
  expect((await (await page.request.get(`${backend.baseURL}/api/notes`)).json()).notes).toHaveLength(2);
  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    await guest.goto(`${backend.baseURL}/#note/legacy-real-note-a`);
    await guest.getByRole('button', { name: '关闭账号窗口', exact: true }).click();
    for (const name of ['Blob 附件', '旧版内联附件']) {
      const image = reader(guest).getByRole('img', { name, exact: true });
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(24);
    }
    await reader(guest).getByRole('link', { name: '关联知识', exact: true }).click();
    await expect(reader(guest).getByRole('heading', { level: 1, name: '关联知识', exact: true })).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

test('the administrator setup link sets a password and supports durable login, logout, and password verification', async ({ page, backend }) => {
  test.setTimeout(120_000);
  const setup = JSON.parse(await readFile(path.join(backend.dataDir, 'admin-setup.json'), 'utf8'));
  await page.goto(`${backend.baseURL}/?setup=${encodeURIComponent(setup.token)}`);
  const setupDialog = page.getByRole('dialog', { name: '设置管理员密码', exact: true });
  await expect(setupDialog).toBeVisible();
  await setupDialog.getByLabel('密码', { exact: true }).fill(password);
  await setupDialog.getByLabel('确认密码', { exact: true }).fill(password);
  await setupDialog.getByRole('button', { name: '启用管理员账号', exact: true }).click();
  await expect(setupDialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]setup=/);
  const profile = page.getByRole('button', { name: '账号菜单', exact: true });
  await expect(profile).toContainText('Project Admin');
  await expect(profile).toContainText('空间管理员');
  await page.reload();
  await expect(profile).toContainText('空间管理员');
  const session = await (await page.request.get(`${backend.baseURL}/api/session`)).json();
  expect(session.user).toMatchObject({ email: 'admin@example.com', role: 'admin' });
  expect((await page.context().cookies()).some(cookie => cookie.httpOnly)).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(password);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(setup.token);

  await profile.click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(profile).toContainText('访客');
  expect((await (await page.request.get(`${backend.baseURL}/api/session`)).json()).user).toBeNull();
  await expect(page.getByRole('dialog', { name: '欢迎来到知屿', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '登录账号', exact: true }).click();
  const signin = page.getByRole('dialog', { name: '很高兴，再次见到你', exact: true });
  await signin.getByLabel('邮箱地址', { exact: true }).fill('admin@example.com');
  await signin.getByLabel('密码', { exact: true }).fill('incorrect-password');
  await signin.getByRole('button', { name: '进入我的知识空间', exact: true }).click();
  await expect(signin.getByRole('alert')).toBeVisible();
  await expect(profile).toContainText('访客');
  await signin.getByLabel('密码', { exact: true }).fill(password);
  await signin.getByRole('button', { name: '进入我的知识空间', exact: true }).click();
  await expect(signin).toHaveCount(0);
  await expect(profile).toContainText('空间管理员');
  await page.reload();
  await expect(profile).toContainText('Project Admin');
});
