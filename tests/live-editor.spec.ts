import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/backend';

const noteId = 'live-editor-original-note';
const title = '实时编辑体验';
const originalAssetId = 'live-editor-existing-picture';
const originalBody = '# 实时编辑\n\n**重点内容**\n\n![既有示意](asset:live-editor-existing-picture)\n\n| 项目 | 数量 |\n| --- | --- |\n| 一号 | 2 |\n\n末尾段落。';
const reader = (page: Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });
const editor = (page: Page) => page.getByRole('region', { name: '编辑笔记', exact: true });
const liveContent = (page: Page) => editor(page).locator('.cm-content[aria-label="笔记内容"]');
const sourceContent = (page: Page) => editor(page).locator('textarea[aria-label="笔记内容"], textarea#ne-content');
const save = (page: Page) => editor(page).getByRole('button', { name: '保存修改', exact: true });

async function seedWorkspace(page: Page, baseURL: string) {
  const registration = await page.request.post(`${baseURL}/api/auth/register`, {
    data: { name: '实时编辑作者', email: 'live-editor-owner@isolated.test', password: 'Live-editor-isolated-2026!' },
  });
  expect(registration.status()).toBe(201);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18"><rect width="24" height="18" fill="#8064d4"/></svg>';
  const upload = await page.request.post(`${baseURL}/api/assets/${originalAssetId}`, {
    data: Buffer.from(svg), headers: { 'Content-Type': 'image/svg+xml', 'X-Asset-Path': encodeURIComponent('附件/原有示意.svg') },
  });
  expect(upload.status()).toBe(201);
  const create = await page.request.post(`${baseURL}/api/notes`, { data: { note: {
    id: noteId, title, path: `编辑器/${title}.md`, content: originalBody,
    attachments: { '附件/原有示意.svg': `asset:${originalAssetId}` },
  } } });
  expect(create.status()).toBe(201);
  await page.goto(`${baseURL}/#note/${noteId}`);
  await expect(reader(page).getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  await reader(page).getByRole('button', { name: '编辑笔记', exact: true }).click();
  await expect(liveContent(page)).toBeVisible();
  await expect(editor(page).getByRole('tab', { name: '编辑', exact: true })).toHaveAttribute('aria-selected', 'true');
}

async function getNote(page: Page, baseURL: string) {
  const response = await page.request.get(`${baseURL}/api/notes/${noteId}`);
  expect(response.status()).toBe(200);
  return (await response.json()).note as {
    id: string; title: string; content: string; revision: number;
    attachments: Record<string, string>; attachmentSizes: Record<string, number>;
  };
}

async function assertImage(image: Locator, width: number) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete ? element.naturalWidth : 0)).toBe(width);
}

async function pasteImage(page: Page, count = 1) {
  await liveContent(page).focus();
  await page.keyboard.press('Control+End');
  return liveContent(page).evaluate(async (target, total) => {
    const canvas = document.createElement('canvas');
    canvas.width = 28;canvas.height = 20;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#8064d4';context.fillRect(0, 0, canvas.width, canvas.height);
    const image = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
    const clipboard = new DataTransfer();
    for (let index = 0; index < total; index++) clipboard.items.add(new File([image], `clipboard-${index + 1}.png`, { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return { size: image.size, prevented: event.defaultPrevented };
  }, count);
}

test('live editing renders bold, images and tables while preserving editable Markdown, shortcuts and saved content', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  await assertImage(editor(page).getByRole('img', { name: '既有示意', exact: true }), 24);
  await expect(editor(page).getByRole('table')).toContainText('一号');
  await expect.poll(() => editor(page).getByText('重点内容', { exact: true }).evaluate(element => Number(getComputedStyle(element).fontWeight))).toBeGreaterThanOrEqual(600);

  // A rendered table becomes real Markdown when selected, so its cells remain
  // editable in the same editor rather than being an immutable preview.
  await editor(page).getByRole('table').click();
  const header = liveContent(page).locator('.cm-line').filter({ hasText: '| 项目 | 数量 |' });
  await expect(header).toBeVisible();
  await header.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.insertText('| 名称 | 数量 |');
  await expect(liveContent(page)).toContainText('| 名称 | 数量 |');
  const updated = originalBody.replace('| 项目 | 数量 |', '| 名称 | 数量 |');

  await liveContent(page).focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n\nkeyboardbold');
  const beforeBold = updated.length + '\n\nkeyboardbold'.length;
  const counter = editor(page).locator('.ne-editor-bottom');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await page.keyboard.press('Control+b');
  await expect(counter).toContainText(`${(beforeBold + 4).toLocaleString('zh-CN')} 字符`);
  await page.keyboard.press('Control+z');
  await expect(counter).toContainText(`${beforeBold.toLocaleString('zh-CN')} 字符`);
  await page.keyboard.press('Control+Shift+z');
  await expect(counter).toContainText(`${(beforeBold + 4).toLocaleString('zh-CN')} 字符`);
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n\nkeyboarditalic');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await page.keyboard.press('Control+i');
  const expected = `${updated}\n\n**keyboardbold**\n\n*keyboarditalic*`;

  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  await expect(sourceContent(page)).toHaveValue(expected);
  // Changes made in the source tab share live editing history and replace an
  // abandoned redo branch instead of allowing it to overwrite new source text.
  const sourceEdited = `${expected}\n\n源码新增段落。`;
  await sourceContent(page).fill(sourceEdited);
  await editor(page).getByRole('tab', { name: '编辑', exact: true }).click();
  await liveContent(page).focus();
  await page.keyboard.press('Control+z');
  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  await expect(sourceContent(page)).toHaveValue(expected);
  await editor(page).getByRole('tab', { name: '编辑', exact: true }).click();
  await liveContent(page).focus();
  await page.keyboard.press('Control+Shift+z');
  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  await expect(sourceContent(page)).toHaveValue(sourceEdited);
  await editor(page).getByRole('tab', { name: '编辑', exact: true }).click();
  await liveContent(page).focus();
  await page.keyboard.press('Control+z');
  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  await expect(sourceContent(page)).toHaveValue(expected);
  const newSourceBranch = `${expected}\n\n另一条源码修改。`;
  await sourceContent(page).fill(newSourceBranch);
  await editor(page).getByRole('tab', { name: '编辑', exact: true }).click();
  await liveContent(page).focus();
  await page.keyboard.press('Control+Shift+z');
  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  await expect(sourceContent(page)).toHaveValue(newSourceBranch);
  await sourceContent(page).fill(expected);
  await editor(page).getByRole('tab', { name: '预览', exact: true }).click();
  await expect(editor(page).getByRole('table').getByRole('columnheader', { name: '名称', exact: true })).toBeVisible();
  await expect(editor(page).locator('.ne-preview strong')).toContainText(['重点内容', 'keyboardbold']);
  await expect(editor(page).locator('.ne-preview em')).toContainText('keyboarditalic');
  await editor(page).getByRole('tab', { name: '编辑', exact: true }).click();
  await expect(liveContent(page)).toBeVisible();
  await save(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect((await getNote(page, backend.baseURL)).content).toBe(expected);
  await page.reload();
  await expect(reader(page).getByRole('columnheader', { name: '名称', exact: true })).toBeVisible();
  await expect(reader(page).locator('.kr-markdown strong')).toContainText(['重点内容', 'keyboardbold']);
  await expect(reader(page).locator('.kr-markdown em')).toContainText('keyboarditalic');
  await assertImage(reader(page).getByRole('img', { name: '既有示意', exact: true }), 24);
});

test('pasting images uploads independent attachments and saves stable references with correct sizes, including multiple images', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const uploaded: Array<{ id: string; path: string; size: number }> = [];
  page.on('response', async response => {
    if (response.request().method() === 'POST' && /\/api\/assets\/editor-image-/.test(response.url()) && response.ok()) {
      uploaded.push((await response.json()).asset);
    }
  });
  const clipboard = await pasteImage(page, 2);
  expect(clipboard.prevented).toBe(true);
  await expect.poll(() => uploaded.length).toBe(2);
  await expect(editor(page).getByRole('img', { name: '粘贴图片', exact: true })).toHaveCount(2);
  await assertImage(editor(page).getByRole('img', { name: '粘贴图片', exact: true }).first(), 28);
  await expect(save(page)).toBeEnabled();
  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  const markdown = await sourceContent(page).inputValue();
  expect(markdown).not.toContain('data:image');
  for (const asset of uploaded) {
    expect(asset.path).toMatch(/^附件\/粘贴图片-.+\.png$/);
    expect(asset.size).toBe(clipboard.size);
    expect(markdown).toContain(`![粘贴图片](asset:${asset.id})`);
  }
  await save(page).click();
  await expect(editor(page)).toHaveCount(0);
  const note = await getNote(page, backend.baseURL);
  expect(note.id).toBe(noteId);
  expect(note.attachments['附件/原有示意.svg']).toBe(`asset:${originalAssetId}`);
  for (const asset of uploaded) {
    expect(note.attachments[asset.path]).toBe(`asset:${asset.id}`);
    expect(note.attachmentSizes[`asset:${asset.id}`]).toBe(clipboard.size);
  }
  expect(note.content).toBe(markdown);
  await page.reload();
  await expect(reader(page).getByRole('img', { name: '粘贴图片', exact: true })).toHaveCount(2);
  for (const image of await reader(page).getByRole('img', { name: '粘贴图片', exact: true }).all()) {
    await assertImage(image, 28);
    await expect(image).toHaveAttribute('src', /^\/api\/assets\/editor-image-/);
  }
  await assertImage(reader(page).getByRole('img', { name: '既有示意', exact: true }), 24);
});

test('failed pastes keep the draft, retries work, and cancelling during an upload removes only the unsaved image', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const before = await getNote(page, backend.baseURL);
  const storedBefore = (await readdir(path.join(backend.dataDir, 'assets'))).sort();
  await liveContent(page).focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n\n必须保留的草稿');
  await page.route('**/api/assets/editor-image-*', async route => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '图片上传暂时失败，请重试。' }) });
    } else await route.continue();
  });
  await pasteImage(page);
  await expect(editor(page).getByRole('alert')).toContainText('图片上传暂时失败');
  await expect(liveContent(page)).toContainText('必须保留的草稿');
  await expect(editor(page).getByRole('img', { name: '粘贴图片', exact: true })).toHaveCount(0);
  expect((await getNote(page, backend.baseURL)).content).toBe(before.content);
  await page.unroute('**/api/assets/editor-image-*');

  let release!: () => void;
  const holdAcknowledgement = new Promise<void>(resolve => { release = resolve; });
  let uploaded: { id: string; path: string; size: number } | undefined;
  await page.route('**/api/assets/editor-image-*', async route => {
    if (route.request().method() !== 'POST') { await route.continue();return; }
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    uploaded = (await response.json()).asset;
    await holdAcknowledgement;
    await route.fulfill({ response });
  });
  try {
    await pasteImage(page);
    await expect.poll(() => Boolean(uploaded)).toBe(true);
    await expect(editor(page).locator('.ne-editor-bottom').getByRole('status')).toContainText('正在上传图片');
    await expect(save(page)).toBeDisabled();
    const cancel = editor(page).getByRole('button', { name: '取消', exact: true });
    await expect(cancel).toBeEnabled();
    const confirmation = page.waitForEvent('dialog');
    const clickingCancel = cancel.click();
    const dialog = await confirmation;
    expect(dialog.message()).toContain('尚未保存');
    await dialog.accept();
    await clickingCancel;
    await expect(editor(page)).toHaveCount(0);
  } finally { release(); }
  await expect.poll(async () => (await page.request.get(`${backend.baseURL}/api/assets/${uploaded!.id}`)).status()).toBe(404);
  await expect.poll(async () => (await readdir(path.join(backend.dataDir, 'assets'))).sort()).toEqual(storedBefore);
  expect(await getNote(page, backend.baseURL)).toMatchObject({ content: before.content, revision: before.revision, attachments: before.attachments });
  expect((await page.request.get(`${backend.baseURL}/api/assets/${originalAssetId}`)).status()).toBe(200);
  await assertImage(reader(page).getByRole('img', { name: '既有示意', exact: true }), 24);
});

test('undo and redo restore the completed pasted image without losing surrounding edits or uploading again', async ({ page, backend }) => {
  await seedWorkspace(page, backend.baseURL);
  const beforeImage = '\n\n上传前保留的文字';
  const duringUpload = '上传尚未完成时继续补充的文字';
  await liveContent(page).focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(beforeImage);
  let uploadRequests = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/assets\/editor-image-/.test(request.url())) uploadRequests++;
  });
  let release!: () => void;
  const holdAcknowledgement = new Promise<void>(resolve => { release = resolve; });
  let committed = false;
  await page.route('**/api/assets/editor-image-*', async route => {
    if (route.request().method() !== 'POST') { await route.continue();return; }
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = true;
    await holdAcknowledgement;
    await route.fulfill({ response });
  });
  const uploadResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && /\/api\/assets\/editor-image-/.test(response.url()));
  let clipboard!: Awaited<ReturnType<typeof pasteImage>>;
  try {
    clipboard = await pasteImage(page);
    await expect.poll(() => committed).toBe(true);
    await expect(editor(page).locator('.ne-editor-bottom').getByRole('status')).toContainText('正在上传图片');
    await expect(save(page)).toBeDisabled();
    // Keep the actual POST response pending while the user continues writing.
    // Its later replacement must preserve both the new text and its history.
    await liveContent(page).focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(duringUpload);
    await expect(liveContent(page)).toContainText(duringUpload);
    await expect(liveContent(page)).toContainText('上传前保留的文字');
  } finally { release(); }
  const response = await uploadResponse;
  expect(response.status()).toBe(201);
  const asset = (await response.json()).asset as { id: string; path: string; size: number };
  const pasted = () => editor(page).getByRole('img', { name: '粘贴图片', exact: true });
  await assertImage(pasted(), 28);
  await expect(save(page)).toBeEnabled();
  await expect(liveContent(page)).toContainText(duringUpload);

  await liveContent(page).focus();
  await page.keyboard.press('Control+z');
  await expect(liveContent(page)).not.toContainText(duringUpload);
  await assertImage(pasted(), 28);
  await expect(liveContent(page)).toContainText('上传前保留的文字');
  await page.keyboard.press('Control+z');
  await expect(pasted()).toHaveCount(0);
  await expect(liveContent(page)).toContainText('上传前保留的文字');
  await expect(editor(page).locator('.ne-editor-bottom')).toContainText(`${(originalBody.length + beforeImage.length).toLocaleString('zh-CN')} 字符`);
  await page.keyboard.press('Control+Shift+z');
  await assertImage(pasted(), 28);
  await expect(pasted()).toHaveAttribute('src', `/api/assets/${asset.id}`);
  await expect(liveContent(page)).toContainText('上传前保留的文字');
  await expect(editor(page).getByRole('status').filter({ hasText: '正在上传图片' })).toHaveCount(0);
  expect(uploadRequests).toBe(1);
  await expect(liveContent(page)).not.toContainText(duringUpload);
  await page.keyboard.press('Control+Shift+z');
  await expect(liveContent(page)).toContainText(duringUpload);
  await assertImage(pasted(), 28);

  await editor(page).getByRole('tab', { name: '源码', exact: true }).click();
  const markdown = await sourceContent(page).inputValue();
  expect(markdown).toContain(originalBody + beforeImage);
  expect(markdown).toContain(`![粘贴图片](asset:${asset.id})`);
  expect(markdown).toContain(duringUpload);
  expect(markdown).not.toContain('pending-image:');
  expect(markdown.match(new RegExp(`asset:${asset.id}`, 'g'))).toHaveLength(1);
  expect(uploadRequests).toBe(1);
  await save(page).click();
  await expect(editor(page)).toHaveCount(0);
  const note = await getNote(page, backend.baseURL);
  expect(note.content).toBe(markdown);
  expect(note.attachments[asset.path]).toBe(`asset:${asset.id}`);
  expect(note.attachmentSizes[`asset:${asset.id}`]).toBe(clipboard.size);
  expect(note.attachments['附件/原有示意.svg']).toBe(`asset:${originalAssetId}`);
  await page.reload();
  await assertImage(reader(page).getByRole('img', { name: '粘贴图片', exact: true }), 28);
  await expect(reader(page)).toContainText(duringUpload);
  await expect(reader(page)).toContainText('上传前保留的文字');
});
