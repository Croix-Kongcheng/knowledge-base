import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:5174' });

test.beforeEach(async ({ page }) => {
  // Importer modules run in the browser, with no access to any real account,
  // workspace, note or attachment API.
  await page.route('**/api/**', route => {
    const fixtures: Record<string, unknown> = {
      '/api/session': { user: null, needsAdminSetup: false },
      '/api/notes/index': { notes: [], folders: [], totals: { notes: 0, attachments: 0, contentBytes: 0, attachmentBytes: 0 } },
      '/api/notes': { notes: [] },
      '/api/members': { members: [] },
    };
    const key = new URL(route.request().url()).pathname;
    return route.fulfill({
      status: route.request().method() === 'GET' && key in fixtures ? 200 : 503,
      contentType: 'application/json',
      body: JSON.stringify(fixtures[key] || { error: 'Unexpected isolated parser API request' }),
    });
  });
  await page.goto('/');
});

test('linked imports read only direct notes plus their attachments and ignore deeper notes, code, comments and private links', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/importer.ts';
    const { scanImportFiles, parseImportSource } = await import(modulePath);
    const reads: string[] = [];
    let forbiddenReads = 0;
    const file = (path: string, body: string, forbidden = false, size?: number) => {
      const value = new File([body], path.split('/').pop()!, { type: path.endsWith('.svg') ? 'image/svg+xml' : 'text/plain' });
      Object.defineProperty(value, 'webkitRelativePath', { value: '验收库/' + path });
      const read = value.arrayBuffer.bind(value);
      value.arrayBuffer = async () => {
        reads.push(path);
        if (forbidden) { forbiddenReads++; throw new Error('Unrelated or excluded content must not be read'); }
        return read();
      };
      if (size !== undefined) Object.defineProperty(value, 'size', { value: size });
      return value;
    };
    const tick = String.fromCharCode(96);
    const mainBody = [
      '# 实验入口',
      '[[02.方法|方法说明]]',
      '[带代码标签 ' + tick + '[[代码示例]]' + tick + '](02.方法.md)',
      '[补充资料][补充]',
      '[补充]: <../资料/03.实验%20(修订).md> "资料说明"',
      '![示意图](../附件/图%20(1).svg)',
      '[[02私有资料/不公开|私人别名]]',
      '[官网](https://example.com/外部.md)',
      '[本节](#实验入口)',
      tick + '[[代码示例]]' + tick,
      tick.repeat(3) + 'md\n[[代码示例]]\n' + tick.repeat(3),
      '<!-- [[注释示例]] -->',
    ].join('\n\n');
    const source = await scanImportFiles([
      file('专题/01.入口.md', mainBody),
      file('专题/02.方法.md', '[[../资料/03.实验 (修订)]]\n[回到入口](01.入口.md)\n[[../资料/04.第二层]]\n![[../附件/共享.pdf]]'),
      file('资料/03.实验 (修订).md', '[[../专题/01.入口]]\n[[04.第二层]]\n![[../附件/图 (1).svg]]'),
      file('资料/04.第二层.md', 'SECOND HOP MUST NOT READ\n![[../附件/第二层.pdf]]', true, 11 * 1024 * 1024),
      file('附件/第二层.pdf', 'SECOND HOP ASSET MUST NOT READ', true, 501 * 1024 * 1024),
      file('附件/图 (1).svg', '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"/>'),
      file('附件/共享.pdf', '%PDF-1.4\n isolated attachment'),
      file('无关/不能读.md', 'UNRELATED', true, 11 * 1024 * 1024),
      file('附件/未引用.pdf', 'UNRELATED ASSET', true, 501 * 1024 * 1024),
      file('专题/代码示例.md', 'CODE EXAMPLE TARGET', true),
      file('专题/注释示例.md', 'COMMENT TARGET', true),
      file('02私有资料/不公开.md', 'PRIVATE', true, 900 * 1024 * 1024),
    ]);
    const readsAfterScan = reads.length;
    const sourceJSON = JSON.stringify(source);
    const parsed = await parseImportSource(source, { entryPaths: ['专题/01.入口.md'], includeLinkedNotes: true });
    return {
      notes: parsed.notes, report: parsed.report, warnings: parsed.warnings, reads, readsAfterScan,
      forbiddenReads, sourceJSON,
      assets: parsed.assets.map((asset: { path: string; blob: Blob }) => ({ path: asset.path, size: asset.blob.size })),
    };
  });
  expect(result.readsAfterScan).toBe(0);
  expect(result.forbiddenReads).toBe(0);
  expect(result.notes.map((note: { path: string }) => note.path).sort()).toEqual([
    '专题/01.入口.md', '专题/02.方法.md', '资料/03.实验 (修订).md',
  ].sort());
  expect(result.report).toMatchObject({ notes: 3, attachments: 2, entryNotes: 1, relatedNotes: 2, unresolvedLinks: 0 });
  expect(result.assets.map((asset: { path: string }) => asset.path).sort()).toEqual(['附件/共享.pdf', '附件/图 (1).svg']);
  expect(result.reads.sort()).toEqual(['专题/01.入口.md', '专题/02.方法.md', '资料/03.实验 (修订).md'].sort());
  expect(result.sourceJSON).not.toMatch(/02私有资料|不公开|PRIVATE/);
  const main = result.notes.find((note: { path: string }) => note.path === '专题/01.入口.md')!;
  const method = result.notes.find((note: { path: string }) => note.path === '专题/02.方法.md')!;
  const supplement = result.notes.find((note: { path: string }) => note.path === '资料/03.实验 (修订).md')!;
  expect(main.content).toContain('#note/' + method.id);
  expect(main.content).toContain('[带代码标签 ' + String.fromCharCode(96) + '[[代码示例]]' + String.fromCharCode(96) + '](#note/' + method.id + ')');
  expect(main.content).toContain('#note/' + supplement.id);
  expect(method.content).toContain('#note/' + supplement.id);
  expect(method.content).toContain('[[../资料/04.第二层]]');
  expect(supplement.content).toContain('[[04.第二层]]');
  expect(main.content).toContain('https://example.com/外部.md');
  expect(main.content).toContain('<!-- [[注释示例]] -->');
  expect(main.content).toContain(String.fromCharCode(96) + '[[代码示例]]' + String.fromCharCode(96));
  expect(JSON.stringify({ notes: result.notes, warnings: result.warnings })).not.toMatch(/不公开|私人别名|PRIVATE/);
});

test('explicitly selecting A and B expands each once and deduplicates their direct notes without ambiguous guesses', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/importer.ts';
    const { scanImportFiles, parseImportSource } = await import(modulePath);
    let forbiddenReads = 0;
    const file = (path: string, body: string, forbidden = false) => {
      const value = new File([body], path.split('/').pop()!);
      Object.defineProperty(value, 'webkitRelativePath', { value: '验收库/' + path });
      if (forbidden) value.arrayBuffer = async () => { forbiddenReads++; throw new Error('Ambiguous links must not select this note'); };
      return value;
    };
    const source = await scanImportFiles([
      file('入口.md', '[[同名]]\n[明确甲](甲/同名.md)\n[[乙/同名|明确乙]]'),
      file('甲/同名.md', '[[../共享/实验]]'),
      file('乙/同名.md', '[[../共享/实验]]'),
      file('丙/同名.md', 'MUST NOT IMPORT', true),
      file('共享/实验.md', '[[../入口]]'),
    ]);
    const parsed = await parseImportSource(source, { entryPaths: ['入口.md', '甲/同名.md', '入口.md'], includeLinkedNotes: true });
    return { notes: parsed.notes, report: parsed.report, warnings: parsed.warnings, forbiddenReads };
  });
  expect(result.forbiddenReads).toBe(0);
  expect(result.notes.map((note: { path: string }) => note.path).sort()).toEqual(['入口.md', '甲/同名.md', '乙/同名.md', '共享/实验.md'].sort());
  expect(new Set(result.notes.map((note: { id: string }) => note.id)).size).toBe(4);
  expect(result.report).toMatchObject({ notes: 4, entryNotes: 2, relatedNotes: 2, unresolvedLinks: 1 });
  expect(result.warnings.join('\n')).toContain('同名');
  const main = result.notes.find((note: { path: string }) => note.path === '入口.md')!;
  const first = result.notes.find((note: { path: string }) => note.path === '甲/同名.md')!;
  const second = result.notes.find((note: { path: string }) => note.path === '乙/同名.md')!;
  expect(main.content).toContain('[[同名]]');
  expect(main.content).toContain('#note/' + first.id);
  expect(main.content).toContain('#note/' + second.id);
});

test('ZIP sources leave second-hop and unrelated payloads compressed and enforce selected attachment limits before inflation', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/importer.ts';
    const sourceText = await (await fetch(modulePath)).text();
    const jszipPath = sourceText.match(/from ["']([^"']*\/jszip\.js[^"']*)["']/)![1];
    const { default: JSZip } = await import(jszipPath);
    const { scanImportFiles, parseImportSource, parseImportFiles } = await import(modulePath);
    const zip = new JSZip();
    zip.file('验收库/项目/01.入口.md', '[[02.依赖]]\n![[共享.svg]]');
    zip.file('验收库/项目/02.依赖.md', '[[01.入口]]\n[[03.第二层]]\n![[共享.svg]]');
    zip.file('验收库/项目/03.第二层.md', 'SECOND HOP MUST STAY COMPRESSED\n![[第二层.pdf]]');
    zip.file('验收库/附件/第二层.pdf', 'SECOND HOP ASSET MUST STAY COMPRESSED');
    zip.file('验收库/附件/共享.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    zip.file('验收库/无关/超大.md', 'UNRELATED NOTE');
    zip.file('验收库/附件/超大.pdf', 'UNRELATED ASSET');
    zip.file('验收库/02私有资料/私密.md', 'PRIVATE');
    const input = new File([await zip.generateAsync({ type: 'uint8array' })], '验收库.zip');
    const originalLoad = JSZip.loadAsync;
    let forbiddenInflations = 0;
    let totalInflations = 0;
    let oversizeLinkedAsset = false;
    JSZip.loadAsync = async (...args: unknown[]) => {
      const archive = await originalLoad.apply(JSZip, args);
      for (const entry of Object.values(archive.files) as Array<{ name: string; dir: boolean; async: (...args: unknown[]) => Promise<unknown>; _data?: { uncompressedSize: number } }>) {
        if (entry.dir) continue;
        const inflate = entry.async.bind(entry);
        if (/第二层|超大|02私有资料/.test(entry.name)) {
          entry.async = async () => { forbiddenInflations++; throw new Error('This entry must stay compressed'); };
          if (entry._data) entry._data.uncompressedSize = 900 * 1024 * 1024;
        } else {
          if (oversizeLinkedAsset && entry.name.endsWith('共享.svg') && entry._data) entry._data.uncompressedSize = 501 * 1024 * 1024;
          entry.async = async (...values: unknown[]) => { totalInflations++; return inflate(...values); };
        }
      }
      return archive;
    };
    try {
      const source = await scanImportFiles([input]);
      const inflationsAfterScan = totalInflations;
      const parsed = await parseImportSource(source, { entryPaths: ['项目/01.入口.md'], includeLinkedNotes: true });
      oversizeLinkedAsset = true;
      const largeSource = await scanImportFiles([input]);
      let limitError = '';
      try { await parseImportSource(largeSource, { entryPaths: ['项目/01.入口.md'], includeLinkedNotes: true }); }
      catch (cause) { limitError = cause instanceof Error ? cause.message : String(cause); }
      let legacyLimitError = '';
      try { await parseImportFiles([input]); }
      catch (cause) { legacyLimitError = cause instanceof Error ? cause.message : String(cause); }
      const controller = new AbortController();
      controller.abort();
      let abortName = '';
      try { await parseImportSource(source, { entryPaths: ['项目/01.入口.md'], includeLinkedNotes: true, signal: controller.signal }); }
      catch (cause) { abortName = cause instanceof Error ? cause.name : String(cause); }
      return {
        report: parsed.report, paths: parsed.notes.map((note: { path: string }) => note.path),
        assets: parsed.assets.map((asset: { path: string }) => asset.path),
        forbiddenInflations, inflationsAfterScan, limitError, legacyLimitError, abortName,
      };
    } finally { JSZip.loadAsync = originalLoad; }
  });
  expect(result.inflationsAfterScan).toBe(0);
  expect(result.forbiddenInflations).toBe(0);
  expect(result.report).toMatchObject({ notes: 2, attachments: 1, entryNotes: 1, relatedNotes: 1 });
  expect(result.paths.sort()).toEqual(['项目/01.入口.md', '项目/02.依赖.md']);
  expect(result.assets).toEqual(['附件/共享.svg']);
  expect(result.limitError).toContain('500 MB');
  expect(result.legacyLimitError).toContain('500 MB');
  expect(result.abortName).toBe('AbortError');
});
