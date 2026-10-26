import { deflateSync } from 'node:zlib';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/backend';

const email = 'avatar-owner@isolated.test';
const password = 'Isolated-avatar-browser-password-2026!';
const name = '头像验收作者';
const account = (page: Page) => page.getByRole('button', { name: '账号菜单', exact: true });
const profile = (page: Page) => page.getByRole('dialog', { name: '个人资料', exact: true });
const avatarPreview = (page: Page) => profile(page).getByRole('img', { name: '头像预览', exact: true });
const avatar = (container: Locator, displayName = name) => container.getByRole('img', { name: `${displayName}的头像`, exact: true });

// Small valid source images exercise the browser's decoding and square resize.
// The uploaded PNG must be a normalized 512 x 512 image, not this 64 x 32 file.
function sourcePng(rgb: [number, number, number]) {
  const width = 64, height = 32;
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (1 + width * 4) + 1 + x * 4;
    pixels[offset] = rgb[0]; pixels[offset + 1] = rgb[1]; pixels[offset + 2] = rgb[2]; pixels[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function registerAndOpen(page: Page, baseURL: string) {
  const response = await page.request.post(`${baseURL}/api/auth/register`, { data: { name, email, password } });
  expect(response.status()).toBe(201);
  const user = (await response.json()).user as { id: string; name: string; avatarUrl?: string };
  await page.goto(baseURL);
  await expect(account(page)).toBeEnabled();
  await expect(account(page)).toContainText(name);
  return user;
}

async function openProfile(page: Page) {
  await account(page).click();
  await page.getByRole('button', { name: '个人资料', exact: true }).click();
  await expect(profile(page)).toBeVisible();
}

async function chooseImage(page: Page, rgb: [number, number, number] = [118, 85, 204]) {
  await profile(page).getByLabel('选择头像图片', { exact: true }).setInputFiles({ name: 'local-avatar.png', mimeType: 'image/png', buffer: sourcePng(rgb) });
  await expect(avatarPreview(page)).toBeVisible();
  await expect.poll(() => avatarPreview(page).evaluate((image: HTMLImageElement) => image.complete ? image.naturalWidth : 0)).toBe(512);
}

async function saveAvatar(page: Page, method: 'POST' | 'DELETE' = 'POST') {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/profile/avatar' && value.request().method() === method);
  await profile(page).getByRole('button', { name: '保存头像', exact: true }).click();
  const saved = await response;
  expect(saved.status()).toBe(200);
  return (await saved.json()).user as { id: string; name: string; avatarUrl?: string };
}

async function assertAvatarImage(image: Locator, url: string) {
  await expect(image).toHaveAttribute('src', url);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete ? element.naturalWidth : 0)).toBe(512);
}

async function session(page: Page, baseURL: string) {
  const response = await page.request.get(`${baseURL}/api/session`);
  expect(response.status()).toBe(200);
  return (await response.json()).user as { id: string; name: string; avatarUrl?: string };
}

test('choosing a local avatar and cancelling changes neither the account nor the stored avatar', async ({ page, backend }) => {
  const user = await registerAndOpen(page, backend.baseURL);
  const writes: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/profile/avatar' && request.method() !== 'GET') writes.push(request.method());
  });
  await openProfile(page);
  await chooseImage(page);
  await expect(profile(page).getByRole('button', { name: '保存头像', exact: true })).toBeEnabled();
  await profile(page).getByLabel('显示名称 / ID', { exact: true }).fill('同样不保存的名称草稿');
  await profile(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(profile(page)).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(await session(page, backend.baseURL)).toMatchObject({ id: user.id, name });
  expect((await session(page, backend.baseURL)).avatarUrl).toBeUndefined();
  await expect(avatar(account(page))).toHaveCount(0);
  await openProfile(page);
  await expect(avatarPreview(page)).toHaveCount(0);
  await expect(profile(page).getByLabel('显示名称 / ID', { exact: true })).toHaveValue(name);
  await profile(page).getByRole('button', { name: '关闭个人资料', exact: true }).click();
  await page.reload();
  await expect(avatar(account(page))).toHaveCount(0);
  expect((await session(page, backend.baseURL)).avatarUrl).toBeUndefined();
});

test('saved avatars persist across author rows, members, reload and another login, and replacing or resetting changes the server version', async ({ page, browser, backend }) => {
  const user = await registerAndOpen(page, backend.baseURL);
  const created = await page.request.post(`${backend.baseURL}/api/notes`, { data: { title: '头像同步验收文档', path: '头像同步/头像同步验收文档.md', content: '# 作者资料\n\n这篇正文不随头像修改。' } });
  expect(created.status()).toBe(201);
  const note = (await created.json()).note;
  await page.reload();
  await openProfile(page);
  await chooseImage(page);
  const saved = await saveAvatar(page);
  expect(saved.avatarUrl).toMatch(new RegExp(`^/api/avatars/${user.id}/[a-f0-9]{32}\\.png$`));
  const firstUrl = saved.avatarUrl!;
  await expect(profile(page)).toBeVisible();
  await assertAvatarImage(avatar(account(page)), firstUrl);
  await page.screenshot({ path: '/tmp/zhiyu-avatar-profile-preview.png', fullPage: true });
  await profile(page).getByRole('button', { name: '关闭个人资料', exact: true }).click();

  const downloaded = await page.request.get(`${backend.baseURL}${firstUrl}`);
  expect(downloaded.status()).toBe(200);
  expect(downloaded.headers()['content-type']).toContain('image/png');
  const firstBytes = await downloaded.body();
  expect(firstBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect([firstBytes.readUInt32BE(16), firstBytes.readUInt32BE(20)]).toEqual([512, 512]);
  expect((await session(page, backend.baseURL)).avatarUrl).toBe(firstUrl);
  const members = (await (await page.request.get(`${backend.baseURL}/api/members`)).json()).members;
  expect(members.find((member: { id: string }) => member.id === user.id).avatarUrl).toBe(firstUrl);
  const storedNote = (await (await page.request.get(`${backend.baseURL}/api/notes/${note.id}`)).json()).note;
  expect(storedNote).toMatchObject({ ownerId: user.id, ownerAvatarUrl: firstUrl, content: note.content });
  await page.getByRole('button', { name: '查看全部文档', exact: true }).click();
  const authorRow = page.locator('.notes-table tbody tr').filter({ hasText: '头像同步验收文档' });
  await assertAvatarImage(avatar(authorRow.locator('.author-cell')), firstUrl);
  await page.locator('.sidebar-utilities').getByRole('button', { name: '空间成员', exact: true }).click();
  await assertAvatarImage(avatar(page.locator('.member-table tbody tr').filter({ hasText: email })), firstUrl);
  await page.reload();
  await assertAvatarImage(avatar(account(page)), firstUrl);

  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto(backend.baseURL);
    await expect(account(other)).toBeEnabled();
    await expect(other.getByRole('dialog', { name: '欢迎来到知屿', exact: true })).toBeVisible();
    await other.getByRole('tab', { name: '登录账号', exact: true }).click();
    const login = other.getByRole('dialog', { name: '很高兴，再次见到你', exact: true });
    await login.getByLabel('邮箱地址', { exact: true }).fill(email);
    await login.getByLabel('密码', { exact: true }).fill(password);
    await login.getByRole('button', { name: '进入我的知识空间', exact: false }).click();
    await expect(login).toHaveCount(0);
    await assertAvatarImage(avatar(account(other)), firstUrl);
    expect((await session(other, backend.baseURL)).avatarUrl).toBe(firstUrl);

    await openProfile(page);
    await chooseImage(page, [48, 165, 128]);
    const replacement = await saveAvatar(page);
    const secondUrl = replacement.avatarUrl!;
    expect(secondUrl).not.toBe(firstUrl);
    await assertAvatarImage(avatar(account(page)), secondUrl);
    expect((await page.request.get(`${backend.baseURL}${firstUrl}`)).status()).toBe(404);
    expect(await (await page.request.get(`${backend.baseURL}${secondUrl}`)).body()).not.toEqual(firstBytes);
    await other.reload();
    await assertAvatarImage(avatar(account(other)), secondUrl);

    let deletes = 0;
    page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/profile/avatar') deletes++; });
    await profile(page).getByRole('button', { name: '恢复默认头像', exact: true }).click();
    await expect(avatarPreview(page)).toHaveCount(0);
    await assertAvatarImage(avatar(account(page)), secondUrl);
    expect(deletes).toBe(0);
    expect((await session(page, backend.baseURL)).avatarUrl).toBe(secondUrl);
    const reset = await saveAvatar(page, 'DELETE');
    expect(reset.avatarUrl).toBeUndefined();
    expect(deletes).toBe(1);
    await expect(avatar(account(page))).toHaveCount(0);
    expect((await page.request.get(`${backend.baseURL}${secondUrl}`)).status()).toBe(404);
    expect((await (await page.request.get(`${backend.baseURL}/api/notes/${note.id}`)).json()).note).toMatchObject({ ownerId: user.id, content: note.content });
    expect((await (await page.request.get(`${backend.baseURL}/api/notes/${note.id}`)).json()).note.ownerAvatarUrl).toBeUndefined();
    await profile(page).getByRole('button', { name: '关闭个人资料', exact: true }).click();
    await page.reload();
    await expect(avatar(account(page))).toHaveCount(0);
    await other.reload();
    await expect(account(other)).toContainText(name);
    await expect(avatar(account(other))).toHaveCount(0);
    expect((await session(other, backend.baseURL)).avatarUrl).toBeUndefined();
  } finally { await otherContext.close(); }
});

test('mobile avatar validation and failed uploads keep independent drafts and guard an in-flight retry', async ({ page, backend }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await registerAndOpen(page, backend.baseURL);
  await openProfile(page);
  let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/profile/avatar') uploads++; });
  await profile(page).getByLabel('选择头像图片', { exact: true }).setInputFiles({ name: 'broken-avatar.png', mimeType: 'image/png', buffer: Buffer.from('This is not an image.') });
  await expect(profile(page).getByRole('alert')).toContainText(/图片|格式|损坏|读取/);
  await expect(avatarPreview(page)).toHaveCount(0);
  expect(uploads).toBe(0);
  const draftName = '只保留在输入框的名称';
  await profile(page).getByLabel('显示名称 / ID', { exact: true }).fill(draftName);
  await chooseImage(page);
  const draftUrl = await avatarPreview(page).getAttribute('src');
  await page.route('**/api/profile/avatar', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '头像验收服务暂时不可用，请重试。' }) }));
  await profile(page).getByRole('button', { name: '保存头像', exact: true }).click();
  await expect(profile(page).getByRole('alert')).toContainText('头像验收服务暂时不可用');
  await expect(avatarPreview(page)).toHaveAttribute('src', draftUrl!);
  await expect(profile(page).getByLabel('显示名称 / ID', { exact: true })).toHaveValue(draftName);
  expect(await session(page, backend.baseURL)).toMatchObject({ name });
  expect((await session(page, backend.baseURL)).avatarUrl).toBeUndefined();
  expect(uploads).toBe(1);
  await page.unroute('**/api/profile/avatar');

  let release: () => void = () => {};
  const released = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/profile/avatar', async route => { await released; await route.continue(); });
  try {
    await profile(page).getByRole('button', { name: '保存头像', exact: true }).click();
    await expect(profile(page).getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await expect(profile(page).getByLabel('显示名称 / ID', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(profile(page)).toBeVisible();
    expect(uploads).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await profile(page).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    release();
    await expect(avatar(account(page))).toBeVisible();
    await expect(profile(page).getByLabel('显示名称 / ID', { exact: true })).toHaveValue(draftName);
    expect(uploads).toBe(2);
    expect((await session(page, backend.baseURL)).name).toBe(name);
    await page.screenshot({ path: '/tmp/zhiyu-avatar-mobile-final.png' });
    await profile(page).getByRole('button', { name: '取消', exact: true }).click();
    await expect(profile(page)).toHaveCount(0);
    await page.reload();
    await expect(account(page)).toContainText(name);
    await expect(avatar(account(page))).toBeVisible();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('another member can enlarge an avatar on desktop and mobile without changing the account', async ({ page, browser, backend }) => {
  await registerAndOpen(page, backend.baseURL);
  await openProfile(page);
  await chooseImage(page);
  const saved = await saveAvatar(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    const registered = await other.request.post(`${backend.baseURL}/api/auth/register`, { data: { name: '查看头像的成员', email: 'avatar-viewer@isolated.test', password } });
    expect(registered.status()).toBe(201);
    const writes: string[] = [];
    other.on('request', request => { if (new URL(request.url()).pathname === '/api/profile/avatar' && !['GET', 'HEAD'].includes(request.method())) writes.push(request.method()); });
    await other.goto(backend.baseURL);
    await expect(account(other)).toContainText('查看头像的成员');
    await other.locator('.sidebar-utilities').getByRole('button', { name: '空间成员', exact: true }).click();
    const trigger = other.getByRole('button', { name: `查看${name}的头像`, exact: true });
    const viewer = other.getByRole('dialog', { name: `${name}的头像`, exact: true });
    await expect(other.locator('.member-table .member-avatar-button')).toHaveCount(1);
    for (const width of [1280, 390]) {
      await other.setViewportSize({ width, height: 844 });
      await trigger.click();
      await expect(viewer).toBeVisible();
      const image = viewer.getByRole('img', { name: `${name}的头像大图`, exact: true });
      await assertAvatarImage(image, saved.avatarUrl!);
      await expect(image).toHaveCSS('object-fit', 'contain');
      const bounds = await viewer.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
      await image.click();
      await expect(viewer).toBeVisible();
      await other.keyboard.press('Tab');
      await expect(viewer.getByRole('button', { name: '关闭头像大图', exact: true })).toBeFocused();
      await other.keyboard.press('Escape');
      await expect(viewer).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await viewer.getByRole('button', { name: '关闭头像大图', exact: true }).click();
      await expect(viewer).toHaveCount(0);
      await trigger.click();
      await other.mouse.click(2, 2);
      await expect(viewer).toHaveCount(0);
    }
    expect(writes).toEqual([]);
    expect((await session(page, backend.baseURL)).avatarUrl).toBe(saved.avatarUrl);
    expect((await session(other, backend.baseURL)).name).toBe('查看头像的成员');
  } finally { await otherContext.close(); }
});
