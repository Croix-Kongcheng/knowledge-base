import { test, expect } from './fixtures/backend';

const account = { name: '自动登录提示验收', email: 'auto-account@isolated.test', password: 'Isolated-auto-account-2026!' };
const sessionPath = (url: string) => new URL(url).pathname === '/api/session';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}

test('guests get an automatic dismissible prompt, can sign in, and see it again after logout', async ({ page, backend }) => {
  expect((await page.request.post(`${backend.baseURL}/api/auth/register`, { data: account })).status()).toBe(201);
  await page.context().clearCookies();
  await page.goto(backend.baseURL);
  const prompt = page.getByRole('dialog', { name: '欢迎来到知屿', exact: true });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole('tab', { name: '注册账号', exact: true })).toBeVisible();
  await expect(prompt.getByRole('tab', { name: '登录账号', exact: true })).toBeVisible();
  await prompt.getByRole('button', { name: '关闭账号窗口', exact: true }).click();
  await expect(prompt).toHaveCount(0);

  // Background identity revalidation must respect an intentional dismissal.
  const refresh = page.waitForResponse(response => sessionPath(response.url()));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refresh;
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText('访客');
  await expect(prompt).toHaveCount(0);
  await page.reload();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('tab', { name: '登录账号', exact: true }).click();
  const signin = page.getByRole('dialog', { name: '很高兴，再次见到你', exact: true });
  await signin.getByLabel('邮箱地址', { exact: true }).fill(account.email);
  await signin.getByLabel('密码', { exact: true }).fill(account.password);
  await signin.getByRole('button', { name: '进入我的知识空间', exact: false }).click();
  await expect(signin).toHaveCount(0);
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText(account.name);
  await page.reload();
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toContainText(account.name);
  await expect(page.locator('.au-modal')).toHaveCount(0);
  await page.getByRole('button', { name: '账号菜单', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(prompt).toBeVisible();
});

test('a delayed valid session never opens the account prompt while identity is loading', async ({ page, backend }) => {
  expect((await page.request.post(`${backend.baseURL}/api/auth/register`, { data: account })).status()).toBe(201);
  const gate = deferred();
  const requested = deferred();
  await page.route('**/api/session', async route => {
    requested.resolve();
    await gate.promise;
    await route.continue().catch(() => {});
  });
  try {
    await page.goto(backend.baseURL);
    await requested.promise;
    const menu = page.getByRole('button', { name: '账号菜单', exact: true });
    await expect(menu).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.au-modal')).toHaveCount(0);
    gate.resolve();
    await expect(menu).toHaveAttribute('aria-busy', 'false');
    await expect(menu).toContainText(account.name);
    await expect(page.locator('.au-modal')).toHaveCount(0);
  } finally { gate.resolve(); }
});

test('a session service failure does not count as being logged out, and a verified guest opens the prompt after recovery', async ({ page, backend }) => {
  await page.route('**/api/session', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法确认登录状态' }),
  }));
  const failure = page.waitForResponse(response => sessionPath(response.url()) && response.status() === 503);
  await page.goto(backend.baseURL);
  await failure;
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.au-modal')).toHaveCount(0);
  await page.unroute('**/api/session');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('dialog', { name: '欢迎来到知屿', exact: true })).toBeVisible();
});
