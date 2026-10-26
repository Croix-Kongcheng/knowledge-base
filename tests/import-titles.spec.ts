import { expect, test, type Page } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:5174' });

type Note = { id: string; title: string; path: string; content: string; attachments: Record<string, string> };
type ParsedFixture = {
  mode: string;
  notes: Note[];
  assets: { id: string; path: string; size: number }[];
  report: { notes: number; attachments: number; resolvedLinks: number; unresolvedLinks: number };
};
const titles = ['01.准备与实施计划', '02-UAV：巡检与路径', '03点号.v2_记录', '10 收尾 · 复盘'];

async function stubApplicationApi(page: Page, getNotes: () => Note[] = () => []) {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const routePath = url.pathname;
    const notes = getNotes();
    const index = notes.map(({ content, attachments, ...metadata }) => ({
      ...metadata,
      excerpt: content.replace(/[#*`>[\]]/g, '').slice(0, 120),
      contentBytes: Buffer.byteLength(content),
      attachmentCount: new Set(Object.values(attachments || {})).size,
      attachmentBytes: 0,
    }));
    const fixtures: Record<string, unknown> = {
      '/api/session': { user: null, needsAdminSetup: false },
      '/api/notes': { notes },
      '/api/notes/index': { notes: index, totals: {
        notes: notes.length,
        attachments: index.reduce((sum, note) => sum + note.attachmentCount, 0),
        contentBytes: index.reduce((sum, note) => sum + note.contentBytes, 0),
        attachmentBytes: 0,
      } },
      '/api/notes/search': { ids: notes.filter(note => `${note.title}\n${note.content}`.includes(url.searchParams.get('q') || '')).map(note => note.id) },
      '/api/members': { members: [] },
      '/api/storage': { availableBytes: 1024 * 1024 * 1024 },
    };
    const noteMatch = routePath.match(/^\/api\/notes\/([^/]+)(\/backlinks)?$/);
    if (noteMatch && !(routePath in fixtures)) {
      const id = decodeURIComponent(noteMatch[1]);
      const note = notes.find(value => value.id === id);
      if (note) fixtures[routePath] = noteMatch[2]
        ? { ids: notes.filter(value => value.id !== id && value.content.includes(`#note/${id}`)).map(value => value.id) }
        : { note };
    }
    return route.fulfill({
      status: route.request().method() === 'GET' && routePath in fixtures ? 200 : 503,
      contentType: 'application/json',
      body: JSON.stringify(fixtures[routePath] || { error: 'Unexpected API request in isolated title-import test' }),
    });
  });
}

async function parseFixtures(page: Page, modes: string[]) {
  return page.evaluate(async inputModes => {
    const modulePath = '/src/lib/importer.ts';
    const source = await (await fetch(modulePath)).text();
    const jszipPath = source.match(/from ["']([^"']*\/jszip\.js[^"']*)["']/)![1];
    const { default: JSZip } = await import(jszipPath);
    const { parseImportFiles } = await import(modulePath);
    const entries = [
      ['研究资料/10 收尾 · 复盘.md', '# 工作回顾（原始正文标题）\n\n正文中的标题保持不变。'],
      ['研究资料/02-UAV：巡检与路径.MARKDOWN', '---\ntitle: 元数据标题也不能替代文件名\ntags: [验收]\n---\n# 路径与频次（原始正文标题）\n\n第二份资料。'],
      ['研究资料/01.准备与实施计划.md', '---\ntitle: 不应采用的元数据标题\n---\n# 总体方案（原始正文标题）\n\n[[02-UAV：巡检与路径]]\n\n[自定义跳转](10%20%E6%94%B6%E5%B0%BE%20%C2%B7%20%E5%A4%8D%E7%9B%98.md)\n\n![[图示.svg]]\n\n[固定引用](#note/unchanged-stable-id)'],
      ['研究资料/03点号.v2_记录.md', '没有一级标题时也使用完整文件名。'],
      ['附件/图示.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="16" height="12"/></svg>'],
    ];
    const output = [];
    for (const mode of inputModes) {
      let files: File[];
      if (mode === 'zip') {
        const zip = new JSZip();
        for (const [path, content] of entries) zip.file(`验收知识库/${path}`, content);
        files = [new File([await zip.generateAsync({ type: 'uint8array' })], '验收知识库.zip')];
      } else {
        const selected = mode === 'single' ? entries.filter(([path]) => path.endsWith('.MARKDOWN')) : entries;
        files = selected.map(([path, content]) => {
          const file = new File([content], path.split('/').pop()!, { type: 'text/plain' });
          if (mode === 'directory') Object.defineProperty(file, 'webkitRelativePath', { value: `验收知识库/${path}` });
          return file;
        });
      }
      const parsed = await parseImportFiles(files);
      output.push({ mode, notes: parsed.notes, report: parsed.report, assets: parsed.assets.map((asset: { id: string; path: string; blob: Blob }) => ({ id: asset.id, path: asset.path, size: asset.blob.size })) });
    }
    return output;
  }, modes) as Promise<ParsedFixture[]>;
}

test('directory, ZIP and individual Markdown imports use original filenames while preserving body headings, links and assets', async ({ page }) => {
  await stubApplicationApi(page);
  await page.goto('/');
  const results = await parseFixtures(page, ['directory', 'zip', 'individual', 'single']);
  for (const result of results) {
    if (result.mode === 'single') {
      expect.soft(result.notes.map(note => note.title), 'single Markdown: display name comes from filename').toEqual([titles[1]]);
      expect(result.notes[0].content).toMatch(/^# 路径与频次（原始正文标题）\n/);
      expect(result.report).toMatchObject({ notes: 1, attachments: 0, unresolvedLinks: 0 });
      continue;
    }
    expect.soft(result.notes.map(note => note.title).sort(), `${result.mode}: display names come from filenames`).toEqual([...titles].sort());
    const byFilename = (name: string) => result.notes.find(note => note.path.split('/').pop() === name)!;
    const first = byFilename('01.准备与实施计划.md');
    const second = byFilename('02-UAV：巡检与路径.MARKDOWN');
    const final = byFilename('10 收尾 · 复盘.md');
    expect(first.content).toMatch(/^# 总体方案（原始正文标题）\n/);
    expect(second.content).toMatch(/^# 路径与频次（原始正文标题）\n/);
    expect(final.content).toMatch(/^# 工作回顾（原始正文标题）\n/);
    expect(first.content).toContain(`[02-UAV：巡检与路径](#note/${second.id})`);
    expect(first.content).toContain(`[自定义跳转](#note/${final.id})`);
    expect(first.content).toContain('[固定引用](#note/unchanged-stable-id)');
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].size).toBeGreaterThan(0);
    expect(first.content).toContain(`![图示.svg](asset:${result.assets[0].id})`);
    expect(first.attachments['图示.svg']).toBe(`asset:${result.assets[0].id}`);
    expect(result.report).toMatchObject({ notes: 4, attachments: 1, resolvedLinks: 3, unresolvedLinks: 0 });
  }
});

test('imported filename titles retain numeric directory order and match the reader and preview tab after reload', async ({ page }) => {
  let importedNotes: Note[] = [];
  await stubApplicationApi(page, () => importedNotes);
  await page.goto('/');
  [importedNotes] = (await parseFixtures(page, ['directory'])).map(result => result.notes);
  const first = importedNotes.find(note => note.path.endsWith('/01.准备与实施计划.md'))!;
  // A new document navigation reloads the stubbed library; changing only the
  // hash would keep the initially empty in-memory application state.
  await page.goto(`/?import-title-fixture=1#note/${first.id}`);
  const reader = page.getByRole('region', { name: '知识库阅读区', exact: true });
  await expect(page.locator('.sidebar .ft-file>span')).toHaveText(titles);
  await expect(reader.locator('.kr-title')).toHaveText(titles[0]);
  await expect(reader.locator('.kr-markdown')).toContainText('总体方案（原始正文标题）');
  await expect(page.getByRole('tab', { name: titles[0], exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '关闭账号窗口', exact: true }).click();
  await expect(page.locator('.sidebar .ft-file>span')).toHaveText(titles);
  await expect(reader.locator('.kr-title')).toHaveText(titles[0]);
  await expect(page.getByRole('tab', { name: titles[0], exact: true })).toBeVisible();
  const second = importedNotes.find(note => note.path.endsWith('/02-UAV：巡检与路径.MARKDOWN'))!;
  await reader.getByRole('link', { name: titles[1], exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#note/${second.id}$`));
  await expect(reader.locator('.kr-title')).toHaveText(titles[1]);
  await expect(reader.locator('.kr-markdown')).toContainText('路径与频次（原始正文标题）');
  await expect(page.getByRole('tab', { name: titles[1], exact: true })).toBeVisible();
});
