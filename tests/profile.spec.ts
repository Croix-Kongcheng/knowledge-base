import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/backend';

const password = 'Isolated-profile-browser-password-2026!';
const email = 'profile-owner@isolated.test';
const reader = (page: Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: '个人资料', exact: true });

async function register(page: Page, baseURL: string, name = 'example_member') {
  const response = await page.request.post(`${baseURL}/api/auth/register`, { data: { name, email, password } });
  expect(response.status()).toBe(201);
  return (await response.json()).user;
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: '账号菜单', exact: true }).click();
  await page.getByRole('button', { name: '个人资料', exact: true }).click();
  await expect(settings(page)).toBeVisible();
  return settings(page);
}

test('a member renames their own display ID and authors update without changing account identity or note permissions', async ({ page, browser, backend }) => {
  const owner = await register(page, backend.baseURL);
  const ownResponse = await page.request.post(`${backend.baseURL}/api/notes`, { data: { title: '名称更新验收文档', content: '# 名称更新验收\n\n账号改名后仍由原作者编辑。', path: '账号资料/名称更新验收文档.md' } });
  expect(ownResponse.status()).toBe(201);
  const own = (await ownResponse.json()).note;
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    expect((await other.request.post(`${backend.baseURL}/api/auth/register`, { data: { name: '另一位作者', email: 'profile-other@isolated.test', password } })).status()).toBe(201);
    const foreignResponse = await other.request.post(`${backend.baseURL}/api/notes`, { data: { title: '另一位作者的文档', content: '# 其他资料', path: '账号资料/另一位作者的文档.md' } });
    expect(foreignResponse.status()).toBe(201);
    const foreign = (await foreignResponse.json()).note;

    await page.goto(`${backend.baseURL}/#note/${own.id}`);
    await expect(reader(page).getByRole('button', { name: '编辑笔记', exact: true })).toBeVisible();
    const panel = await openSettings(page);
    await expect(panel).toContainText(email);
    await expect(panel.getByLabel('显示名称 / ID', { exact: true })).toHaveValue('example_member');
    await panel.getByLabel('显示名称 / ID', { exact: true }).fill('  测试成员  ');
    await panel.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('测试成员');
    await expect(reader(page).locator('.kr-meta')).toContainText('测试成员');
    await expect(reader(page).getByRole('button', { name: '编辑笔记', exact: true })).toBeVisible();
    const notes = (await (await page.request.get(`${backend.baseURL}/api/notes`)).json()).notes;
    expect(notes.find((note: { id: string }) => note.id === own.id)).toMatchObject({ author: '测试成员', ownerId: owner.id, ownerEmail: email, content: own.content, collaborative: false });
    expect(notes.find((note: { id: string }) => note.id === foreign.id)).toMatchObject({ author: '另一位作者', ownerId: foreign.ownerId, content: foreign.content });

    await page.getByRole('button', { name: '查看全部文档', exact: true }).click();
    const row = page.locator('.notes-table tbody tr').filter({ hasText: '名称更新验收文档' });
    await expect(row.locator('.author-cell')).toContainText('测试成员');
    await page.locator('.sidebar-utilities').getByRole('button', { name: '空间成员', exact: true }).click();
    await expect(page.locator('.member-table tbody tr').filter({ hasText: email })).toContainText('测试成员');
    await expect(page.locator('.member-table tbody tr').filter({ hasText: 'profile-other@isolated.test' })).toContainText('另一位作者');
    await page.reload();
    await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('测试成员');

    await page.goto(`${backend.baseURL}/#note/${foreign.id}`);
    await expect(reader(page).getByRole('button', { name: '编辑笔记', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '账号菜单', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('访客');
    await expect(page.getByRole('dialog', { name: '欢迎来到知屿', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '登录账号', exact: true }).click();
    const login = page.getByRole('dialog', { name: '很高兴，再次见到你', exact: true });
    await login.getByLabel('邮箱地址', { exact: true }).fill(email);
    await login.getByLabel('密码', { exact: true }).fill(password);
    await login.getByRole('button', { name: '进入我的知识空间', exact: false }).click();
    await expect(login).toHaveCount(0);
    await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('测试成员');
    await page.goto(`${backend.baseURL}/#note/${own.id}`);
    await expect(reader(page).getByRole('button', { name: '编辑笔记', exact: true })).toBeVisible();
    expect((await (await page.request.get(`${backend.baseURL}/api/session`)).json()).user).toMatchObject({ id: owner.id, name: '测试成员', email, role: 'member' });

    // Profile settings must preserve the draft beneath the dialog. Ctrl+S
    // belongs to the modal while it is open and must not save that draft.
    await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
    const editor = page.getByRole('region', { name: '编辑笔记', exact: true });
    const draft = '# 尚未提交的正文\n\n修改名称不会保存或丢弃这个草稿。';
    await editor.getByRole('tab', { name: '源码', exact: true }).click();
    await editor.getByLabel('笔记内容', { exact: true }).fill(draft);
    let noteWrites = 0;
    const captureWrites = (request: { method: () => string; url: () => string }) => {
      if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/notes/${own.id}`) noteWrites++;
    };
    page.on('request', captureWrites);
    const profile = await openSettings(page);
    await page.keyboard.press('Control+s');
    await expect(profile).toBeVisible();
    await expect(editor.getByLabel('笔记内容', { exact: true })).toHaveValue(draft);
    expect(noteWrites).toBe(0);
    await profile.getByRole('button', { name: '取消', exact: true }).click();
    await expect(editor.getByLabel('笔记内容', { exact: true })).toHaveValue(draft);
    expect((await (await page.request.get(`${backend.baseURL}/api/notes/${own.id}`)).json()).note.content).toBe(own.content);
    page.off('request', captureWrites);
    page.once('dialog', dialog => dialog.accept());
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await expect(reader(page)).toBeVisible();
  } finally { await otherContext.close(); }
});

test('mobile name settings validate, keep failed drafts and prevent closing or duplicate submission while saving', async ({ page, backend }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, backend.baseURL);
  await page.goto(backend.baseURL);
  let panel = await openSettings(page);
  const input = panel.getByLabel('显示名称 / ID', { exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('maxlength', '30');
  await input.fill('  ');
  await panel.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('请输入显示名称');
  await input.fill('保留我的草稿');
  await page.route('**/api/profile', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '名称服务暂时不可用，请重试。' }) }));
  await panel.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('名称服务暂时不可用');
  await expect(input).toHaveValue('保留我的草稿');
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('example_member');
  await page.unroute('**/api/profile');

  let releaseRequest: () => void = () => {};
  const released = new Promise<void>(resolve => { releaseRequest = resolve; });
  let requests = 0;
  await page.route('**/api/profile', async route => { requests++; await released; await route.continue(); });
  await panel.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(input).toBeDisabled();
  await expect(panel.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  releaseRequest();
  await expect(panel).toHaveCount(0);
  expect(requests).toBe(1);
  await page.unroute('**/api/profile');
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('保留我的草稿');
  panel = await openSettings(page);
  await panel.getByRole('button', { name: '保存名称', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: '关闭个人资料', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
