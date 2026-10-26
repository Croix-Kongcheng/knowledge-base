import { expect, test } from '@playwright/test';
import { primeWorkspace } from './fixtures/library';

test.use({ baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5174' });

test('a real 221 MiB vault imports, stores its shared attachment once, and keeps images after reload', async ({ page }) => {
  test.setTimeout(240_000);
  await primeWorkspace(page, []);
  await page.locator('.heading-actions').getByRole('button', { name: '导入笔记', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '把你的知识，带到这里', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('500 MB');

  const selectedBytes = await dialog.locator('input[type="file"]').evaluate((element: HTMLInputElement) => {
    const file = (path: string, parts: BlobPart[], type: string) => {
      const value = new File(parts, path.split('/').pop()!, { type });
      Object.defineProperty(value, 'webkitRelativePath', { value: path });
      return value;
    };
    // Blob parts share the same 1 MiB backing chunk. This creates a real large
    // file without also constructing a 221 MiB JavaScript string or ArrayBuffer.
    const chunk = new Uint8Array(1024 * 1024);
    const attachment = file('ExampleVault/附件/共享资料.pdf', ['%PDF-1.7\n', ...Array.from({ length: 221 }, () => chunk), '\n%%EOF'], 'application/pdf');
    const files = [
      file('ExampleVault/04项目/大知识库导入.md', ['# 大知识库导入\n\n![[附件/预览.svg]]\n\n[共享资料](../附件/共享资料.pdf)\n\n[[关联资料]]'], 'text/markdown'),
      file('ExampleVault/04项目/关联资料.md', ['# 关联资料\n\n[同一份共享资料](../附件/共享资料.pdf)'], 'text/markdown'),
      file('ExampleVault/附件/预览.svg', ['<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="purple"/></svg>'], 'image/svg+xml'),
      attachment,
    ];
    const selection = new DataTransfer();
    files.forEach(value => selection.items.add(value));
    element.files = selection.files;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return files.reduce((sum, value) => sum + value.size, 0);
  });
  expect(selectedBytes).toBeGreaterThan(220 * 1024 * 1024);
  const stats = dialog.locator('.im-stats > div');
  await expect(stats.nth(0).locator('strong')).toHaveText('2');
  await expect(stats.nth(1).locator('strong')).toHaveText('2');
  await expect(stats.nth(3).locator('strong')).toHaveText('0');
  await dialog.getByRole('button', { name: '导入 2 篇笔记', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 120_000 });

  const saved = await page.evaluate(() => new Promise<{
    version: number;
    assets: { id: string; path: string; size: number }[];
    notes: { content: string; attachments?: Record<string, string> }[];
  }>((resolve, reject) => {
    const opening = indexedDB.open('zhiyu-knowledge');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction(['workspace', 'assets'], 'readonly');
      const assets = tx.objectStore('assets').getAll();
      const notes = tx.objectStore('workspace').get('notes');
      tx.oncomplete = () => {
        resolve({ version: db.version, assets: assets.result.map((asset: { id: string; path: string; blob: Blob }) => ({ id: asset.id, path: asset.path, size: asset.blob.size })), notes: notes.result });
        db.close();
      };
      tx.onerror = () => reject(tx.error);
    };
  }));
  expect(saved.version).toBe(2);
  expect(saved.assets).toHaveLength(2);
  const shared = saved.assets.filter(asset => asset.path.endsWith('/共享资料.pdf'));
  expect(shared).toHaveLength(1);
  expect(shared[0].size).toBeGreaterThan(220 * 1024 * 1024);
  expect(saved.assets.reduce((sum, asset) => sum + asset.size, 0)).toBeLessThan(selectedBytes);
  expect(saved.notes).toHaveLength(2);
  for (const note of saved.notes) {
    expect(note.content.length).toBeLessThan(1000);
    expect(note.content).toContain(`asset:${shared[0].id}`);
    expect(note.content).not.toContain('data:');
    expect(Object.values(note.attachments || {})).toContain(`asset:${shared[0].id}`);
  }

  await page.reload();
  await page.locator('aside.sidebar').getByRole('button', { name: /^全部文档/ }).click();
  await page.locator('.notes-table tbody tr').filter({ hasText: '大知识库导入' }).click();
  const reader = page.getByRole('region', { name: '知识库阅读区', exact: true });
  const image = reader.getByRole('img', { name: '附件/预览.svg', exact: true });
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => image.evaluate((value: HTMLImageElement) => value.complete && value.naturalWidth === 32)).toBe(true);
  await expect(reader.getByRole('link', { name: '共享资料', exact: true })).toHaveAttribute('href', /^blob:/);
  await expect(reader.getByRole('link', { name: '共享资料', exact: true })).toHaveAttribute('download', '共享资料.pdf');
  await reader.getByRole('link', { name: '关联资料', exact: true }).click();
  await expect(reader.getByRole('heading', { name: '关联资料', level: 1, exact: true })).toBeVisible();
});

test('new size and count limits reject before reads while ignored files and private files do not count', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/importer.ts';
    const { parseImportFiles } = await import(modulePath);
    const limitsPath = '/src/lib/importLimits.ts';
    const { IMPORT_LIMITS } = await import(limitsPath);
    let forbiddenReads = 0;
    const file = (path: string, content = '# 公开', fakeSize?: number) => {
      const value = new File([content], path.split('/').pop()!, { type: 'text/plain' });
      Object.defineProperty(value, 'webkitRelativePath', { value: path });
      if (fakeSize !== undefined) {
        Object.defineProperty(value, 'size', { value: fakeSize });
        value.arrayBuffer = async () => { forbiddenReads += 1; throw new Error('MUST NOT READ'); };
        value.text = async () => { forbiddenReads += 1; throw new Error('MUST NOT READ'); };
      }
      return value;
    };
    const notes = Array.from({ length: 2001 }, (_, index) => file(`ExampleVault/04项目/文档-${index}.md`, `# 文档 ${index}`));
    const progress: { phase: string; completed: number; total: number }[] = [];
    const parsed = await parseImportFiles([
      ...notes,
      file('ExampleVault/02私有资料/私人记录.md', 'PRIVATE', 900 * 1024 * 1024),
      file('ExampleVault/.obsidian/workspace.json', 'CONFIGURATION', 900 * 1024 * 1024),
      file('ExampleVault/附件/不支持的程序.exe', 'UNSUPPORTED', 900 * 1024 * 1024),
    ], { onProgress: (value: { phase: string; completed: number; total: number }) => progress.push({ phase: value.phase, completed: value.completed, total: value.total }) });
    const failure = async (values: File[]) => {
      try { await parseImportFiles(values); return ''; }
      catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
    };
    const totalError = await failure([file('ExampleVault/04项目/公开.md'), file('ExampleVault/附件/超大.pdf', '', 501 * 1024 * 1024)]);
    const noteError = await failure([file('ExampleVault/04项目/超大.md', '', 11 * 1024 * 1024)]);
    const countError = await failure(Array.from({ length: 20001 }, (_, index) => file(`ExampleVault/04项目/文件-${index}.md`, '# 公开', 0)));
    const controller = new AbortController();
    controller.abort();
    let abortName = '';
    try { await parseImportFiles([file('ExampleVault/04项目/取消.md', '', 1)], { signal: controller.signal }); }
    catch (cause) { abortName = cause instanceof Error ? cause.name : String(cause); }
    return { limits: IMPORT_LIMITS, report: parsed.report, progress, forbiddenReads, totalError, noteError, countError, abortName };
  });
  expect(result.limits).toMatchObject({ totalBytes: 500 * 1024 * 1024, files: 20000, noteBytes: 10 * 1024 * 1024 });
  expect(result.report).toMatchObject({ notes: 2001, attachments: 0, excludedFiles: 1 });
  expect(result.forbiddenReads).toBe(0);
  expect(result.progress.some((value: { phase: string }) => value.phase === 'notes')).toBe(true);
  expect(result.progress.some((value: { phase: string }) => value.phase === 'links')).toBe(true);
  expect(result.totalError).toContain('500 MB');
  expect(result.noteError).toContain('10 MB');
  expect(result.countError).toContain('20,000');
  expect(result.abortName).toBe('AbortError');
});

test('ZIP import skips ignored and unreferenced payloads and checks expanded size before inflation', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const importerPath = '/src/lib/importer.ts';
    const importerSource = await (await fetch(importerPath)).text();
    const jszipPath = importerSource.match(/from ["']([^"']*\/jszip\.js[^"']*)["']/)![1];
    const { default: JSZip } = await import(jszipPath);
    const { parseImportFiles } = await import(importerPath);
    const archive = new JSZip();
    archive.file('ExampleVault/04项目/公开.md', '# 公开\n![[图片.svg]]');
    archive.file('ExampleVault/附件/图片.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    archive.file('ExampleVault/附件/未引用.pdf', 'NOT REFERENCED');
    archive.file('ExampleVault/02私有资料/私人.md', 'PRIVATE');
    archive.file('ExampleVault/.obsidian/workspace.json', 'IGNORED CONFIGURATION');
    archive.file('ExampleVault/附件/不支持.exe', 'UNSUPPORTED');
    const content = await archive.generateAsync({ type: 'uint8array' });
    const originalLoad = JSZip.loadAsync;
    let forbiddenInflations = 0;
    let supportedInflations = 0;
    let oversize = false;
    JSZip.loadAsync = async (...args: unknown[]) => {
      const zip = await originalLoad.apply(JSZip, args);
      for (const entry of Object.values(zip.files) as Array<{ dir: boolean; name: string; async: (...args: unknown[]) => Promise<unknown>; _data?: { uncompressedSize: number } }>) {
        if (entry.dir) continue;
        const inflate = entry.async.bind(entry);
        if (/02私有资料|\.obsidian|不支持\.exe|未引用\.pdf/.test(entry.name)) {
          entry.async = async () => { forbiddenInflations += 1; throw new Error('MUST NOT INFLATE'); };
          if (entry._data) entry._data.uncompressedSize = /未引用/.test(entry.name) ? (oversize ? 501 : 300) * 1024 * 1024 : 900 * 1024 * 1024;
        } else {
          entry.async = async (...values: unknown[]) => { supportedInflations += 1; return inflate(...values); };
        }
      }
      return zip;
    };
    try {
      const parsed = await parseImportFiles([new File([content], 'ExampleVault.zip')]);
      const firstInflations = supportedInflations;
      oversize = true;
      let error = '';
      try { await parseImportFiles([new File([content], 'ExampleVault.zip')]); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      return { report: parsed.report, assetCount: parsed.assets?.length, firstInflations, supportedInflations, forbiddenInflations, error };
    } finally { JSZip.loadAsync = originalLoad; }
  });
  expect(result.report).toMatchObject({ notes: 1, attachments: 1, excludedFiles: 1 });
  expect(result.assetCount).toBe(1);
  expect(result.firstInflations).toBe(2);
  expect(result.supportedInflations).toBe(result.firstInflations);
  expect(result.forbiddenInflations).toBe(0);
  expect(result.error).toContain('500 MB');
});

test('version 1 browser data upgrades without losing legacy inline images', async ({ page }) => {
  await page.route('**/__legacy_storage_setup__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Legacy data</title>' }));
  await page.goto('/__legacy_storage_setup__');
  await page.evaluate(async () => {
    const image = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="purple"/></svg>')}`;
    const note = { id: 'retained-legacy-image', title: '旧版图片文档', path: '04项目/旧版图片文档.md', category: '04项目', content: `# 旧版图片文档\n\n![旧版图片](${image})`, attachments: { '旧版图片.svg': image }, tags: [], updatedAt: '2026-10-25T10:00:00', author: '我', avatar: '我', color: 'purple' };
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open('zhiyu-knowledge', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('workspace');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction('workspace', 'readwrite');
        tx.objectStore('workspace').put([note], 'notes');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.goto('/');
  await page.locator('aside.sidebar').getByRole('button', { name: /^全部文档/ }).click();
  await page.locator('.notes-table tbody tr').filter({ hasText: '旧版图片文档' }).click();
  const reader = page.getByRole('region', { name: '知识库阅读区', exact: true });
  const image = reader.getByRole('img', { name: '旧版图片', exact: true });
  await expect(image).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/);
  await expect.poll(() => image.evaluate((value: HTMLImageElement) => value.complete && value.naturalWidth === 12)).toBe(true);
  expect(await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const opening = indexedDB.open('zhiyu-knowledge');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => { resolve(opening.result.version); opening.result.close(); };
  }))).toBe(2);
});

test('insufficient browser capacity keeps the import preview open and allows a clean retry', async ({ page }) => {
  await primeWorkspace(page, []);
  await page.locator('.heading-actions').getByRole('button', { name: '导入笔记', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '把你的知识，带到这里', exact: true });
  await dialog.locator('input[type="file"]').evaluate((element: HTMLInputElement) => {
    const selection = new DataTransfer();
    for (const [path, content] of [
      ['ExampleVault/04项目/容量检查.md', '# 容量检查\n\n![[图片.svg]]'],
      ['ExampleVault/附件/图片.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'],
    ]) {
      const value = new File([content], path.split('/').pop()!);
      Object.defineProperty(value, 'webkitRelativePath', { value: path });
      selection.items.add(value);
    }
    Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: async () => ({ quota: 1, usage: 0 }) });
    element.files = selection.files;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await dialog.getByRole('button', { name: '导入 1 篇笔记', exact: true }).click();
  await expect(dialog.locator('.im-error')).toContainText('浏览器剩余存储空间不足');
  await expect(dialog).toBeVisible();
  const empty = await page.evaluate(() => new Promise<{ notes: number; assets: number }>((resolve, reject) => {
    const opening = indexedDB.open('zhiyu-knowledge');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction(['workspace', 'assets'], 'readonly');
      const assets = tx.objectStore('assets').count();
      const notes = tx.objectStore('workspace').get('notes');
      tx.oncomplete = () => { resolve({ notes: (notes.result || []).length, assets: assets.result }); db.close(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  expect(empty).toEqual({ notes: 0, assets: 0 });
  await page.evaluate(() => { Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: async () => ({ quota: 1024 * 1024 * 1024, usage: 0 }) }); });
  await dialog.getByRole('button', { name: '导入 1 篇笔记', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: '知识库统计' }).locator('.metric-value')).toHaveText(['1篇', '1个', '1个', '1人']);
});
