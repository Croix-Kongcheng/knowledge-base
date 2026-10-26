import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/backend';

type FixtureNote = { id: string; title: string; path: string; content: string; category: string; tags: string[] };
const accountName = '快速加载验收作者';
const currentId = 'fast-current';
const currentTitle = '01.当前研究资料';
const currentMarker = '这段当前文档正文必须按需获取。';
const searchMarker = '唯一全文尾部检索词 ZY-TAIL-78214';
const incomingId = 'fast-incoming';
const incomingTitle = '02.包含尾部引用的实验记录';
const reader = (page: Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });
const file = (page: Page, id: string) => page.locator(`aside.sidebar .ft-file[data-note-id="${id}"]`);
const apiPath = (url: string) => new URL(url).pathname;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}

async function seedWorkspace(page: Page, baseURL: string) {
  const registration = await page.request.post(`${baseURL}/api/auth/register`, { data: {
    name: accountName, email: 'fast-loading@isolated.test', password: 'Isolated-fast-loading-2026!',
  } });
  expect(registration.status()).toBe(201);
  // A few megabytes across unrelated documents expose accidental full-library
  // downloads without making Markdown rendering or the test fixture expensive.
  const filler = '此处是独立验收使用的正文数据，不包含检索词或内部链接。'.repeat(1250);
  const note = (id: string, title: string, content: string): FixtureNote => ({
    id, title, path: `研究资料/${title}.md`, content: `# ${title}\n\n${content}`, category: '研究资料', tags: ['性能验收'],
  });
  const notes = [
    note(currentId, currentTitle, currentMarker),
    note(incomingId, incomingTitle, `${filler}\n\n${searchMarker}\n\n[当前研究资料](#note/${currentId})`),
    ...Array.from({ length: 10 }, (_, index) => note(`fast-unrelated-${index}`, `${String(index + 3).padStart(2, '0')}.归档资料${index + 1}`, filler)),
  ];
  const imported = await page.request.post(`${baseURL}/api/notes/import`, { data: { notes } });
  expect(imported.status()).toBe(201);
  return notes;
}

async function waitForPersistedCache(page: Page, id: string) {
  await expect.poll(() => page.evaluate(async noteId => {
    return await new Promise<boolean>(resolve => {
      const request = indexedDB.open('zhiyu-server-cache-v1', 2);
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('index') || !db.objectStoreNames.contains('documents')) { db.close(); resolve(false); return; }
        const transaction = db.transaction(['index', 'documents']);
        const index = transaction.objectStore('index').get('current');
        const document = transaction.objectStore('documents').get(noteId);
        transaction.oncomplete = () => { resolve(Boolean(index.result?.notes?.length && document.result?.content)); db.close(); };
        transaction.onerror = () => { db.close(); resolve(false); };
      };
    });
  }, id)).toBe(true);
}

async function passAfter(route: Route, gate: ReturnType<typeof deferred>) {
  await gate.promise;
  // A cancelled navigation is allowed to abandon the request. It must not leave
  // the fixture route pending or turn cancellation into a product failure.
  await route.continue().catch(() => {});
}

test('cold note navigation downloads only the lightweight index and the selected document', async ({ page, backend }) => {
  const seeded = await seedWorkspace(page, backend.baseURL);
  const gets: string[] = [];
  page.on('request', request => { if (request.method() === 'GET') gets.push(apiPath(request.url())); });
  const indexResponse = page.waitForResponse(response => apiPath(response.url()) === '/api/notes/index');
  await page.goto(`${backend.baseURL}/#note/${currentId}`);
  await expect(reader(page).locator('.kr-markdown')).toContainText(currentMarker);
  await expect(page.locator('aside.sidebar .ft-file')).toHaveCount(seeded.length);
  const response = await indexResponse;
  const index = await response.json();
  expect(index.notes).toHaveLength(seeded.length);
  expect(index.notes.every((note: Record<string, unknown>) => !Object.hasOwn(note, 'content') && !Object.hasOwn(note, 'attachments'))).toBe(true);
  expect(index.totals.contentBytes).toBeGreaterThan(1_000_000);
  expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThan(index.totals.contentBytes / 20);
  expect(gets).not.toContain('/api/notes');
  expect(gets.filter(path => /^\/api\/notes\/[^/]+$/.test(path) && !['/api/notes/index', '/api/notes/search'].includes(path))).toEqual([`/api/notes/${currentId}`]);
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText(accountName);
});

test('reader code starts loading while the selected document request is still pending', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const documentGate = deferred();
  const documentRequested = deferred();
  const gets: string[] = [];
  page.on('request', request => { if (request.method() === 'GET') gets.push(apiPath(request.url())); });
  await page.route(`**/api/notes/${currentId}`, route => { documentRequested.resolve(); return passAfter(route, documentGate); });
  try {
    const readerRequested = page.waitForRequest(request => /\/assets\/KnowledgeReader-[^/]+\.js$/.test(apiPath(request.url())));
    await page.goto(`${backend.baseURL}/#note/${currentId}`);
    await documentRequested.promise;
    await readerRequested;
    // The body has not been released, so this proves the code download is
    // parallel with the document rather than triggered by its response.
    await expect(file(page, currentId)).toBeVisible();
    await expect(reader(page)).toHaveCount(0);
    expect(gets).not.toContain('/api/notes');
    expect(gets.filter(path => /^\/api\/notes\/[^/]+$/.test(path) && !['/api/notes/index', '/api/notes/search'].includes(path))).toEqual([`/api/notes/${currentId}`]);
    documentGate.resolve();
    await expect(reader(page).locator('.kr-markdown')).toContainText(currentMarker);
  } finally { documentGate.resolve(); }
});

test('directory intent warms reader code without fetching any document body', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const gets: string[] = [];
  page.on('request', request => { if (request.method() === 'GET') gets.push(apiPath(request.url())); });
  await page.goto(backend.baseURL);
  await expect(file(page, currentId)).toBeVisible();
  expect(gets.some(path => /\/assets\/KnowledgeReader-[^/]+\.js$/.test(path))).toBe(false);
  const readerLoaded = page.waitForResponse(response => /\/assets\/KnowledgeReader-[^/]+\.js$/.test(apiPath(response.url())));
  await page.locator('.sidebar-directory').hover();
  await (await readerLoaded).finished();
  await page.getByRole('button', { name: '查看全部文档', exact: true }).click();
  await page.locator('.notes-table tbody tr').first().focus();
  await page.getByRole('button', { name: '卡片视图', exact: true }).click();
  await page.locator('.note-card-grid').hover();
  expect(gets.filter(path => /\/assets\/KnowledgeReader-[^/]+\.js$/.test(path))).toHaveLength(1);
  expect(gets.filter(path => /^\/api\/notes\/[^/]+$/.test(path) && !['/api/notes/index', '/api/notes/search'].includes(path))).toEqual([]);
  expect(gets).not.toContain('/api/notes');
});

test('a real authenticated session completes independently of a delayed directory index', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const indexGate = deferred();
  const started = deferred();
  await page.route('**/api/notes/index', route => { started.resolve(); return passAfter(route, indexGate); });
  await page.addInitScript(() => {
    (window as typeof window & { authFallbacks?: string[] }).authFallbacks = [];
    new MutationObserver(() => {
      const menu = document.querySelector('[aria-label="账号菜单"]');
      if (menu?.textContent?.includes('未登录')) (window as typeof window & { authFallbacks: string[] }).authFallbacks.push(menu.textContent);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  try {
    const sessionResponse = page.waitForResponse(response => apiPath(response.url()) === '/api/session');
    await page.goto(backend.baseURL);
    await started.promise;
    expect((await (await sessionResponse).json()).user.name).toBe(accountName);
    const menu = page.getByRole('button', { name: '账号菜单', exact: true });
    await expect(menu).toBeEnabled();
    await expect(menu).toContainText(accountName);
    await expect(menu).toHaveAttribute('aria-busy', 'false');
    expect(await page.evaluate(() => (window as typeof window & { authFallbacks: string[] }).authFallbacks)).toEqual([]);
    await expect(page.locator('aside.sidebar .ft-file')).toHaveCount(0);
    indexGate.resolve();
    await expect(file(page, currentId)).toBeVisible();
  } finally { indexGate.resolve(); }
});

test('a warm reload immediately restores cached directory and body, then revalidates both against the server', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  await page.goto(`${backend.baseURL}/#note/${currentId}`);
  await expect(reader(page).locator('.kr-markdown')).toContainText(currentMarker);
  await waitForPersistedCache(page, currentId);
  const original = (await (await page.request.get(`${backend.baseURL}/api/notes/${currentId}`)).json()).note;
  const changedTitle = '01.服务端更新后的研究资料';
  const changedBody = '服务端最新正文已经替换旧缓存内容。';
  const saved = await page.request.patch(`${backend.baseURL}/api/notes/${currentId}`, { data: {
    note: { ...original, title: changedTitle, content: `# ${changedTitle}\n\n${changedBody}` }, revision: original.revision,
  } });
  expect(saved.status()).toBe(200);
  const indexGate = deferred();
  const documentGate = deferred();
  await page.route('**/api/notes/index', route => passAfter(route, indexGate));
  await page.route(`**/api/notes/${currentId}`, route => passAfter(route, documentGate));
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    // Both authoritative requests are still blocked: this content can only
    // come from the previous page's persisted browser read cache.
    await expect(file(page, currentId)).toContainText(currentTitle);
    await expect(reader(page).locator('.kr-title')).toHaveText(currentTitle);
    await expect(reader(page).locator('.kr-markdown')).toContainText(currentMarker);
    await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toBeEnabled();
    indexGate.resolve();
    documentGate.resolve();
    await expect(file(page, currentId)).toContainText(changedTitle);
    await expect(reader(page).locator('.kr-title')).toHaveText(changedTitle);
    await expect(reader(page).locator('.kr-markdown')).toContainText(changedBody);
    await expect(reader(page).locator('.kr-markdown')).not.toContainText(currentMarker);
    await page.unroute('**/api/notes/index');
    await page.unroute(`**/api/notes/${currentId}`);
    await page.reload();
    await expect(reader(page).locator('.kr-markdown')).toContainText(changedBody);
  } finally { indexGate.resolve(); documentGate.resolve(); }
});

test('an authoritative empty index clears cached deleted documents and tabs even while the detail request is stalled', async ({ page, backend }) => {
  const registration = await page.request.post(`${backend.baseURL}/api/auth/register`, { data: {
    name: accountName, email: 'empty-library@isolated.test', password: 'Isolated-empty-library-2026!',
  } });
  expect(registration.status()).toBe(201);
  const imported = await page.request.post(`${backend.baseURL}/api/notes/import`, { data: { notes: [{
    id: currentId, title: currentTitle, path: `研究资料/${currentTitle}.md`, category: '研究资料', tags: [],
    content: `# ${currentTitle}\n\n${currentMarker}`,
  }] } });
  expect(imported.status()).toBe(201);
  await page.goto(`${backend.baseURL}/#note/${currentId}`);
  await expect(reader(page).locator('.kr-markdown')).toContainText(currentMarker);
  await file(page, currentId).dblclick();
  await waitForPersistedCache(page, currentId);
  expect((await page.request.delete(`${backend.baseURL}/api/notes/${currentId}`)).status()).toBe(204);

  const indexGate = deferred();
  const detailGate = deferred();
  await page.route('**/api/notes/index', route => passAfter(route, indexGate));
  await page.route(`**/api/notes/${currentId}`, async route => {
    await detailGate.promise;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '隔离测试：已删除笔记的正文请求未能完成。' }) });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    // Both authoritative endpoints remain blocked: prove that this browser
    // still holds the old index, pinned tab and body before releasing the index.
    await expect(file(page, currentId)).toBeVisible();
    await expect(page.getByRole('tab', { name: currentTitle, exact: true })).toBeVisible();
    await expect(reader(page).locator('.kr-markdown')).toContainText(currentMarker);
    indexGate.resolve();
    await expect(page.locator('.sidebar-workspace')).toContainText('0 篇文档');
    await expect(page.locator('aside.sidebar .ft-file')).toHaveCount(0);
    await expect(reader(page)).toHaveCount(0);
    await expect(page.getByRole('tablist', { name: '打开的笔记', exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(backend.baseURL + '/');
    await expect(page.getByRole('heading', { level: 1, name: '全部文档', exact: true })).toBeVisible();
    await expect(page.locator('.library-count')).toHaveText('0 篇文档');
    await expect(page.locator('.empty-state')).toContainText('这里还没有笔记');
    const failed = page.waitForResponse(response => apiPath(response.url()) === `/api/notes/${currentId}`);
    detailGate.resolve();
    expect((await failed).status()).toBe(500);
    await expect(reader(page)).toHaveCount(0);
    await expect(page.locator('.library-count')).toHaveText('0 篇文档');
  } finally { indexGate.resolve(); detailGate.resolve(); }
});

test('a late response for the previous note cannot replace the document selected more recently', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const gate = deferred();
  const started = deferred();
  await page.route(`**/api/notes/${currentId}`, route => { started.resolve(); return passAfter(route, gate); });
  try {
    await page.goto(`${backend.baseURL}/#note/${currentId}`);
    await started.promise;
    await expect(file(page, 'fast-unrelated-0')).toBeVisible();
    await file(page, 'fast-unrelated-0').click();
    await expect(reader(page).locator('.kr-title')).toHaveText('03.归档资料1');
    const completed = Promise.race([
      page.waitForResponse(response => apiPath(response.url()) === `/api/notes/${currentId}`),
      page.waitForEvent('requestfailed', request => apiPath(request.url()) === `/api/notes/${currentId}`),
    ]);
    gate.resolve();
    await completed;
    // Let any queued resolution effects render before asserting the winner.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(/#note\/fast-unrelated-0$/);
    await expect(reader(page).locator('.kr-title')).toHaveText('03.归档资料1');
    await expect(reader(page).locator('.kr-markdown')).not.toContainText(currentMarker);
    await expect(page.getByRole('tab', { name: '03.归档资料1', exact: true })).toHaveAttribute('aria-selected', 'true');
  } finally { gate.resolve(); }
});

test('server-backed full-text search and backlinks include unloaded document bodies beyond their excerpts', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const gets: string[] = [];
  page.on('request', request => { if (request.method() === 'GET') gets.push(apiPath(request.url())); });
  await page.goto(`${backend.baseURL}/#note/${currentId}`);
  const backlinks = reader(page).getByRole('region', { name: '反向链接', exact: true });
  await expect(backlinks.getByRole('button', { name: new RegExp(incomingTitle) })).toBeVisible();
  expect(gets).toContain(`/api/notes/${currentId}/backlinks`);
  expect(gets).not.toContain(`/api/notes/${incomingId}`);
  const index = await (await page.request.get(`${backend.baseURL}/api/notes/index`)).json();
  expect(index.notes.find((note: { id: string }) => note.id === incomingId).excerpt).not.toContain(searchMarker);
  await page.getByRole('button', { name: '查看全部文档', exact: true }).click();
  const searched = page.waitForResponse(response => apiPath(response.url()) === '/api/notes/search' && new URL(response.url()).searchParams.get('q') === searchMarker);
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill(searchMarker);
  expect((await (await searched).json()).ids).toEqual([incomingId]);
  const rows = page.locator('.notes-table tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(incomingTitle);
  expect(gets).not.toContain('/api/notes');
  expect(gets).not.toContain(`/api/notes/${incomingId}`);
  await rows.first().click();
  await expect(reader(page).locator('.kr-title')).toHaveText(incomingTitle);
  await expect(reader(page).locator('.kr-markdown')).toContainText(searchMarker);
});

test('a failed document request can be retried manually without changing the directory revision', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const original = (await (await page.request.get(`${backend.baseURL}/api/notes/${currentId}`)).json()).note;
  const firstResponse = deferred();
  let documentRequests = 0;
  await page.route(`**/api/notes/${currentId}`, async route => {
    documentRequests += 1;
    if (documentRequests !== 1) { await route.continue(); return; }
    // Settle the index before reporting the failure, so a metadata revision
    // arriving afterwards cannot accidentally act as the retry being tested.
    await firstResponse.promise;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '文档读取暂时失败，请重新读取。' }) });
  });
  try {
    await page.goto(`${backend.baseURL}/#note/${currentId}`);
    await expect(file(page, currentId)).toBeVisible();
    firstResponse.resolve();
    const failed = page.getByRole('alert').filter({ hasText: '文档读取暂时失败，请重新读取。' });
    await expect(failed).toBeVisible();
    expect(documentRequests).toBe(1);
    await failed.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(reader(page).locator('.kr-markdown')).toContainText(currentMarker);
    await expect(failed).toHaveCount(0);
    expect(documentRequests).toBe(2);
    const unchanged = (await (await page.request.get(`${backend.baseURL}/api/notes/${currentId}`)).json()).note;
    expect(unchanged.revision).toBe(original.revision);
    expect(unchanged.content).toBe(original.content);
  } finally { firstResponse.resolve(); }
});

test('an older cached directory cannot discard a pinned tab for a newly created server document', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  await page.goto(`${backend.baseURL}/#note/${currentId}`);
  await expect(reader(page).locator('.kr-markdown')).toContainText(currentMarker);
  await waitForPersistedCache(page, currentId);
  await file(page, currentId).dblclick();
  const oldIndex = await (await page.request.get(`${backend.baseURL}/api/notes/index`)).json();
  const newTitle = '13.刷新前已固定的新增文档';
  const created = await page.request.post(`${backend.baseURL}/api/notes`, { data: { note: {
    title: newTitle, path: `研究资料/${newTitle}.md`, content: `# ${newTitle}\n\n这个服务端文档的固定标签必须保留。`, tags: [],
  } } });
  expect(created.status()).toBe(201);
  const newNote = (await created.json()).note;
  const refreshed = page.waitForResponse(response => apiPath(response.url()) === '/api/notes/index');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await file(page, newNote.id).dblclick();
  await expect(reader(page).locator('.kr-title')).toHaveText(newTitle);
  const pinned = page.getByRole('tab', { name: newTitle, exact: true });
  await expect(pinned.locator('.nt-title')).toHaveCSS('font-style', 'normal');
  await page.getByRole('tab', { name: currentTitle, exact: true }).click();
  await expect(reader(page).locator('.kr-markdown')).toContainText(currentMarker);
  await waitForPersistedCache(page, newNote.id);

  // Simulate a previous browser cache snapshot without altering the server or
  // the real tab state produced by opening and pinning the new document.
  await page.evaluate(async index => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('zhiyu-server-cache-v1', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('index', 'readwrite');
        transaction.objectStore('index').put(index, 'current');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
  }, oldIndex);
  const indexGate = deferred();
  await page.route('**/api/notes/index', route => passAfter(route, indexGate));
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(reader(page).locator('.kr-markdown')).toContainText(currentMarker);
    await expect(file(page, currentId)).toBeVisible();
    await expect(file(page, newNote.id)).toHaveCount(0);
    await expect.poll(() => page.evaluate(id => JSON.parse(sessionStorage.getItem('zhiyu-note-tabs-v1') || '{}').ids?.includes(id), newNote.id)).toBe(true);
    indexGate.resolve();
    await expect(file(page, newNote.id)).toBeVisible();
    await expect(pinned).toBeVisible();
    await expect(pinned.locator('.nt-title')).toHaveCSS('font-style', 'normal');
    await expect(page.getByRole('tab', { name: currentTitle, exact: true })).toHaveAttribute('aria-selected', 'true');
    await pinned.click();
    await expect(reader(page).locator('.kr-title')).toHaveText(newTitle);
    await expect(reader(page).locator('.kr-markdown')).toContainText('这个服务端文档的固定标签必须保留。');
  } finally { indexGate.resolve(); }
});
