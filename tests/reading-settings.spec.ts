import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/backend';

const title = '阅读设置与文字选择验收';
const content = `# ${title}\n\n这是一段带有 **加粗文字**、[参考链接](https://example.com) 和 \`inline_code\` 的公开测试内容，用于检查拖动选择时每一种文字都清晰可见。\n\n${Array.from({ length: 24 }, (_, index) => `## 第${index + 1}节\n\n${'正文排版应当根据字号和页边距实时调整，编辑时同样需要完整显示所有文字。'.repeat(5)}`).join('\n\n')}\n\n\`\`\`text\ncode_selection_sample\n\`\`\``;

const reader = (page: Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: '阅读设置', exact: true });

async function seedWorkspace(page: Page, baseURL: string) {
  const account = await page.request.post(`${baseURL}/api/auth/register`, { data: {
    name: '阅读设置验收作者', email: 'reading-settings@isolated-browser.test', password: 'Isolated-reading-settings-password-2026!',
  } });
  expect(account.status()).toBe(201);
  const imported = await page.request.post(`${baseURL}/api/notes/import`, { data: { notes: [{
    id: 'reading-settings-note', title, content, path: `阅读体验/${title}.md`, category: '阅读体验', tags: ['界面验收'], color: '#8b7cf8',
  }] } });
  expect(imported.status()).toBe(201);
  await page.goto(`${baseURL}/#note/reading-settings-note`);
  await expect(reader(page).getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await expect(settings(page)).toBeVisible();
  return settings(page);
}

async function setRangeEnd(slider: Locator, key: 'Home' | 'End') {
  await slider.focus();
  await slider.press(key);
}

async function fontSize(locator: Locator) {
  return locator.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
}

async function documentMargin(page: Page) {
  return reader(page).locator('.kr-document').evaluate(element => Number.parseFloat(getComputedStyle(element).paddingLeft));
}

async function paragraphSpacing(locator: Locator) {
  return locator.evaluate(element => ({
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    paragraphSpacing: Number.parseFloat(getComputedStyle(element).marginBottom),
  }));
}

function contrast(foreground: string, background: string) {
  const luminance = (value: string) => {
    const channels = value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test('line and paragraph spacing migrate older preferences, apply immediately and persist independently of document content', async ({ page, backend }) => {
  await page.addInitScript(() => {
    const key = 'zhiyu-reading-preferences-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ fontSize: 16, pageMargin: 32 }));
  });
  await seedWorkspace(page, backend.baseURL);
  const paragraph = reader(page).locator('.kr-markdown>p').first();
  let panel = await openSettings(page);
  await expect(panel.getByRole('spinbutton', { name: '行间距数值', exact: true })).toHaveValue('1.95');
  await expect(panel.getByRole('spinbutton', { name: '段间距数值', exact: true })).toHaveValue('18');
  await expect.poll(() => fontSize(paragraph)).toBe(16);
  await expect.poll(() => documentMargin(page)).toBe(32);
  await expect.poll(() => paragraphSpacing(paragraph)).toEqual({ lineHeight: 31.2, paragraphSpacing: 18 });

  await setRangeEnd(panel.getByRole('slider', { name: '行间距', exact: true }), 'End');
  await setRangeEnd(panel.getByRole('slider', { name: '段间距', exact: true }), 'Home');
  await expect.poll(() => paragraphSpacing(paragraph)).toEqual({ lineHeight: 48, paragraphSpacing: 0 });
  await panel.getByRole('spinbutton', { name: '行间距数值', exact: true }).fill('2.4');
  await panel.getByRole('spinbutton', { name: '段间距数值', exact: true }).fill('36');
  await expect.poll(() => paragraphSpacing(paragraph)).toEqual({ lineHeight: 38.4, paragraphSpacing: 36 });
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(reader(page)).toBeVisible();
  await expect.poll(() => paragraphSpacing(paragraph)).toEqual({ lineHeight: 38.4, paragraphSpacing: 36 });

  panel = await openSettings(page);
  const lineInput = panel.getByRole('spinbutton', { name: '行间距数值', exact: true });
  const paragraphInput = panel.getByRole('spinbutton', { name: '段间距数值', exact: true });
  await lineInput.fill('1');
  await lineInput.press('Tab');
  await expect(lineInput).toHaveValue('1.2');
  await paragraphInput.fill('100');
  await paragraphInput.press('Tab');
  await expect(paragraphInput).toHaveValue('64');
  await expect.poll(() => paragraphSpacing(paragraph)).toEqual({ lineHeight: 19.2, paragraphSpacing: 64 });
  await paragraphInput.fill('');
  await paragraphInput.press('Tab');
  await expect(paragraphInput).toHaveValue('64');
  await panel.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(lineInput).toHaveValue('1.95');
  await expect(paragraphInput).toHaveValue('18');
  await expect.poll(() => paragraphSpacing(paragraph)).toEqual({ lineHeight: 27.3, paragraphSpacing: 18 });
  await page.keyboard.press('Escape');
  await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
  const editor = page.getByRole('region', { name: '编辑笔记', exact: true });
  await expect(editor.locator('.cm-content')).toBeVisible();
  panel = await openSettings(page);
  await panel.getByRole('spinbutton', { name: '行间距数值', exact: true }).fill('2.4');
  await panel.getByRole('spinbutton', { name: '段间距数值', exact: true }).fill('36');
  await page.keyboard.press('Escape');
  await expect.poll(() => editor.locator('.cm-content').evaluate(element => Number.parseFloat(getComputedStyle(element).lineHeight))).toBe(33.6);
  await expect.poll(() => editor.locator('.cm-paragraph-end').first().evaluate(element => Number.parseFloat(getComputedStyle(element).paddingBottom))).toBe(36);
  await editor.getByRole('tab', { name: '预览', exact: true }).click();
  await expect.poll(() => paragraphSpacing(editor.locator('.ne-preview>p').first())).toEqual({ lineHeight: 33.6, paragraphSpacing: 36 });
  await editor.getByRole('tab', { name: '源码', exact: true }).click();
  await expect.poll(() => editor.getByLabel('笔记内容', { exact: true }).evaluate(element => Number.parseFloat(getComputedStyle(element).lineHeight))).toBe(33.6);
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(reader(page)).toBeVisible();
  expect((await (await page.request.get(`${backend.baseURL}/api/notes`)).json()).notes[0].content).toBe(content);
});

test('reading preferences change the page immediately, persist and resize inline editing without clipped text', async ({ page, backend }) => {
  // Wide enough to apply a 720px margin on both sides without clamping it.
  await page.setViewportSize({ width: 2560, height: 1100 });
  await seedWorkspace(page, backend.baseURL);
  const paragraph = reader(page).locator('.kr-markdown>p').first();
  const initialWidth = (await paragraph.boundingBox())!.width;
  let panel = await openSettings(page);
  await setRangeEnd(panel.getByRole('slider', { name: '正文大小', exact: true }), 'End');
  await expect.poll(() => fontSize(paragraph)).toBe(24);
  await setRangeEnd(panel.getByRole('slider', { name: '左右页边距', exact: true }), 'Home');
  await expect.poll(() => documentMargin(page)).toBe(0);
  expect((await paragraph.boundingBox())!.width).toBeGreaterThan(initialWidth);
  await setRangeEnd(panel.getByRole('slider', { name: '左右页边距', exact: true }), 'End');
  await expect.poll(() => documentMargin(page)).toBe(480);
  const marginInput = panel.getByRole('spinbutton', { name: '左右页边距数值', exact: true });
  await expect(marginInput).not.toHaveAttribute('max', /.*/);
  await marginInput.fill('720');
  await expect.poll(() => documentMargin(page)).toBe(720);
  await marginInput.fill('');
  await marginInput.press('Tab');
  await expect(marginInput).toHaveValue('720');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(reader(page)).toBeVisible();
  await expect.poll(() => fontSize(paragraph)).toBe(24);
  await expect.poll(() => documentMargin(page)).toBe(720);

  panel = await openSettings(page);
  await expect(panel.getByRole('spinbutton', { name: '左右页边距数值', exact: true })).toHaveValue('720');
  await panel.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect.poll(() => fontSize(paragraph)).toBe(14);
  await expect.poll(() => documentMargin(page)).toBe(48);
  await expect(panel.getByRole('spinbutton', { name: '左右页边距数值', exact: true })).toHaveValue('48');
  await page.keyboard.press('Escape');
  await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
  const editor = page.getByRole('region', { name: '编辑笔记', exact: true });
  await editor.getByRole('tab', { name: '源码', exact: true }).click();
  const textarea = editor.getByLabel('笔记内容', { exact: true });
  await expect(textarea).toHaveValue(content);
  const initialHeight = await textarea.evaluate(element => element.clientHeight);
  panel = await openSettings(page);
  await setRangeEnd(panel.getByRole('slider', { name: '正文大小', exact: true }), 'End');
  await panel.getByRole('spinbutton', { name: '左右页边距数值', exact: true }).fill('720');
  await expect.poll(() => fontSize(textarea)).toBe(24);
  await expect.poll(() => editor.locator('.ne-form').evaluate(element => Number.parseFloat(getComputedStyle(element).paddingLeft))).toBe(720);
  await expect.poll(() => textarea.evaluate(element => element.clientHeight)).toBeGreaterThan(initialHeight);
  await expect.poll(() => textarea.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await editor.getByRole('tab', { name: '预览', exact: true }).click();
  await expect.poll(() => fontSize(editor.locator('.ne-preview>p').first())).toBe(24);
  await expect(editor.locator('.ne-preview')).toContainText('第24节');
  // Display preferences must not dirty or change the underlying document.
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(reader(page)).toBeVisible();
  const saved = (await (await page.request.get(`${backend.baseURL}/api/notes`)).json()).notes[0];
  expect(saved.content).toBe(content);
});

test('selected text keeps readable foreground and background contrast in both themes including nested links and code', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  for (const [name, theme] of [['Obsidian 深色', 'obsidian'], ['Obsidian 浅色', 'light']]) {
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const styles = await reader(page).locator('.kr-markdown>p').first().evaluate(paragraph => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      selection.removeAllRanges();
      selection.addRange(range);
      return { selected: selection.toString(), colors: [paragraph, ...paragraph.querySelectorAll('strong,a,code')].map(element => {
        const style = getComputedStyle(element, '::selection');
        return { tag: element.tagName, foreground: style.color, background: style.backgroundColor };
      }) };
    });
    expect(styles.selected).toContain('inline_code');
    expect(styles.selected).toContain('参考链接');
    expect(styles.colors.map(item => item.tag)).toEqual(['P', 'STRONG', 'A', 'CODE']);
    for (const item of styles.colors) {
      expect(item.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(contrast(item.foreground, item.background), `${theme}: selected ${item.tag}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
  await page.getByRole('region', { name: '编辑笔记', exact: true }).getByRole('tab', { name: '源码', exact: true }).click();
  const textarea = page.getByLabel('笔记内容', { exact: true });
  const selectedInput = await textarea.evaluate(element => {
    const input = element as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(0, 20);
    const style = getComputedStyle(input, '::selection');
    return { length: input.selectionEnd - input.selectionStart, foreground: style.color, background: style.backgroundColor };
  });
  expect(selectedInput.length).toBe(20);
  expect(contrast(selectedInput.foreground, selectedInput.background)).toBeGreaterThanOrEqual(4.5);
});

test('reading settings can be dismissed with keyboard or outside click and remain usable on a narrow screen', async ({ page, backend }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedWorkspace(page, backend.baseURL);
  let panel = await openSettings(page);
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(panel.getByRole('slider', { name: '正文大小', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: '阅读设置', exact: true })).toBeFocused();

  panel = await openSettings(page);
  await setRangeEnd(panel.getByRole('slider', { name: '正文大小', exact: true }), 'End');
  await setRangeEnd(panel.getByRole('slider', { name: '左右页边距', exact: true }), 'End');
  await expect(panel.getByRole('spinbutton', { name: '左右页边距数值', exact: true })).toHaveValue('480');
  await panel.getByRole('spinbutton', { name: '左右页边距数值', exact: true }).fill('720');
  await expect.poll(() => documentMargin(page)).toBeLessThan(120);
  expect((await reader(page).locator('.kr-markdown').boundingBox())!.width).toBeGreaterThanOrEqual(239);
  await page.mouse.click(8, 800);
  await expect(panel).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  // The preference remains large; its rendered margin adapts to the available
  // document column, including when the desktop outline occupies another column.
  await page.setViewportSize({ width: 1440, height: 1100 });
  await expect.poll(() => documentMargin(page)).toBeGreaterThan(120);
  expect((await reader(page).locator('.kr-markdown').boundingBox())!.width).toBeGreaterThanOrEqual(239);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
  const editor = page.getByRole('region', { name: '编辑笔记', exact: true });
  await editor.getByRole('tab', { name: '源码', exact: true }).click();
  const textarea = editor.getByLabel('笔记内容', { exact: true });
  await expect(textarea).toHaveValue(content);
  expect(await textarea.evaluate(element => {
    const style = getComputedStyle(element);
    return element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  })).toBeGreaterThanOrEqual(239);
  panel = await openSettings(page);
  await expect(panel.getByRole('spinbutton', { name: '左右页边距数值', exact: true })).toHaveValue('720');
  await panel.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(panel.getByRole('spinbutton', { name: '左右页边距数值', exact: true })).toHaveValue('48');
  await page.keyboard.press('Escape');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(reader(page)).toBeVisible();
  expect((await (await page.request.get(`${backend.baseURL}/api/notes`)).json()).notes[0].content).toBe(content);
});
