import JSZip from 'jszip';
import { isExcludedPath } from './privacy';
import { IMPORT_LIMITS } from './importLimits';
import { collectImportLinks, type ImportLink } from './importLinks';

export interface ImportedNote {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  updatedAt: string;
  author: string;
  avatar: string;
  color: string;
  path?: string;
  attachments?: Record<string, string>;
  /** Stored once per stable asset reference, regardless of its Markdown aliases. */
  attachmentSizes?: Record<string, number>;
  ownerId?: string;
  ownerEmail?: string;
  ownerAvatarUrl?: string;
  collaborative?: boolean;
  revision?: number;
  /** Lightweight server directory metadata; content is fetched only when opened. */
  contentBytes?: number;
  attachmentCount?: number;
  attachmentBytes?: number;
  excerpt?: string;
}

export interface ImportedAsset {
  id: string;
  path: string;
  blob: Blob;
}

export interface ImportProgress {
  phase: 'scan' | 'notes' | 'attachments' | 'links';
  completed: number;
  total: number;
  label?: string;
}

export interface ImportReport {
  notes: number;
  attachments: number;
  resolvedLinks: number;
  unresolvedLinks: number;
  excludedFiles?: number;
  excludedFolders?: string[];
  entryNotes?: number;
  relatedNotes?: number;
}

export interface ImportResult {
  notes: ImportedNote[];
  report: ImportReport;
  warnings: string[];
  assets?: ImportedAsset[];
}

export interface ImportOptions {
  /** Empty or “auto” keeps the vault's folder / frontmatter categories. */
  category?: string;
  author?: string;
  onProgress?: (progress: ImportProgress) => void;
  signal?: AbortSignal;
}

export interface ImportSourceNote {
  path: string;
  title: string;
  size: number;
}

/** Public scan results contain only eligible note names, never private entries. */
export interface ImportSource {
  notes: ImportSourceNote[];
}

const NOTE_EXTENSION = /\.(md|markdown)$/i;
const IGNORED_PATH = /(^|\/)(\.obsidian|\.git|__MACOSX|\.trash)(\/|$)|(^|\/)\.[^/]+$/i;
const ATTACHMENT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
  ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', json: 'application/json', drawio: 'application/vnd.jgraph.mxfile',
  excalidraw: 'application/json',
};

interface VaultFile {
  path: string;
  size: number;
  modifiedAt: string;
  /** Folder Files stay lazy; ZIP attachments inflate only when a note uses them. */
  read: () => Promise<Blob>;
}

const extension = (path: string) => path.split('.').pop()?.toLowerCase() || '';
const basename = (path: string) => path.split('/').pop() || path;
const dirname = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/').normalize('NFC');
}

/** Use this before reading files, counting them, or traversing a dropped vault. */
export function isSupportedImportPath(path: string): boolean {
  if (isExcludedPath(path)) return false;
  // Inspect the original path too: resolving `..` must not turn a file from an
  // ignored configuration directory into an apparently public attachment.
  if (IGNORED_PATH.test(path.replace(/\\/g, '/'))) return false;
  const normalized = normalizePath(path);
  return !IGNORED_PATH.test(normalized) && (NOTE_EXTENSION.test(normalized) || !!ATTACHMENT_TYPES[extension(normalized)]);
}

function stripVaultFolder(files: VaultFile[], wrapper?: string): VaultFile[] {
  if (!files.length) return files;
  return wrapper ? files.map((file) => ({ ...file, path: file.path.startsWith(`${wrapper}/`) ? file.path.slice(wrapper.length + 1) : file.path })) : files;
}

function uid(): string {
  return globalThis.crypto?.randomUUID?.() || `note-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').trim();
}

function readFrontmatter(text: string): { body: string; title?: string; category?: string; tags: string[] } {
  const match = text.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return { body: text.replace(/^\uFEFF/, ''), tags: [] };
  const metadata = match[1];
  const title = metadata.match(/^title:\s*(.+)$/m)?.[1];
  const category = metadata.match(/^(?:category|分类):\s*(.+)$/m)?.[1];
  const tags: string[] = [];
  const inlineTags = metadata.match(/^(?:tags|标签):\s*(.+)$/m)?.[1];
  if (inlineTags) {
    tags.push(...inlineTags.replace(/^\[|\]$/g, '').split(/[,，]/).map(unquote).filter(Boolean));
  }
  const tagBlock = metadata.match(/^(?:tags|标签):\s*\r?\n((?:[ \t]+-[^\n]*(?:\n|$))+)/m)?.[1];
  if (tagBlock) tags.push(...tagBlock.split('\n').map((line) => unquote(line.replace(/^\s*-\s*/, ''))).filter(Boolean));
  return {
    body: text.slice(match[0].length),
    title: title ? unquote(title) : undefined,
    category: category ? unquote(category) : undefined,
    tags,
  };
}

function decodeTarget(target: string): string {
  try { return decodeURIComponent(target); } catch { return target; }
}

function escapeLabel(text: string): string {
  return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

/** Move notes into a chosen folder without losing colliding source filenames. */
export function assignImportedCategory(notes: ImportedNote[], category: string): ImportedNote[] {
  const folder = normalizePath(category.trim()) || '未分类';
  if (isExcludedPath(folder)) throw new Error('此目录不可用于知识库分类，请选择其他目录。');
  const used = new Set<string>();
  return notes.map((note) => {
    const name = basename(note.path || `${note.title}.md`);
    const suffix = name.match(/\.[^.]+$/)?.[0] || '.md';
    const stem = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
    let path = `${folder}/${name}`;
    let number = 2;
    while (used.has(path.toLocaleLowerCase())) path = `${folder}/${stem} (${number++})${suffix}`;
    used.add(path.toLocaleLowerCase());
    return { ...note, category: folder.split('/')[0], path };
  });
}

interface SourceState {
  files: VaultFile[];
  excludedFiles: number;
  excludedNames: Set<string>;
  warnings: string[];
  noteIds: Map<string, string>;
  assetIds: Map<string, string>;
}

// Keep lazy readers and excluded names out of JSON/debug/UI representations.
const sourceStates = new WeakMap<ImportSource, SourceState>();
const SOURCE_ENTRY_LIMIT = 250_000;
const SOURCE_ZIP_BYTES = 2 * 1024 ** 3;
const pathKey = (value: string) => normalizePath(value).toLocaleLowerCase();

function importControl(options: ImportOptions) {
  const checkAbort = () => {
    if (options.signal?.aborted) throw new DOMException('已取消导入。', 'AbortError');
  };
  const progress = async (phase: ImportProgress['phase'], completed: number, total: number, yieldEvery = 100) => {
    checkAbort();
    if (completed === 0 || completed === total || completed % yieldEvery === 0) {
      options.onProgress?.({ phase, completed, total });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      checkAbort();
    }
  };
  return { checkAbort, progress };
}

function checkImportBudget(files: VaultFile[]) {
  if (files.length > IMPORT_LIMITS.files) throw new Error(`一次最多导入 ${IMPORT_LIMITS.filesLabel} 个笔记和附件，请按目录分批导入。`);
  if (files.reduce((sum, file) => sum + file.size, 0) > IMPORT_LIMITS.totalBytes) {
    throw new Error(`笔记和附件的总大小超过 ${IMPORT_LIMITS.totalLabel}，请按目录分批导入。`);
  }
  const large = files.find(file => NOTE_EXTENSION.test(file.path) && file.size > IMPORT_LIMITS.noteBytes);
  if (large) throw new Error(`「${basename(large.path)}」超过单篇笔记 ${IMPORT_LIMITS.noteLabel} 限制，请拆分后导入。`);
}

/** Scan names and sizes; Markdown bodies and ZIP members stay entirely lazy. */
export async function scanImportFiles(input: File[], options: ImportOptions = {}): Promise<ImportSource> {
  if (!input.length) throw new Error('请先选择要导入的 ZIP、文件夹或 Markdown 文件。');
  const { checkAbort, progress } = importControl(options);
  const inputPath = (file: File) => file.webkitRelativePath || file.name;
  const isArchive = (file: File) => /\.zip$/i.test(file.name) && !file.webkitRelativePath;
  const files: VaultFile[] = [];
  const warnings: string[] = [];
  const excludedNames = new Set<string>();
  let excludedFiles = 0;
  let scannedEntries = 0;
  const countEntry = () => {
    if (++scannedEntries > SOURCE_ENTRY_LIMIT) throw new Error('来源文件数量超过 250,000 个，请选择较小的知识库来源。');
  };
  const exclude = (value: string) => {
    if (!isExcludedPath(value)) return false;
    excludedFiles++;
    excludedNames.add(pathKey(basename(normalizePath(decodeTarget(value)))));
    return true;
  };
  checkAbort();
  await progress('scan', 0, input.length);
  const directoryFiles: VaultFile[] = [];
  const directoryPaths = input.filter(file => !isArchive(file)).map(inputPath).map(normalizePath);
  const directoryRoot = directoryPaths[0]?.split('/')[0];
  const directoryWrapper = input.every(file => !!file.webkitRelativePath) && directoryRoot
    && directoryPaths.every(value => value.startsWith(`${directoryRoot}/`)) ? directoryRoot : undefined;
  for (let inputIndex = 0; inputIndex < input.length; inputIndex++) {
    checkAbort();
    const file = input[inputIndex];
    const originalPath = inputPath(file);
    countEntry();
    if (exclude(originalPath)) { await progress('scan', inputIndex + 1, input.length, 500); continue; }
    if (isArchive(file)) {
      if (IGNORED_PATH.test(normalizePath(originalPath))) continue;
      if (file.size > SOURCE_ZIP_BYTES) throw new Error('来源 ZIP 超过 2 GB，请选择知识库文件夹或拆分压缩包。');
      let zip: JSZip;
      try { zip = await JSZip.loadAsync(file); }
      catch { checkAbort(); throw new Error(`无法打开「${file.name}」。请确认它是未加密、未损坏的 ZIP 文件。`); }
      checkAbort();
      const entries = Object.values(zip.files);
      if (scannedEntries + entries.length > SOURCE_ENTRY_LIMIT) throw new Error('来源文件数量超过 250,000 个，请选择较小的知识库来源。');
      const archiveFiles: VaultFile[] = [];
      const memberPaths = entries.filter(entry => !entry.dir).map(entry => normalizePath(entry.name));
      const root = memberPaths[0]?.split('/')[0];
      // A common real category is not automatically a vault wrapper. ZIP names
      // or an Obsidian configuration directory provide explicit root evidence.
      const archiveStem = basename(file.name).replace(/\.zip$/i, '').normalize('NFC');
      const wrapper = root && memberPaths.every(value => value.startsWith(`${root}/`))
        && (root.toLocaleLowerCase() === archiveStem.toLocaleLowerCase()
          || entries.some(entry => normalizePath(entry.name).startsWith(`${root}/.obsidian/`))) ? root : undefined;
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
        checkAbort();
        countEntry();
        const entry = entries[entryIndex];
        if (!entry.dir) {
          const originalName = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName || entry.name;
          if (!exclude(originalName) && (originalName === entry.name || !exclude(entry.name))
            && isSupportedImportPath(originalName) && isSupportedImportPath(entry.name)) {
            const metadata = entry as typeof entry & { _data?: { uncompressedSize?: number } };
            const size = metadata._data?.uncompressedSize ?? 0;
            archiveFiles.push({ path: normalizePath(entry.name), size: Number.isFinite(size) && size >= 0 ? size : 0,
              modifiedAt: entry.date.toISOString(), read: async () => {
                try { return await entry.async('blob'); }
                catch { throw new Error('无法解压选中的文件，请重新压缩知识库后重试。'); }
              } });
          }
        }
        await progress('scan', entryIndex + 1, entries.length, 500);
      }
      for (const archiveFile of stripVaultFolder(archiveFiles, wrapper)) files.push(archiveFile);
    } else if (isSupportedImportPath(originalPath)) {
      directoryFiles.push({ path: normalizePath(originalPath), size: file.size,
        modifiedAt: new Date(file.lastModified || Date.now()).toISOString(), read: async () => file });
    }
    await progress('scan', inputIndex + 1, input.length, 500);
  }
  for (const directoryFile of stripVaultFolder(directoryFiles, directoryWrapper)) files.push(directoryFile);
  const seen = new Set<string>();
  const unique = files.filter(file => {
    const key = pathKey(file.path);
    if (seen.has(key)) { warnings.push(`重复路径「${file.path}」已跳过，请分别导入同名知识库。`); return false; }
    seen.add(key); return true;
  });
  const source: ImportSource = { notes: unique.filter(file => NOTE_EXTENSION.test(file.path))
    .map(file => ({ path: file.path, title: basename(file.path).replace(NOTE_EXTENSION, ''), size: file.size })) };
  if (!source.notes.length) throw new Error(excludedFiles
    ? '所选文件中没有可导入的 Markdown 笔记，请选择其他知识库目录。'
    : '没有找到 Markdown 笔记。请选择包含 .md 文件的文件夹或 ZIP。');
  sourceStates.set(source, { files: unique, excludedFiles, excludedNames, warnings, noteIds: new Map(), assetIds: new Map() });
  return source;
}

interface LinkResolution { path?: string; private?: boolean; ambiguous?: boolean; target: string }
interface SourceEdit { start: number; end: number; value: string }

/** Import selected entry notes and, optionally, one level of outgoing note links. */
export async function parseImportSource(source: ImportSource,
  options: ImportOptions & { entryPaths?: string[]; includeLinkedNotes?: boolean } = {}): Promise<ImportResult> {
  const state = sourceStates.get(source);
  if (!state) throw new Error('导入来源已失效，请重新选择文件。');
  const { checkAbort, progress } = importControl(options);
  checkAbort();
  const allFiles = new Map(state.files.map(file => [pathKey(file.path), file]));
  const byBasename = new Map<string, VaultFile[]>();
  for (const file of state.files) {
    const key = pathKey(basename(file.path));
    const matches = byBasename.get(key);
    if (matches) matches.push(file);
    else byBasename.set(key, [file]);
  }
  const resolve = (raw: string, fromPath: string): LinkResolution => {
    const target = raw.trim().replace(/^<|>$/g, '').split('#')[0].split('?')[0].trim();
    if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return { target: '' };
    const decoded = decodeTarget(target).replace(/\\/g, '/');
    if (isExcludedPath(target) || isExcludedPath(`${dirname(fromPath)}/${decoded}`)) return { target, private: true };
    const clean = normalizePath(decoded);
    const relative = decoded.startsWith('/') ? clean : normalizePath(`${dirname(fromPath)}/${decoded}`);
    const extensionless = !NOTE_EXTENSION.test(clean) && !ATTACHMENT_TYPES[extension(clean)];
    // Full relative paths take precedence over vault-root paths and then unique
    // basename fallback. Obsidian links may omit .md or .markdown.
    const variants = (value: string) => [value, ...(extensionless ? [`${value}.md`, `${value}.markdown`] : [])];
    for (const candidate of [...variants(relative), ...variants(clean)]) {
      const found = allFiles.get(pathKey(candidate));
      if (found) return { target, path: found.path };
    }
    const possibleNames = variants(basename(clean));
    let match: VaultFile | undefined;
    for (const name of possibleNames) for (const file of byBasename.get(pathKey(name)) || []) {
      if (match && pathKey(match.path) !== pathKey(file.path)) return { target, ambiguous: true };
      match = file;
    }
    if (match) return { target, path: match.path };
    if (possibleNames.some(name => state.excludedNames.has(pathKey(name)))) return { target, private: true };
    return { target };
  };
  const entries = options.entryPaths === undefined ? source.notes.map(note => note.path) : options.entryPaths;
  if (!entries.length) throw new Error('请至少选择一篇入口笔记。');
  const entryFiles: VaultFile[] = [];
  const entryKeys = new Set<string>();
  for (const value of entries) {
    if (isExcludedPath(value)) continue;
    const file = allFiles.get(pathKey(value));
    if (!file || !NOTE_EXTENSION.test(file.path)) throw new Error('选中的入口笔记已不在来源中，请重新选择。');
    const key = pathKey(file.path);
    if (!entryKeys.has(key)) { entryKeys.add(key); entryFiles.push(file); }
  }
  if (!entryFiles.length) throw new Error('请至少选择一篇可导入的入口笔记。');
  const report: ImportReport = { notes: 0, attachments: 0, resolvedLinks: 0, unresolvedLinks: 0,
    excludedFiles: state.excludedFiles, entryNotes: entryFiles.length, relatedNotes: 0 };
  const warnings = [...state.warnings];
  const missing = new Set<string>();
  const selected = new Map<string, VaultFile>();
  let totalBytes = 0;
  const reserve = (file: VaultFile) => {
    const key = pathKey(file.path);
    if (selected.has(key)) return;
    selected.set(key, file);
    totalBytes += file.size;
    if (selected.size > IMPORT_LIMITS.files) throw new Error(`一次最多导入 ${IMPORT_LIMITS.filesLabel} 个笔记和附件，请减少入口笔记或按目录分批导入。`);
    if (totalBytes > IMPORT_LIMITS.totalBytes) throw new Error(`笔记和附件的总大小超过 ${IMPORT_LIMITS.totalLabel}，请减少入口笔记或按目录分批导入。`);
    if (NOTE_EXTENSION.test(file.path) && file.size > IMPORT_LIMITS.noteBytes) throw new Error(`「${basename(file.path)}」超过单篇笔记 ${IMPORT_LIMITS.noteLabel} 限制，请拆分后导入。`);
  };
  const readBlob = async (file: VaultFile) => {
    reserve(file);
    checkAbort();
    const value = await file.read();
    checkAbort();
    totalBytes += value.size - file.size;
    file.size = value.size;
    if (totalBytes > IMPORT_LIMITS.totalBytes) throw new Error(`笔记和附件的总大小超过 ${IMPORT_LIMITS.totalLabel}，请按目录分批导入。`);
    if (NOTE_EXTENSION.test(file.path) && value.size > IMPORT_LIMITS.noteBytes) throw new Error(`「${basename(file.path)}」超过单篇笔记 ${IMPORT_LIMITS.noteLabel} 限制，请拆分后导入。`);
    const mime = ATTACHMENT_TYPES[extension(file.path)];
    return mime && value.type !== mime ? value.slice(0, value.size, mime) : value;
  };
  const idFor = (path: string, ids: Map<string, string>) => {
    const key = pathKey(path);
    let id = ids.get(key);
    if (!id) { id = uid(); ids.set(key, id); }
    return id;
  };
  const queue = [...entryFiles];
  const queued = new Set(queue.map(file => pathKey(file.path)));
  for (const file of queue) reserve(file);
  const notes: ImportedNote[] = [];
  const linksByPath = new Map<string, { link: ImportLink; resolved: LinkResolution }[]>();
  await progress('notes', 0, queue.length);
  for (let index = 0; index < queue.length; index++) {
    checkAbort();
    const file = queue[index];
    const blob = await readBlob(file);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer()); }
    catch { throw new Error(`「${basename(file.path)}」不是 UTF-8 文本。请在 Obsidian 中重新保存后导入。`); }
    const frontmatter = readFrontmatter(text);
    const links = collectImportLinks(frontmatter.body).map(link => ({ link, resolved: resolve(link.target, file.path) }));
    linksByPath.set(pathKey(file.path), links);
    for (const { resolved } of links) {
      if (!resolved.path) continue;
      const related = allFiles.get(pathKey(resolved.path))!;
      if (NOTE_EXTENSION.test(related.path)) {
        // Only explicitly selected entries expand the note set. Related notes
        // are still parsed for their own attachments, never for another hop.
        if (options.includeLinkedNotes && entryKeys.has(pathKey(file.path)) && !queued.has(pathKey(related.path))) {
          reserve(related); queue.push(related); queued.add(pathKey(related.path));
        }
      } else reserve(related);
    }
    const inlineTags = [...frontmatter.body.matchAll(/(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu)].map(match => match[1]);
    notes.push({ id: idFor(file.path, state.noteIds), title: basename(file.path).replace(NOTE_EXTENSION, ''),
      content: frontmatter.body, category: dirname(file.path).split('/').filter(Boolean)[0] || frontmatter.category || '未分类',
      tags: [...new Set([...frontmatter.tags, ...inlineTags])].slice(0, 8), updatedAt: file.modifiedAt,
      author: options.author || '我', avatar: (options.author || '我').slice(0, 1),
      color: ['purple', 'blue', 'green', 'orange'][notesColor(file.path)], path: file.path, attachments: {}, attachmentSizes: {} });
    await progress('notes', index + 1, queue.length, 20);
  }
  const notesByPath = new Map(notes.map(note => [pathKey(note.path!), note]));
  const assetsByPath = new Map<string, { id: string; reference: string; file: VaultFile }>();
  await progress('links', 0, notes.length);
  for (const [index, note] of notes.entries()) {
    const edits: SourceEdit[] = [];
    for (const { link, resolved } of linksByPath.get(pathKey(note.path!)) || []) {
      if (!resolved.target) continue;
      if (resolved.private) {
        edits.push({ start: link.start, end: link.end, value: '（此内容不可用）' });
        if (link.definition) edits.push({ ...link.definition, value: '' });
        continue;
      }
      const linked = resolved.path && notesByPath.get(pathKey(resolved.path));
      const attachment = resolved.path && allFiles.get(pathKey(resolved.path));
      // A second-hop note is deliberately outside this import, not a missing
      // file. Keep its original link and do not ask users to import it anyway.
      if (!linked && attachment && NOTE_EXTENSION.test(attachment.path)
        && options.includeLinkedNotes && !entryKeys.has(pathKey(note.path!))) continue;
      if (!resolved.path || (!linked && attachment && NOTE_EXTENSION.test(attachment.path))) {
        report.unresolvedLinks++;
        missing.add(resolved.ambiguous
          ? `「${note.title}」中的「${resolved.target}」有多个同名候选，存在歧义；请改用相对路径或知识库内完整路径。`
          : `「${note.title}」中的「${resolved.target}」未找到或未纳入本次导入，请连同对应笔记或附件一起导入。`);
        continue;
      }
      let target: string;
      let label = link.label;
      let embedded = link.embedded;
      if (linked) {
        target = `#note/${linked.id}`;
        label ||= linked.title;
        embedded = false;
      } else if (attachment) {
        const key = pathKey(attachment.path);
        let asset = assetsByPath.get(key);
        if (!asset) {
          const id = idFor(attachment.path, state.assetIds);
          asset = { id, reference: `asset:${id}`, file: attachment };
          assetsByPath.set(key, asset);
        }
        target = asset.reference;
        Object.assign(note.attachments!, { [resolved.target]: target, [attachment.path]: target, [basename(attachment.path)]: target });
        note.attachmentSizes![target] = attachment.size;
        if (/^\d+(?:x\d+)?$/.test(label) || !label) label = basename(attachment.path);
      } else continue;
      report.resolvedLinks++;
      // Only Wiki syntax needs conversion. Ordinary links and definitions keep
      // labels, titles, indentation, line endings and reference-style formatting.
      edits.push(link.wiki
        ? { start: link.start, end: link.end, value: `${embedded ? '!' : ''}[${escapeLabel(label)}](${target})` }
        : { start: link.targetStart, end: link.targetEnd, value: target });
    }
    const unique = new Map<string, SourceEdit>();
    for (const edit of edits) unique.set(`${edit.start}:${edit.end}`, edit);
    const ordered = [...unique.values()].sort((left, right) => left.start - right.start || right.end - left.end);
    let cursor = 0, content = '';
    for (const edit of ordered) {
      if (edit.start < cursor) continue;
      content += note.content.slice(cursor, edit.start) + edit.value;
      cursor = edit.end;
    }
    note.content = content + note.content.slice(cursor);
    await progress('links', index + 1, notes.length, 20);
  }
  const assets: ImportedAsset[] = [];
  const actualSizes = new Map<string, number>();
  const referenced = [...assetsByPath.values()];
  await progress('attachments', 0, referenced.length);
  for (const [index, asset] of referenced.entries()) {
    const blob = await readBlob(asset.file);
    assets.push({ id: asset.id, path: asset.file.path, blob });
    actualSizes.set(asset.reference, blob.size);
    await progress('attachments', index + 1, referenced.length, 1);
  }
  for (const note of notes) for (const reference of Object.keys(note.attachmentSizes!)) note.attachmentSizes![reference] = actualSizes.get(reference) || 0;
  report.notes = notes.length;
  report.relatedNotes = notes.length - entryFiles.length;
  report.attachments = assets.length;
  warnings.push(...[...missing].slice(0, 12));
  if (missing.size > 12) warnings.push(`另有 ${(missing.size - 12).toLocaleString('zh-CN')} 个链接需要补充原文件。`);
  if (!state.files.some(file => !NOTE_EXTENSION.test(file.path)) && report.unresolvedLinks > 0) {
    warnings.unshift('本次没有包含附件。建议选择完整知识库来源，图片和笔记链接会一起保留。');
  }
  checkAbort();
  return { notes: options.category && options.category !== 'auto' ? assignImportedCategory(notes, options.category) : notes, report, warnings, assets };
}

/** Legacy whole-vault imports retain their original whole-source quota checks. */
export async function parseImportFiles(input: File[], options: ImportOptions = {}): Promise<ImportResult> {
  if (options.signal?.aborted) throw new DOMException('已取消导入。', 'AbortError');
  if (input.some(file => !file.webkitRelativePath && /\.zip$/i.test(file.name) && file.size > IMPORT_LIMITS.totalBytes && !isExcludedPath(file.name))) {
    throw new Error(`ZIP 文件超过 ${IMPORT_LIMITS.totalLabel}，请选择知识库文件夹或按目录分批导入。`);
  }
  const source = await scanImportFiles(input, options);
  checkImportBudget(sourceStates.get(source)!.files);
  const result = await parseImportSource(source, options);
  // Actual inflated sizes may correct missing ZIP metadata. Whole-vault mode
  // still accounts for every supported source file after those corrections.
  checkImportBudget(sourceStates.get(source)!.files);
  return result;
}

function notesColor(path: string): number {
  return [...path].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
}
