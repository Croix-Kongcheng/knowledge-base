import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { test, expect } from './fixtures/backend';

type StoredNote = { id: string; title: string; path: string; content: string; revision: number; attachments: Record<string, string>; collaborative: boolean; ownerId: string };
const password = 'Isolated-import-overwrite-2026!';
const svg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18"><rect width="24" height="18" fill="${color}"/></svg>`;
const modal = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: '把你的知识，带到这里', exact: true });
const reader = (page: import('@playwright/test').Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });

test('reimport updates original notes, open tabs and links while keeping favorites and per-user reading time', async ({ page, browser, backend }) => {
  test.setTimeout(150_000);
  const temporary = await mkdtemp(path.join(tmpdir(), 'zhiyu-overwrite-source-'));
  const source = path.join(temporary, '重复验收库');
  const initial = {
    '研究/A.md': '# 原始 A 正文\n\n[[B|打开 B]]\n\n![[../附件/图.svg|原始示意]]',
    '研究/B.md': '# 原始 B 正文\n\n[[A|返回 A]]\n\n![[../附件/图.svg|原始示意]]',
    '研究/C.md': '# 未选中的第三篇',
    '附件/图.svg': svg('#8059cd'),
  };
  for (const [relative, content] of Object.entries(initial)) {
    const filename = path.join(source, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }
  const administrator = await browser.newContext();
  const readingMember = await browser.newContext();
  try {
    expect((await page.request.post(`${backend.baseURL}/api/auth/register`, { data: { name: '重复导入作者', email: 'overwrite-owner@isolated.test', password } })).status()).toBe(201);
    const setup = JSON.parse(await readFile(path.join(backend.dataDir, 'admin-setup.json'), 'utf8'));
    expect((await administrator.request.post(`${backend.baseURL}/api/auth/activate-admin`, { data: { token: setup.token, password } })).status()).toBe(200);
    const registered = await readingMember.request.post(`${backend.baseURL}/api/auth/register`, { data: { name: '累计阅读成员', email: 'overwrite-reader@isolated.test', password } });
    expect(registered.status()).toBe(201);
    const readingUserId = (await registered.json()).user.id;

    await page.goto(backend.baseURL);
    await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toBeEnabled();
    await page.locator('.sidebar-directory-heading').getByRole('button', { name: '导入笔记', exact: true }).click();
    await modal(page).getByRole('tab', { name: /关联导入/ }).click();
    await modal(page).getByLabel('关联导入来源文件夹', { exact: true }).setInputFiles(source);
    await modal(page).getByRole('checkbox', { name: '研究/A.md', exact: true }).check();
    await modal(page).getByRole('button', { name: '分析关联内容', exact: true }).click();
    await expect(modal(page).getByRole('region', { name: '关联导入预览', exact: true })).toBeVisible();
    const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/notes/import' && response.request().method() === 'POST');
    await modal(page).getByRole('button', { name: /导入 2 篇笔记/ }).click();
    const original = (await (await firstResponse).json()).notes as StoredNote[];
    await expect(modal(page)).toHaveCount(0);
    const a = original.find(note => note.path === '研究/A.md')!;
    const b = original.find(note => note.path === '研究/B.md')!;
    expect(a).toBeTruthy();expect(b).toBeTruthy();
    const originalAsset = Object.values(a.attachments)[0];

    // A separate member's genuine reading visit must survive the author's import.
    const sessionId = 'overwrite-browser-reading-visit';
    expect((await readingMember.request.post(`${backend.baseURL}/api/reading/start`, { data: { sessionId, noteId: a.id } })).status()).toBe(201);
    await page.waitForTimeout(11_200);
    const stopped = await readingMember.request.post(`${backend.baseURL}/api/reading/stop`, { data: { sessionId, elapsedMs: 11_200 } });
    expect(stopped.status()).toBe(200);
    expect((await stopped.json()).recordedMs).toBeGreaterThan(0);
    const statistics = async () => {
      const response = await administrator.request.get(`${backend.baseURL}/api/admin/reading?userId=${readingUserId}`);
      expect(response.status()).toBe(200);
      return response.json();
    };
    const before = await statistics();
    expect(before.records).toHaveLength(1);
    expect(before.records[0].noteId).toBe(a.id);

    // Links from notes outside this import and a shared old asset remain usable.
    expect((await page.request.post(`${backend.baseURL}/api/notes`, { data: { note: {
      id: 'overwrite-existing-backlink', title: '历史外部引用', path: '历史/外部引用.md',
      content: `[原来指向 B 的链接](#note/${b.id})\n\n![共享旧图](${originalAsset})`, attachments: { '旧图.svg': originalAsset },
    } } })).status()).toBe(201);
    expect((await page.request.post(`${backend.baseURL}/api/notes`, { data: { note: {
      id: 'overwrite-other-folder', title: 'B', path: '其他/B.md', content: '同名但不同目录的独立内容',
    } } })).status()).toBe(201);
    expect((await administrator.request.patch(`${backend.baseURL}/api/notes/${a.id}/sharing`, { data: { collaborative: true } })).status()).toBe(200);
    await page.goto(`${backend.baseURL}/#note/${a.id}`);
    await expect(reader(page).locator('.kr-markdown')).toContainText('原始 A 正文');
    await page.getByRole('tab', { name: 'A', exact: true }).dblclick();
    await page.locator(`.sidebar .ft-file[data-note-id="${b.id}"]`).dblclick();
    await page.getByRole('tab', { name: 'A', exact: true }).click();
    await reader(page).getByRole('button', { name: '收藏当前笔记', exact: true }).click();
    await expect(reader(page).getByRole('button', { name: '取消收藏当前笔记', exact: true })).toBeVisible();

    // A new source produces fresh temporary IDs for both existing documents.
    const updated = {
      '研究/A.md': '# 更新后的 A 正文\n\n[[B|打开更新的 B]]\n\n[[D|打开新增 D]]\n\n![[../附件/图.svg|更新示意]]',
      '研究/B.md': '# 更新后的 B 正文\n\n[[A|返回更新的 A]]\n\n[[C|不扩展第二层 C]]',
      '研究/C.md': '# 仍不导入的第三篇',
      '研究/D.md': '# 新增 D 正文\n\n[[B|D 引用 B]]',
      '附件/图.svg': svg('#54ad93'),
    };
    const archive = new JSZip();
    for (const [relative, content] of Object.entries(updated)) archive.file(`重复验收库/${relative}`, content);
    await page.locator('.sidebar-directory-heading').getByRole('button', { name: '导入笔记', exact: true }).click();
    await modal(page).getByRole('tab', { name: /关联导入/ }).click();
    await modal(page).getByLabel('关联导入来源ZIP', { exact: true }).setInputFiles({ name: '重复验收库.zip', mimeType: 'application/zip', buffer: await archive.generateAsync({ type: 'nodebuffer' }) });
    await modal(page).getByRole('checkbox', { name: '研究/A.md', exact: true }).check();
    await modal(page).getByRole('button', { name: '分析关联内容', exact: true }).click();
    await expect(modal(page).getByRole('region', { name: '关联导入预览', exact: true })).toBeVisible();
    let detailRequests = 0;
    await page.route(`**/api/notes/${a.id}`, async route => { detailRequests++;await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离验收：已打开的正文应使用导入返回的新版本' }) }); });
    const secondResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/notes/import' && response.request().method() === 'POST');
    await modal(page).getByRole('button', { name: /导入 3 篇笔记/ }).click();
    const response = await secondResponse;
    const request = response.request().postDataJSON();
    expect(request.notes.find((note: StoredNote) => note.path === a.path).id).not.toBe(a.id);
    const result = await response.json();
    expect(response.status()).toBe(201);
    expect(result).toMatchObject({ createdCount: 1, updatedCount: 2 });
    const savedA = result.notes.find((note: StoredNote) => note.path === a.path) as StoredNote;
    const savedB = result.notes.find((note: StoredNote) => note.path === b.path) as StoredNote;
    expect(savedA).toMatchObject({ id: a.id, ownerId: a.ownerId, collaborative: true });
    expect(savedB.id).toBe(b.id);
    expect(savedA.revision).toBeGreaterThan(a.revision);
    expect(savedA.content).toContain(`(#note/${b.id})`);
    expect(savedB.content).toContain(`(#note/${a.id})`);
    await expect(modal(page)).toHaveCount(0);
    await expect(reader(page).locator('.kr-markdown')).toContainText('更新后的 A 正文');
    await expect(reader(page).getByRole('button', { name: '取消收藏当前笔记', exact: true })).toBeVisible();
    await expect(page.getByRole('tablist', { name: '打开的笔记', exact: true }).getByRole('tab')).toHaveCount(2);
    expect(detailRequests).toBe(0);
    await page.unroute(`**/api/notes/${a.id}`);
    const after = await statistics();
    expect(after.records).toEqual(before.records);
    const notesResponse = await page.request.get(`${backend.baseURL}/api/notes`);
    const all = (await notesResponse.json()).notes as StoredNote[];
    expect(all).toHaveLength(5);
    expect(new Set(all.map(note => note.path)).size).toBe(5);
    expect(all.find(note => note.id === 'overwrite-other-folder')?.content).toBe('同名但不同目录的独立内容');
    expect(all.find(note => note.id === 'overwrite-existing-backlink')?.content).toContain(`(#note/${b.id})`);
    expect(all.some(note => note.path === '研究/C.md')).toBe(false);
    expect((await page.request.get(`${backend.baseURL}/api/assets/${originalAsset.slice('asset:'.length)}`)).status()).toBe(200);
    await reader(page).getByRole('link', { name: '打开更新的 B', exact: true }).click();
    await expect(reader(page).locator('.kr-markdown')).toContainText('更新后的 B 正文');
    await page.reload();
    await page.getByRole('tab', { name: 'A', exact: true }).click();
    await expect(reader(page).locator('.kr-markdown')).toContainText('更新后的 A 正文');
    await expect(reader(page).getByRole('button', { name: '取消收藏当前笔记', exact: true })).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await administrator.close();await readingMember.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('legacy browser migration keeps newer server notes and resolves links to their canonical IDs without repeatedly offering migration', async ({ page, backend }) => {
  const setup = JSON.parse(await readFile(path.join(backend.dataDir, 'admin-setup.json'), 'utf8'));
  expect((await page.request.post(`${backend.baseURL}/api/auth/activate-admin`, { data: { token: setup.token, password } })).status()).toBe(200);
  const created = await page.request.post(`${backend.baseURL}/api/notes`, { data: { note: {
    id: 'canonical-legacy-a', title: 'A', path: '历史项目/A.md', content: '# 服务端较新的 A 正文必须保留',
  } } });
  expect(created.status()).toBe(201);
  const original = (await created.json()).note;
  await page.route('**/__overwrite_legacy_seed__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated legacy fixture</title>' }));
  await page.goto(`${backend.baseURL}/__overwrite_legacy_seed__`);
  await page.evaluate(async () => {
    const base = { category: '历史项目', tags: [], author: '历史作者', avatar: '历', color: 'purple', updatedAt: '2026-10-25T01:00:00Z' };
    const notes = [
      { ...base, id: 'legacy-old-a', title: 'A', path: '历史项目/A.md', content: '# 旧 A 正文不能覆盖新版本\n\n![已不可用的旧图](asset:unavailable-legacy-asset)', attachments: { '旧图.svg': 'asset:unavailable-legacy-asset' } },
      { ...base, id: 'legacy-new-b', title: 'B', path: '历史项目/B.md', content: '# 待迁移的 B 正文\n\n[指向旧 ID 的 A 链接](#note/legacy-old-a)' },
    ];
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('zhiyu-knowledge', 2);
      request.onupgradeneeded = () => { request.result.createObjectStore('workspace');request.result.createObjectStore('assets'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('workspace', 'readwrite');
        transaction.objectStore('workspace').put(notes, 'notes');
        transaction.oncomplete = () => { db.close();resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  await page.goto(backend.baseURL);
  const migration = page.getByRole('button', { name: '迁移本机已有笔记', exact: true });
  await expect(migration).toBeVisible();
  await expect(page.locator('.migration-banner')).toContainText('1 篇旧版笔记');
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/notes/import' && response.request().method() === 'POST');
  await migration.click();
  const response = await saved;
  expect(response.request().postDataJSON().mode).toBe('legacy-migration');
  expect(response.status()).toBe(201);
  await expect(page.locator('.migration-banner')).toHaveCount(0);
  const notes = (await (await page.request.get(`${backend.baseURL}/api/notes`)).json()).notes as StoredNote[];
  expect(notes).toHaveLength(2);
  expect(notes.find(note => note.id === original.id)).toEqual(original);
  expect(notes.find(note => note.id === 'legacy-new-b')?.content).toContain('(#note/canonical-legacy-a)');
  await page.reload();
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toBeEnabled();
  await expect(migration).toHaveCount(0);
  await page.goto(`${backend.baseURL}/#note/legacy-new-b`);
  await reader(page).getByRole('link', { name: '指向旧 ID 的 A 链接', exact: true }).click();
  await expect(reader(page).locator('.kr-markdown')).toContainText('服务端较新的 A 正文必须保留');
});
