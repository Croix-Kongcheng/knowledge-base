import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures/backend';
import { formatReadingDuration } from '../src/lib/readingAnalytics';

const password = 'Isolated-reading-analytics-2026!';
const memberName = '阅读验收成员';
const memberEmail = 'reading-member@isolated.test';
const documents = [
  { id: 'reading-alpha', title: '01.低空研究方法', path: '研究资料/01.低空研究方法.md' },
  { id: 'reading-beta', title: '02.巡检实验记录', path: '研究资料/02.巡检实验记录.md' },
];
const reader = (page: Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });
const file = (page: Page, index: number) => page.locator(`.sidebar .ft-file[data-note-id="${documents[index].id}"]`);

async function registerAndSeed(page: Page, baseURL: string) {
  const registered = await page.request.post(`${baseURL}/api/auth/register`, { data: { name: memberName, email: memberEmail, password } });
  expect(registered.status()).toBe(201);
  const imported = await page.request.post(`${baseURL}/api/notes/import`, { data: { notes: documents.map(document => ({ ...document, category: '研究资料', tags: [], content: `# ${document.title}\n\n用于隔离验收的阅读正文。` })) } });
  expect(imported.status()).toBe(201);
  return (await registered.json()).user;
}

async function activateAdmin(request: APIRequestContext, baseURL: string, dataDir: string) {
  const setup = JSON.parse(await readFile(path.join(dataDir, 'admin-setup.json'), 'utf8'));
  const response = await request.post(`${baseURL}/api/auth/activate-admin`, { data: { token: setup.token, password } });
  expect(response.status()).toBe(200);
}

async function stats(request: APIRequestContext, baseURL: string) {
  const response = await request.get(`${baseURL}/api/admin/reading`);
  expect(response.status()).toBe(200);
  return response.json();
}

test('real foreground reading excludes the first ten seconds and inactive tabs, and only administrators can inspect per-user and per-note totals', async ({ page, browser, backend }) => {
  test.setTimeout(180_000);
  const user = await registerAndSeed(page, backend.baseURL);
  const adminContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    await activateAdmin(adminContext.request, backend.baseURL, backend.dataDir);
    const starts: { sessionId: string; noteId: string }[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/reading/start') starts.push(request.postDataJSON()); });
    await page.goto(`${backend.baseURL}/#note/${documents[0].id}`);
    await page.bringToFront();
    await expect(reader(page).getByRole('heading', { name: documents[0].title, level: 1, exact: true })).toBeVisible();
    await expect.poll(() => starts.some(value => value.noteId === documents[0].id)).toBe(true);
    await expect(page.getByRole('button', { name: '阅读统计', exact: true })).toHaveCount(0);
    expect((await page.request.get(`${backend.baseURL}/api/admin/reading?userId=${user.id}`)).status()).toBe(403);
    await page.waitForTimeout(8_000);
    expect((await stats(adminContext.request, backend.baseURL)).summary.totalMs).toBe(0);

    // Keep A pinned while displaying B. A's sub-ten-second visit must stay zero.
    await page.getByRole('tab', { name: documents[0].title, exact: true }).dblclick();
    await file(page, 1).dblclick();
    await expect(reader(page).getByRole('heading', { name: documents[1].title, level: 1, exact: true })).toBeVisible();
    await expect(page.getByRole('tablist', { name: '打开的笔记', exact: true }).getByRole('tab')).toHaveCount(2);
    await expect.poll(async () => (await stats(adminContext.request, backend.baseURL)).records.find((record: { noteId: string }) => record.noteId === documents[1].id)?.totalMs || 0, { timeout: 25_000 }).toBeGreaterThan(0);
    const qualifying = await stats(adminContext.request, backend.baseURL);
    expect(qualifying.records).toHaveLength(1);
    expect(qualifying.records[0]).toMatchObject({ userId: user.id, noteId: documents[1].id });
    expect(qualifying.records[0].totalMs).toBeLessThan(10_000);

    const session = [...starts].reverse().find(value => value.noteId === documents[1].id)!;
    const stopped = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reading/stop' && response.request().postDataJSON()?.sessionId === session.sessionId && response.status() === 200);
    const elsewhere = await page.context().newPage();
    await elsewhere.goto(backend.baseURL);
    // Playwright forces every page to stay focused. Disable that override for
    // real headed acceptance; headless Chromium has no native window focus,
    // so its default test run explicitly supplies the same browser blur event.
    for (const target of [page, elsewhere]) {
      const cdp = await page.context().newCDPSession(target);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    }
    await elsewhere.bringToFront();
    const headless = await page.evaluate(() => navigator.userAgent.includes('HeadlessChrome'));
    if (headless) await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
      window.dispatchEvent(new Event('blur'));
    });
    await expect.poll(() => page.evaluate(() => document.visibilityState !== 'visible' || !document.hasFocus())).toBe(true);
    await stopped;
    const paused = await stats(adminContext.request, backend.baseURL);
    await elsewhere.waitForTimeout(11_000);
    expect((await stats(adminContext.request, backend.baseURL)).summary.totalMs).toBe(paused.summary.totalMs);

    // Returning to another note creates a fresh qualification window.
    await page.bringToFront();
    if (headless) await page.evaluate(() => {
      Reflect.deleteProperty(document, 'hasFocus');
      window.dispatchEvent(new Event('focus'));
    });
    await file(page, 0).click();
    await expect(reader(page).getByRole('heading', { name: documents[0].title, level: 1, exact: true })).toBeVisible();
    await page.waitForTimeout(12_000);
    await page.getByRole('button', { name: '知识概览', exact: true }).click();
    await expect.poll(async () => (await stats(adminContext.request, backend.baseURL)).records.length).toBe(2);
    const accumulated = await stats(adminContext.request, backend.baseURL);
    const sum = accumulated.records.reduce((total: number, record: { totalMs: number }) => total + record.totalMs, 0);
    expect(accumulated.summary).toMatchObject({ totalMs: sum, readerCount: 1, noteCount: 2, pairCount: 2 });
    expect(accumulated.users.find((value: { userId: string }) => value.userId === user.id)).toMatchObject({ totalMs: sum, noteCount: 2 });
    expect(accumulated.notes.every((value: { readerCount: number }) => value.readerCount === 1)).toBe(true);

    const admin = await adminContext.newPage();
    await admin.goto(backend.baseURL);
    await expect(admin.getByRole('button', { name: '阅读统计', exact: true })).toBeVisible();
    await admin.getByRole('button', { name: '阅读统计', exact: true }).click();
    const dashboard = admin.getByRole('region', { name: '阅读时间统计', exact: true });
    const memberRow = dashboard.locator('.ra-users-table tbody tr').filter({ hasText: memberEmail });
    await expect(memberRow).toContainText(formatReadingDuration(sum));
    await memberRow.getByRole('button', { name: `查看${memberName}的阅读明细`, exact: true }).click();
    await expect(dashboard.getByRole('tab', { name: '阅读明细', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(dashboard.locator('.ra-records-table tbody tr')).toHaveCount(2);
    await dashboard.getByLabel('筛选阅读笔记', { exact: true }).selectOption(documents[1].id);
    await expect(dashboard.locator('.ra-records-table tbody tr')).toHaveCount(1);
    await expect(dashboard.locator('.ra-records-table tbody')).toContainText(documents[1].title);
    await dashboard.getByLabel('搜索阅读明细', { exact: true }).fill('没有匹配的测试文本');
    await expect(dashboard).toContainText('没有匹配的阅读记录');
    await dashboard.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(dashboard.locator('.ra-records-table tbody tr')).toHaveCount(2);
    await dashboard.getByRole('tab', { name: '笔记统计', exact: true }).click();
    await expect(dashboard.locator('.ra-notes-table tbody tr')).toHaveCount(2);
    await dashboard.getByRole('button', { name: `查看${documents[0].title}的阅读明细`, exact: true }).click();
    await expect(dashboard.locator('.ra-records-table tbody tr')).toHaveCount(1);
    await expect(dashboard.locator('.ra-records-table tbody')).toContainText(documents[0].title);
    await admin.screenshot({ path: '/tmp/zhiyu-reading-admin-desktop.png', fullPage: true });
    await admin.setViewportSize({ width: 390, height: 844 });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await admin.screenshot({ path: '/tmp/zhiyu-reading-admin-mobile.png', fullPage: true });

    const guest = await guestContext.newPage();
    let guestEvents = 0;
    guest.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/reading/')) guestEvents++; });
    await guest.goto(`${backend.baseURL}/#note/${documents[0].id}`);
    await expect(reader(guest)).toBeVisible();
    await expect(guest.getByRole('button', { name: '阅读统计', exact: true })).toHaveCount(0);
    expect((await guest.request.get(`${backend.baseURL}/api/admin/reading`)).status()).toBe(401);
    expect(guestEvents).toBe(0);
  } finally { await guestContext.close();await adminContext.close(); }
});

test('loading placeholders and inline editing never create reading time or expose the administrator page', async ({ page, browser, backend }) => {
  test.setTimeout(90_000);
  await registerAndSeed(page, backend.baseURL);
  const adminContext = await browser.newContext();
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let starts = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/reading/start') starts++; });
  await page.route(`**/api/notes/${documents[0].id}`, async route => { await gate;await route.continue(); });
  try {
    await activateAdmin(adminContext.request, backend.baseURL, backend.dataDir);
    await page.goto(`${backend.baseURL}/#note/${documents[0].id}`);
    await page.bringToFront();
    await expect(page.locator('.reading-placeholder').first()).toBeVisible();
    await page.waitForTimeout(11_000);
    expect(starts).toBe(0);
    expect((await stats(adminContext.request, backend.baseURL)).summary.totalMs).toBe(0);
    release();
    await expect(reader(page)).toBeVisible();
    await expect.poll(() => starts).toBeGreaterThan(0);
    await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
    await expect(page.getByRole('region', { name: '编辑笔记', exact: true })).toBeVisible();
    const before = starts;
    await page.waitForTimeout(11_000);
    expect(starts).toBe(before);
    expect((await stats(adminContext.request, backend.baseURL)).summary.totalMs).toBe(0);
    await expect(page.getByRole('button', { name: '阅读统计', exact: true })).toHaveCount(0);
  } finally { release();await page.unrouteAll({ behavior: 'wait' });await adminContext.close(); }
});
