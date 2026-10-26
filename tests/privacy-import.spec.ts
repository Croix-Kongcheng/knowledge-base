import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:5174' });

test.beforeEach(async ({ page }) => {
  // These tests exercise the importer module through Vite. Keep all application
  // API traffic inside the browser fixture instead of contacting a real DB.
  await page.route('**/api/**', route => {
    const routePath = new URL(route.request().url()).pathname;
    const fixtures: Record<string, unknown> = {
      '/api/session': { user: null, needsAdminSetup: false },
      '/api/notes': { notes: [] },
      '/api/notes/index': { notes: [], totals: { notes: 0, attachments: 0, contentBytes: 0, attachmentBytes: 0 } },
      '/api/members': { members: [] },
      '/api/storage': { availableBytes: 1024 * 1024 * 1024 },
    };
    return route.fulfill({
      status: route.request().method() === 'GET' && routePath in fixtures ? 200 : 503,
      contentType: 'application/json',
      body: JSON.stringify(fixtures[routePath] || { error: 'Unexpected API request in isolated importer test' }),
    });
  });
});

test('directory import omits private content before reads and preserves permitted paths, images and links', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/importer.ts';
    const { parseImportFiles } = await import(modulePath);
    let privateReads = 0;
    const file = (path: string, content: string, privateFile = false) => {
      const value = new File([content], path.split('/').pop()!, { type: 'text/plain' });
      Object.defineProperty(value, 'webkitRelativePath', { value: path });
      if (privateFile) {
        Object.defineProperty(value, 'size', { value: 80 * 1024 * 1024 });
        value.arrayBuffer = async () => { privateReads += 1; throw new Error('PRIVATE CONTENT MUST NOT BE READ'); };
      }
      return value;
    };
    const parsed = await parseImportFiles([
      file('ExampleVault/04项目/无人机/示例.md', '---\ncategory: 旧分类\n---\n# 示例\n[[关联笔记]]\n![[图片.svg]]\n[[secret-medical-name]]\n[[02 私有资料/secret-finance.md|私人标题]]'),
      file('ExampleVault/04项目/无人机/关联笔记.md', '# 关联笔记\n公开内容'),
      file('ExampleVault/附件/图片.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
      file('ExampleVault/02私有资料/secret-medical-name.md', 'PRIVATE MEDICAL CONTENT', true),
      file('ExampleVault/02 私有资料/secret-finance.md', 'PRIVATE FINANCE CONTENT', true),
    ]);
    let privateOnlyError = '';
    try { await parseImportFiles([file('ExampleVault/02私有资料/secret-only-name.md', 'PRIVATE ONLY CONTENT', true)]); }
    catch (cause) { privateOnlyError = cause instanceof Error ? cause.message : String(cause); }
    return { parsed: { ...parsed, assets: parsed.assets?.map((asset: { id: string; path: string; blob: Blob }) => ({ id: asset.id, path: asset.path, size: asset.blob.size })) }, privateReads, privateOnlyError };
  });

  expect(result.privateReads).toBe(0);
  expect(result.privateOnlyError).toContain('所选文件中没有可导入的 Markdown 笔记');
  expect(result.privateOnlyError).not.toMatch(/secret-only-name|PRIVATE ONLY CONTENT/);
  expect(result.parsed.report).toMatchObject({ notes: 2, attachments: 1, resolvedLinks: 2, unresolvedLinks: 0, excludedFiles: 2 });
  const main = result.parsed.notes.find((note: { title: string }) => note.title === '示例');
  expect(main).toMatchObject({ category: '04项目', path: '04项目/无人机/示例.md' });
  expect(main.content).toContain('](#note/');
  expect(main.content).toContain('asset:');
  expect(main.content).not.toContain('data:');
  expect(result.parsed.assets).toHaveLength(1);
  expect(result.parsed.assets?.[0].size).toBeGreaterThan(0);
  expect(main.content.match(/此内容不可用/g)).toHaveLength(2);
  const shared = JSON.stringify(result.parsed);
  for (const privateText of ['secret-medical-name', 'secret-finance', 'PRIVATE MEDICAL CONTENT', 'PRIVATE FINANCE CONTENT', '私人标题']) {
    expect(shared).not.toContain(privateText);
  }
});

test('ZIP import excludes private members before inflation and before expanded size checks', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const importerPath = '/src/lib/importer.ts';
    const importerSource = await (await fetch(importerPath)).text();
    const jszipPath = importerSource.match(/from ["']([^"']*\/jszip\.js[^"']*)["']/)![1];
    const { default: JSZip } = await import(jszipPath);
    const { parseImportFiles } = await import(importerPath);
    const archive = new JSZip();
    archive.file('ExampleVault/04项目/公开.md', '# 公开\n[[secret-medical-name]]\n![[02_私有资料/私人图片.png]]\n![[附件/公开.svg]]');
    archive.file('ExampleVault/04项目/其他.md', '# 其他');
    archive.file('ExampleVault/附件/公开.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    archive.file('ExampleVault/02私有资料/secret-medical-name.md', 'PRIVATE NOTE');
    archive.file('ExampleVault/02_私有资料/私人图片.png', 'PRIVATE IMAGE');
    const content = await archive.generateAsync({ type: 'uint8array' });
    const originalLoad = JSZip.loadAsync;
    let privateInflations = 0;
    JSZip.loadAsync = async (...args: unknown[]) => {
      const zip = await originalLoad.apply(JSZip, args);
      for (const entry of Object.values(zip.files) as Array<{ dir: boolean; name: string; async: () => Promise<unknown>; _data?: { uncompressedSize: number } }>) {
        if (!entry.dir && /02[ _]?私有资料/.test(entry.name)) {
          entry.async = async () => { privateInflations += 1; throw new Error('PRIVATE ENTRY MUST NOT BE INFLATED'); };
          if (entry._data) entry._data.uncompressedSize = 80 * 1024 * 1024;
        }
      }
      return zip;
    };
    try {
      const parsed = await parseImportFiles([new File([content], 'ExampleVault.zip')]);
      return { parsed: { ...parsed, assets: parsed.assets?.map((asset: { id: string; path: string; blob: Blob }) => ({ id: asset.id, path: asset.path, size: asset.blob.size })) }, privateInflations };
    } finally {
      JSZip.loadAsync = originalLoad;
    }
  });
  expect(result.privateInflations).toBe(0);
  expect(result.parsed.report).toMatchObject({ notes: 2, attachments: 1, unresolvedLinks: 0, excludedFiles: 2 });
  expect(JSON.stringify(result.parsed)).not.toMatch(/secret-medical-name|私人图片|PRIVATE NOTE|PRIVATE IMAGE/);
});

test('private Windows and encoded paths are matched, while manual classification keeps colliding files and IDs', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const privacyPath = '/src/lib/privacy.ts';
    const importerPath = '/src/lib/importer.ts';
    const { isExcludedPath } = await import(privacyPath);
    const { assignImportedCategory } = await import(importerPath);
    const matches = [
      'F:\\ExampleWorkspace\\ExampleVault\\02私有资料\\file.md',
      'ExampleVault/02 私有资料/file.md',
      'ExampleVault/02_私有资料/file.md',
      `ExampleVault/${encodeURIComponent('02私有资料')}/file.md`,
    ].map(isExcludedPath);
    const base = { title: '示例', content: '[关联](#note/second)', category: '旧分类', tags: [], updatedAt: '', author: '我', avatar: '我', color: 'purple' };
    return {
      matches,
      publicMatch: isExcludedPath('ExampleVault/02私有资料备份/file.md'),
      notes: assignImportedCategory([
        { ...base, id: 'first', path: '04项目/无人机/示例.md' },
        { ...base, id: 'second', path: '03学习/示例.md' },
      ], '04项目'),
    };
  });
  expect(result.matches).toEqual([true, true, true, true]);
  expect(result.publicMatch).toBe(false);
  expect(result.notes.map((note: { path: string }) => note.path)).toEqual(['04项目/示例.md', '04项目/示例 (2).md']);
  expect(result.notes.map((note: { id: string }) => note.id)).toEqual(['first', 'second']);
  expect(result.notes[0].content).toContain('#note/second');
});
