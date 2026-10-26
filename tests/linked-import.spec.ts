import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import JSZip from 'jszip';
import { test, expect } from './fixtures/backend';

type SourceEntries = Record<string, string>;
type StoredNote = { id: string; path: string; title: string; content: string; attachments?: Record<string, string> };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="22"><rect width="34" height="22" fill="#8064d4"/></svg>';
const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF';
const importer = (page: Page) => page.getByRole('dialog', { name: '把你的知识，带到这里', exact: true });
const preview = (page: Page) => importer(page).getByRole('region', { name: '关联导入预览', exact: true });
const entrySearch = (page: Page) => importer(page).getByRole('textbox', { name: '搜索入口笔记', exact: true });
const entry = (page: Page, entryPath: string) => importer(page).getByRole('checkbox', { name: entryPath, exact: true });
const reader = (page: Page) => page.getByRole('region', { name: '知识库阅读区', exact: true });

async function openLinkedImporter(page: Page, baseURL: string) {
  const account = await page.request.post(`${baseURL}/api/auth/register`, { data: {
    name: '关联导入验收作者', email: 'linked-import@isolated.test', password: 'Isolated-linked-import-2026!',
  } });
  expect(account.status()).toBe(201);
  await page.goto(baseURL);
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toBeEnabled();
  await page.locator('.sidebar-directory-heading').getByRole('button', { name: '导入笔记', exact: true }).click();
  await expect(importer(page).getByRole('tab', { name: /^选择文件夹/ })).toHaveAttribute('aria-selected', 'true');
  await importer(page).getByRole('tab', { name: /关联导入/ }).click();
}

async function makeSourceDirectory(entries: SourceEntries) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'zhiyu-linked-source-'));
  const directory = path.join(temporary, '关联验收库');
  for (const [entryPath, content] of Object.entries(entries)) {
    const filename = path.join(directory, entryPath);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }
  return { directory, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

async function chooseFolderSource(page: Page, directory: string) {
  await importer(page).getByLabel('关联导入来源文件夹', { exact: true }).setInputFiles(directory);
  await expect(entrySearch(page)).toBeVisible();
}

async function chooseZipSource(page: Page, entries: SourceEntries, archiveName: string) {
  const archive = new JSZip();
  const vaultRoot = archiveName.replace(/\.zip$/i, '');
  for (const [entryPath, content] of Object.entries(entries)) archive.file(`${vaultRoot}/${entryPath}`, content);
  await importer(page).getByLabel('关联导入来源ZIP', { exact: true }).setInputFiles({
    name: archiveName, mimeType: 'application/zip', buffer: await archive.generateAsync({ type: 'nodebuffer' }),
  });
  await expect(entrySearch(page)).toBeVisible();
}

async function selectEntry(page: Page, entryPath: string) {
  await entrySearch(page).fill(entryPath);
  await entry(page, entryPath).check();
}

async function analyse(page: Page) {
  await importer(page).getByRole('button', { name: '分析关联内容', exact: true }).click();
  await expect(preview(page)).toBeVisible();
}

async function assertStatistic(region: Locator, label: string, count: number) {
  await expect(region.getByText(label, { exact: true }).locator('..').locator('strong')).toHaveText(String(count));
}

async function savedNotes(page: Page, baseURL: string): Promise<StoredNote[]> {
  const response = await page.request.get(`${baseURL}/api/notes`);
  expect(response.status()).toBe(200);
  return (await response.json()).notes;
}

async function assertStoredAssets(page: Page, backend: { baseURL: string; dataDir: string }, count: number) {
  const index = await page.request.get(`${backend.baseURL}/api/notes/index`);
  expect(index.status()).toBe(200);
  expect((await index.json()).totals.attachments).toBe(count);
  await expect.poll(async () => (await readdir(path.join(backend.dataDir, 'assets'))).length).toBe(count);
}

test('a folder entry imports one note hop with related-note attachments and keeps second-hop notes out', async ({ page, backend }) => {
  const source = await makeSourceDirectory({
    '入口/A.md': '# 入口正文\n\n[[依赖/B|进入B]]\n\n![[附件/共享.svg|共享示意]]\n\n`[[仅代码]]`\n\n```md\n[代码示例](../伪链接/代码文件.md)\n```\n\n<!-- [[注释隐藏]] -->\n\n[外部示例](https://example.invalid/外部.md)',
    '依赖/B.md': '# 第二篇正文\n\n[直达C](./第三篇%20记录.md)\n\n[参考C][c-ref]\n\n[c-ref]: <./第三篇%20记录.md>\n\n[[入口/A|返回A]]\n\n![[附件/共享.svg|共享示意]]\n\n[PDF参考][pdf]\n\n[pdf]: ../附件/说明.pdf',
    '依赖/第三篇 记录.md': '# 第三篇正文\n\n[[入口/A|返回A]]\n\n![[附件/仅C引用.svg]]',
    '附件/仅C引用.svg': svg,
    '附件/共享.svg': svg,
    '附件/说明.pdf': pdf,
    '无关/不导入.md': '# 无关正文\n\n![[附件/无关.svg]]',
    '附件/无关.svg': svg.replace('34', '45'),
    '仅代码.md': '# 不应跟踪行内代码',
    '伪链接/代码文件.md': '# 不应跟踪代码块',
    '注释隐藏.md': '# 不应跟踪注释',
  });
  try {
    await openLinkedImporter(page, backend.baseURL);
    await chooseFolderSource(page, source.directory);
    await selectEntry(page, '入口/A.md');
    await analyse(page);
    await assertStatistic(preview(page), '入口笔记', 1);
    await assertStatistic(preview(page), '关联笔记', 1);
    await assertStatistic(preview(page), '附件', 2);
    const paths = preview(page).getByRole('list', { name: '将导入的笔记', exact: true });
    await expect(paths).toContainText('入口/A.md');
    await expect(paths).toContainText('依赖/B.md');
    await expect(paths).not.toContainText('依赖/第三篇 记录.md');
    await assertStatistic(preview(page), '待补充链接', 0);
    await expect(paths).not.toContainText('无关/不导入.md');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'obsidian');
    await page.screenshot({ path: '/tmp/zhiyu-linked-import-preview.png', fullPage: true });
    await importer(page).getByRole('button', { name: '导入 2 篇笔记', exact: true }).click();
    await expect(importer(page)).toHaveCount(0);

    const notes = await savedNotes(page, backend.baseURL);
    expect(notes.map(note => note.path).sort()).toEqual(['入口/A.md', '依赖/B.md'].sort());
    await assertStoredAssets(page, backend, 2);
    const byPath = (value: string) => notes.find(note => note.path === value)!;
    const first = byPath('入口/A.md');
    const second = byPath('依赖/B.md');
    expect(first.content).toContain(`](#note/${second.id})`);
    expect(second.content).toContain('[直达C](./第三篇%20记录.md)');
    expect(second.content).toContain('[c-ref]: <./第三篇%20记录.md>');
    expect(second.content).toContain(`](#note/${first.id})`);
    expect(first.content).toContain('`[[仅代码]]`');
    expect(new Set(notes.flatMap(note => Object.values(note.attachments || {}))).size).toBe(2);

    await page.goto(`${backend.baseURL}/#note/${first.id}`);
    const image = reader(page).getByRole('img', { name: '共享示意', exact: true });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete ? element.naturalWidth : 0)).toBe(34);
    await reader(page).getByRole('link', { name: '进入B', exact: true }).click();
    await expect(reader(page).locator('.kr-title')).toHaveText('B');
    const relatedImage = reader(page).getByRole('img', { name: '共享示意', exact: true });
    await expect.poll(() => relatedImage.evaluate((element: HTMLImageElement) => element.complete ? element.naturalWidth : 0)).toBe(34);
    const pdfLink = reader(page).getByRole('link', { name: 'PDF参考', exact: true });
    await expect(pdfLink).toHaveAttribute('href', /^\/api\/assets\//);
    const downloaded = await page.request.get(`${backend.baseURL}${await pdfLink.getAttribute('href')}`);
    expect(downloaded.status()).toBe(200);
    expect(downloaded.headers()['content-type']).toContain('application/pdf');
    expect((await downloaded.body()).toString()).toBe(pdf);
    await reader(page).getByRole('link', { name: '返回A', exact: true }).click();
    await expect(reader(page).locator('.kr-title')).toHaveText('A');
  } finally { await source.cleanup(); }
});

test('multiple entries deduplicate shared dependencies and resolve same-named local notes without guessing ambiguous targets', async ({ page, backend }) => {
  const source = await makeSourceDirectory({
    '甲组/入口甲.md': '# 甲组入口\n\n[[共同资料/共享依赖|共享依赖]]\n\n[[同名|甲组同名]]\n\n[[模糊]]\n\n[[不存在]]\n\n![[附件/共享.svg|共享示意]]',
    '乙组/入口乙.md': '# 乙组入口\n\n[[共同资料/共享依赖|共享依赖]]\n\n[乙组同名](./同名.md)\n\n![[附件/共享.svg|共享示意]]',
    '甲组/同名.md': '# 甲组独立内容',
    '乙组/同名.md': '# 乙组独立内容',
    '共同资料/共享依赖.md': '# 唯一共享依赖',
    '候选一/模糊.md': '# 不应猜测第一个候选',
    '候选二/模糊.md': '# 不应猜测第二个候选',
    '无关/不导入.md': '# 无关正文',
    '02私有资料/私人.md': '# 独立测试私密占位，不能出现在来源列表中。',
    '附件/共享.svg': svg,
  });
  try {
    await openLinkedImporter(page, backend.baseURL);
    await chooseFolderSource(page, source.directory);
    await entrySearch(page).fill('私人');
    await expect(entry(page, '02私有资料/私人.md')).toHaveCount(0);
    await selectEntry(page, '甲组/入口甲.md');
    await selectEntry(page, '乙组/入口乙.md');
    await analyse(page);
    await assertStatistic(preview(page), '入口笔记', 2);
    await assertStatistic(preview(page), '关联笔记', 3);
    await assertStatistic(preview(page), '附件', 1);
    await expect(preview(page).locator('.im-warnings')).toContainText('模糊');
    await expect(preview(page).locator('.im-warnings')).toContainText('不存在');
    await expect(preview(page).getByRole('list', { name: '将导入的笔记', exact: true })).not.toContainText('候选一/模糊.md');
    await expect(preview(page).getByRole('list', { name: '将导入的笔记', exact: true })).not.toContainText('候选二/模糊.md');
    await importer(page).getByRole('button', { name: '导入 5 篇笔记', exact: true }).click();
    await expect(importer(page)).toHaveCount(0);

    const notes = await savedNotes(page, backend.baseURL);
    expect(notes.map(note => note.path).sort()).toEqual(['甲组/入口甲.md', '甲组/同名.md', '乙组/入口乙.md', '乙组/同名.md', '共同资料/共享依赖.md'].sort());
    await assertStoredAssets(page, backend, 1);
    const byPath = (value: string) => notes.find(note => note.path === value)!;
    const sourceA = byPath('甲组/入口甲.md');
    const sourceB = byPath('乙组/入口乙.md');
    const localA = byPath('甲组/同名.md');
    const localB = byPath('乙组/同名.md');
    const shared = byPath('共同资料/共享依赖.md');
    expect(sourceA.content).toContain(`](#note/${localA.id})`);
    expect(sourceA.content).not.toContain(`#note/${localB.id}`);
    expect(sourceB.content).toContain(`](#note/${localB.id})`);
    expect(sourceB.content).not.toContain(`#note/${localA.id}`);
    expect(sourceA.content).toContain(`](#note/${shared.id})`);
    expect(sourceB.content).toContain(`](#note/${shared.id})`);
    expect(sourceA.content).toContain('[[模糊]]');
    expect(sourceA.content).toContain('[[不存在]]');
    expect(JSON.stringify(notes)).not.toContain('独立测试私密占位');
  } finally { await source.cleanup(); }
});

test('ZIP entry search, selection changes, source replacement and cancellation never reuse or upload an obsolete preview', async ({ page, backend }) => {
  await openLinkedImporter(page, backend.baseURL);
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && /^\/api\/(?:assets(?:\/|$)|notes\/import$)/.test(new URL(request.url()).pathname)) writes.push(request.url());
  });
  await chooseZipSource(page, {
    '入口/Alpha.md': '# Alpha\n\n[[依赖/Beta|进入Beta]]',
    '依赖/Beta.md': '# Beta',
    '其他/Gamma.md': '# Gamma',
  }, '第一来源.zip');
  await entrySearch(page).fill('Alpha');
  await expect(entry(page, '入口/Alpha.md')).toBeVisible();
  await expect(entry(page, '依赖/Beta.md')).toHaveCount(0);
  await entry(page, '入口/Alpha.md').check();
  await analyse(page);
  await assertStatistic(preview(page), '入口笔记', 1);
  await assertStatistic(preview(page), '关联笔记', 1);
  await expect(importer(page).getByRole('button', { name: '导入 2 篇笔记', exact: true })).toBeEnabled();

  await selectEntry(page, '其他/Gamma.md');
  await expect(preview(page)).toHaveCount(0);
  await expect(importer(page).getByRole('button', { name: /^导入 \d+ 篇笔记$/ })).toHaveCount(0);
  await analyse(page);
  await assertStatistic(preview(page), '入口笔记', 2);
  await assertStatistic(preview(page), '关联笔记', 1);
  await expect(preview(page).getByRole('list', { name: '将导入的笔记', exact: true })).toContainText('其他/Gamma.md');

  await chooseZipSource(page, { '新来源/唯一.md': '# 全新来源正文', '无关/余项.md': '# 未选择的来源' }, '第二来源.zip');
  await expect(preview(page)).toHaveCount(0);
  await entrySearch(page).fill('Alpha');
  await expect(entry(page, '入口/Alpha.md')).toHaveCount(0);
  await expect(entry(page, '其他/Gamma.md')).toHaveCount(0);
  await selectEntry(page, '新来源/唯一.md');
  await analyse(page);
  await assertStatistic(preview(page), '入口笔记', 1);
  await assertStatistic(preview(page), '关联笔记', 0);
  const paths = preview(page).getByRole('list', { name: '将导入的笔记', exact: true });
  await expect(paths).toContainText('新来源/唯一.md');
  await expect(paths).not.toContainText('Alpha');
  await expect(paths).not.toContainText('Beta');
  await expect(paths).not.toContainText('Gamma');
  await importer(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(importer(page)).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(await savedNotes(page, backend.baseURL)).toEqual([]);
  await assertStoredAssets(page, backend, 0);

  await page.locator('.sidebar-directory-heading').getByRole('button', { name: '导入笔记', exact: true }).click();
  await expect(importer(page).getByRole('tab', { name: /^选择文件夹/ })).toHaveAttribute('aria-selected', 'true');
  await importer(page).getByRole('tab', { name: /关联导入/ }).click();
  await expect(importer(page).getByRole('checkbox')).toHaveCount(0);
  await expect(preview(page)).toHaveCount(0);
});
