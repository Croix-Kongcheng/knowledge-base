import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowRight, Check, CheckCircle2, ChevronDown, FileArchive, FileText, Folder, Image, Link2, LoaderCircle, Search, Upload, X } from 'lucide-react';
import { assignImportedCategory, isSupportedImportPath, parseImportFiles, parseImportSource, scanImportFiles, type ImportedNote, type ImportProgress, type ImportReport, type ImportResult, type ImportSource } from '../lib/importer';
import { IMPORT_LIMITS } from '../lib/importLimits';
import { deleteAssets, ensureStorageCapacity, saveAssets } from '../lib/storage';
import { isExcludedPath } from '../lib/privacy';

interface ImportModalProps {
  open: boolean;
  onClose: () => void;
  onImport: (notes: ImportedNote[], report: ImportReport) => void | Promise<void>;
  categories?: string[];
}

type ImportMode = 'linked' | 'zip' | 'folder' | 'markdown';
type DisplayProgress = ImportProgress | { phase: 'saving'; completed: number; total: number; bytes?: number; totalBytes?: number };
const phaseLabels: Record<DisplayProgress['phase'], string> = {
  scan: '正在检查文件', notes: '正在读取笔记', links: '正在连接笔记和附件',
  attachments: '正在准备附件', saving: '正在上传到共享知识库',
};
interface DroppedEntry {
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (success: (entries: DroppedEntry[]) => void, error?: (error: unknown) => void) => void };
}

const format = (value: number) => value.toLocaleString('zh-CN');
const PAGE_SIZE = 100;
const modes = [
  { id: 'linked' as const, label: '关联导入', icon: Link2 },
  { id: 'zip' as const, label: 'ZIP 整库导入', icon: FileArchive },
  { id: 'folder' as const, label: '选择文件夹', icon: Folder },
  { id: 'markdown' as const, label: 'Markdown 文件', icon: FileText },
];

async function readDroppedFiles(dataTransfer: DataTransfer, signal: AbortSignal, onScan: (count: number) => void, sourceOnly = false): Promise<File[]> {
  const items = Array.from(dataTransfer.items);
  const entries = items.map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => DroppedEntry | null }).webkitGetAsEntry?.()).filter(Boolean) as DroppedEntry[];
  if (!entries.some((entry) => entry.isDirectory)) return Array.from(dataTransfer.files);
  const files: File[] = [];
  const fileLimit = sourceOnly ? 250_000 : IMPORT_LIMITS.files;
  let eligibleFiles = 0;
  const visit = async (entry: DroppedEntry, prefix = ''): Promise<void> => {
    if (signal.aborted) throw new DOMException('已取消导入。', 'AbortError');
    if (entry.isDirectory && /^(?:\.obsidian|\.git|__MACOSX|\.trash)$/i.test(entry.name)) return;
    const path = `${prefix}${entry.name}`;
    if (!entry.isDirectory && entry.file) {
      // Private entries need only their path for the exclusion report; do not
      // ask the browser to retrieve their File or read their contents.
      const excluded = isExcludedPath(path);
      if (!excluded && !isSupportedImportPath(path)) return;
      if (!excluded && ++eligibleFiles > fileLimit) throw new Error(sourceOnly ? '来源文件数量超过 250,000 个，请选择较小的知识库来源。' : `一次最多导入 ${IMPORT_LIMITS.filesLabel} 个笔记和附件，请按文件夹分批导入。`);
      const file = excluded ? new File([], entry.name) : await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
      Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true });
      files.push(file);
      if (files.length % 100 === 0) {
        onScan(eligibleFiles);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      return;
    }
    if (entry.createReader) {
      const reader = entry.createReader();
      // Chromium returns directory entries in batches, commonly 100 at a time.
      while (true) {
        const batch = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, `${path}/`);
      }
    }
  };
  for (const entry of entries) await visit(entry);
  return files;
}

export default function ImportModal({ open, onClose, onImport, categories = [] }: ImportModalProps) {
  const [mode, setMode] = useState<ImportMode>('folder');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<DisplayProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [category, setCategory] = useState('auto');
  const [selection, setSelection] = useState('');
  const [showWarnings, setShowWarnings] = useState(false);
  const [source, setSource] = useState<ImportSource | null>(null);
  const [entryPaths, setEntryPaths] = useState<Set<string>>(() => new Set());
  const [sourceQuery, setSourceQuery] = useState('');
  const [pickerLimit, setPickerLimit] = useState(PAGE_SIZE);
  const [previewLimit, setPreviewLimit] = useState(PAGE_SIZE);
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceFolderRef = useRef<HTMLInputElement>(null);
  const sourceZipRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const dragDepth = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const savingRef = useRef(false);
  const closeRef = useRef(onClose);
  const filteredSourceNotes = useMemo(() => {
    const query = sourceQuery.trim().toLocaleLowerCase();
    return source?.notes.filter(note => !query || `${note.path}\n${note.title}`.toLocaleLowerCase().includes(query)) || [];
  }, [source, sourceQuery]);
  const invalidateResult = () => {
    setResult(null);setError('');setProgress(null);setShowWarnings(false);setPreviewLimit(PAGE_SIZE);
  };
  const cancelWork = () => {
    if (savingRef.current) return;
    abortRef.current?.abort();abortRef.current = null;generation.current += 1;
    busyRef.current = false;setBusy(false);invalidateResult();setDragging(false);dragDepth.current = 0;
  };
  const resetSelection = () => {
    cancelWork();setSource(null);setEntryPaths(new Set());setSourceQuery('');setPickerLimit(PAGE_SIZE);
    setSelection('');setCategory('auto');
  };
  const requestClose = () => {
    if (savingRef.current) return;
    resetSelection();
    onClose();
  };
  closeRef.current = requestClose;

  useEffect(() => () => { abortRef.current?.abort(); generation.current += 1; }, []);

  useEffect(() => {
    if (!open) {
      generation.current += 1;
      abortRef.current?.abort();
      busyRef.current = false;
      setBusy(false);
      setSaving(false);
      setProgress(null);
      setResult(null);
      setError('');
      setSelection('');
      setDragging(false);
      setShowWarnings(false);
      setCategory('auto');
      setSource(null);setEntryPaths(new Set());setSourceQuery('');setPickerLimit(PAGE_SIZE);setPreviewLimit(PAGE_SIZE);
      dragDepth.current = 0;
      return;
    }
    const previousFocus = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not([type="file"]):not(:disabled), [tabindex="0"]') || []).filter(control => control.getClientRects().length > 0);
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      cancelAnimationFrame(focusTimer);
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = originalOverflow;
      previousFocus?.focus();
    };
  }, [open]);

  const processFiles = async (files: File[]) => {
    if (savingRef.current) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const job = ++generation.current;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    setShowWarnings(false);
    setSource(null);setEntryPaths(new Set());setSourceQuery('');setPickerLimit(PAGE_SIZE);setPreviewLimit(PAGE_SIZE);
    if (mode === 'linked') setCategory('auto');
    setProgress({ phase: 'scan', completed: 0, total: files.length });
    const eligible = files.filter((file) => isSupportedImportPath(file.webkitRelativePath || file.name) || (!file.webkitRelativePath && /\.zip$/i.test(file.name)));
    const root = eligible[0]?.webkitRelativePath.split('/')[0];
    setSelection(root || (eligible.length === 1 ? eligible[0].name : `已选择 ${format(eligible.length)} 个可导入文件`));
    try {
      const options = {
        signal: controller.signal,
        onProgress: (value: ImportProgress) => { if (job === generation.current) setProgress(value); },
      };
      if (mode === 'linked') {
        const scanned = await scanImportFiles(files, options);
        if (job === generation.current) { setSource(scanned);setProgress(null); }
      } else {
        const parsed = await parseImportFiles(files, options);
        if (job === generation.current) setResult(parsed);
      }
    } catch (cause) {
      if (job === generation.current) setError(cause instanceof Error ? cause.message : '读取失败，请重新选择文件后再试。');
    } finally {
      if (job === generation.current) { busyRef.current = false;setBusy(false); }
    }
  };

  const analyzeLinkedNotes = async () => {
    if (!source || !entryPaths.size || busyRef.current || savingRef.current) return;
    abortRef.current?.abort();
    const controller = new AbortController();abortRef.current = controller;
    const job = ++generation.current;
    busyRef.current = true;setBusy(true);invalidateResult();
    setProgress({ phase: 'notes', completed: 0, total: entryPaths.size });
    try {
      const parsed = await parseImportSource(source, {
        entryPaths: [...entryPaths], includeLinkedNotes: true, signal: controller.signal,
        onProgress: value => { if (job === generation.current) setProgress(value); },
      });
      if (job === generation.current) setResult(parsed);
    } catch (cause) {
      if (job === generation.current) setError(cause instanceof Error ? cause.message : '分析失败，请重新选择入口笔记后再试。');
    } finally {
      if (job === generation.current) { busyRef.current = false;setBusy(false); }
    }
  };

  const toggleEntry = (path: string) => {
    if (busyRef.current || savingRef.current) return;
    invalidateResult();
    setEntryPaths(previous => { const next = new Set(previous);if (next.has(path)) next.delete(path);else next.add(path);return next; });
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    dragDepth.current = 0;
    if (savingRef.current) return;
    abortRef.current?.abort();
    const job = ++generation.current;
    const controller = new AbortController();
    abortRef.current = controller;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setResult(null);setSource(null);setEntryPaths(new Set());setSourceQuery('');setPickerLimit(PAGE_SIZE);setPreviewLimit(PAGE_SIZE);setShowWarnings(false);setSelection('');
    setProgress({ phase: 'scan', completed: 0, total: 0 });
    try {
      const files = await readDroppedFiles(event.dataTransfer, controller.signal, count => {
        if (job === generation.current) setProgress({ phase: 'scan', completed: count, total: 0 });
      }, mode === 'linked');
      if (job === generation.current) await processFiles(files);
    } catch (cause) {
      if (job === generation.current) {
        setError(cause instanceof Error ? cause.message : '无法读取文件夹，请使用“选择文件夹”按钮重试。');
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  if (!open) return null;

  const displayedWarnings = showWarnings ? result?.warnings : result?.warnings.slice(0, 2);
  const availableCategories = [...new Set([...categories, ...(result?.notes.map((note) => note.category) || []), '未分类'])]
    .filter((name) => name !== 'auto' && !isExcludedPath(name));
  const progressDisplay = <>
    <div className="im-upload-icon im-upload-busy"><LoaderCircle size={29} className="im-spin" /></div>
    <strong>{phaseLabels[progress?.phase || 'scan']}…</strong>
    <div className="im-progress" role="progressbar" aria-label="导入进度" aria-valuemin={0} aria-valuemax={progress?.total || undefined} aria-valuenow={progress?.total ? progress.completed : undefined}><i style={{ width: `${progress?.total ? Math.max(2, Math.min(100, progress.completed / progress.total * 100)) : 12}%` }} /></div>
    <span className="im-progress-detail">{progress?.total ? `${format(progress.completed)} / ${format(progress.total)}` : `已检查 ${format(progress?.completed || 0)} 个文件`}{progress?.phase === 'saving' && !!progress.totalBytes ? ` · ${(Number(progress.bytes || 0) / 1024 / 1024).toFixed(1)} / ${(progress.totalBytes / 1024 / 1024).toFixed(1)} MB` : ''}{saving ? ' · 完成保存后即可继续' : ' · 可随时取消'}</span>
    {!saving && <button className="im-text-button" onClick={cancelWork}>{mode === 'linked' && source ? '取消分析' : '取消读取'}</button>}
  </>;
  const handleImport = async () => {
    if (!result || busyRef.current || savingRef.current) return;
    const assets = result.assets || [];
    setBusy(true);
    busyRef.current = true;
    setSaving(true);
    savingRef.current = true;
    setError('');
    setProgress({ phase: 'saving', completed: 0, total: assets.length + 1 });
    try {
      const notes = category === 'auto' ? result.notes : assignImportedCategory(result.notes, category);
      await ensureStorageCapacity(assets.reduce((sum, asset) => sum + asset.blob.size, 0) + new Blob([JSON.stringify(notes)]).size);
      await saveAssets(assets, value => setProgress({ phase: 'saving', completed: value.completed, total: assets.length + 1, bytes: value.bytes, totalBytes: value.totalBytes }));
      await onImport(notes, result.report);
      onClose();
    } catch (cause) {
      await deleteAssets(assets.map(asset => asset.id)).catch(() => {});
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试。');
    } finally {
      setBusy(false);
      busyRef.current = false;
      setSaving(false);
      savingRef.current = false;
    }
  };

  return (
    <div className="im-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <div className="im-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="im-title" aria-describedby="im-description">
        <header className="im-header">
          <span className="im-header-icon"><ArrowDownToLine size={22} strokeWidth={1.8} /></span>
          <div><h2 id="im-title">把你的知识，带到这里</h2><p id="im-description">从 Obsidian 轻松迁移，让每一条灵感都有归处。</p></div>
          <button className="im-close" disabled={saving} onClick={requestClose} aria-label="关闭导入窗口"><X size={20} /></button>
        </header>

        <div className="im-content">
          <div className="im-tabs" role="tablist" aria-label="导入方式">
            {modes.map(({ id, label, icon: Icon }) => (
              <button key={id} role="tab" aria-selected={mode === id} disabled={saving} className={`im-tab ${mode === id ? 'im-tab-active' : ''}`} onClick={() => {
                if (savingRef.current || mode === id) return;
                resetSelection();setMode(id);
              }}><Icon size={16} />{label}{id === 'linked' && <span className="im-recommend">推荐</span>}</button>
            ))}
          </div>

          <div className={`im-drop ${mode === 'linked' ? 'im-linked-drop' : ''} ${dragging ? 'im-drop-active' : ''} ${result || source ? 'im-drop-complete' : ''}`} onDragOver={(event) => event.preventDefault()} onDragEnter={(event) => {
            event.preventDefault();if (savingRef.current) return;dragDepth.current += 1; setDragging(true);
          }} onDragLeave={(event) => {
            event.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) setDragging(false);
          }} onDrop={handleDrop}>
            {busy ? progressDisplay : mode === 'linked' ? (
              <><div className={`im-upload-icon ${source ? 'im-upload-success' : ''}`}>{source ? <Check size={27} /> : <Link2 size={27} strokeWidth={1.6} />}</div><strong>{dragging ? '松开鼠标，读取本地来源' : source ? selection : '先选择本地知识库来源'}</strong><span>{source ? `已在本地找到 ${format(source.notes.length)} 篇可选笔记` : '将知识库文件夹或 ZIP 拖到这里，或使用下方按钮'}</span></>
            ) : result ? (
              <><div className="im-upload-icon im-upload-success"><Check size={27} /></div><strong>{selection}</strong><span>已完成解析，确认下方内容后即可导入</span><button className="im-text-button" onClick={() => inputRef.current?.click()}>重新选择文件</button></>
            ) : (
              <><div className="im-upload-icon"><Upload size={27} strokeWidth={1.6} /></div><strong>{dragging ? '松开鼠标，开始导入' : mode === 'folder' ? '将知识库文件夹拖到这里' : mode === 'markdown' ? '将 Markdown 笔记拖到这里' : '将 Obsidian 知识库 ZIP 拖到这里'}</strong><span>或<button className="im-text-button" onClick={() => inputRef.current?.click()}>{mode === 'folder' ? '选择本地文件夹' : '点击选择文件'}</button></span><small>支持 .md、图片与 PDF 等附件 · 单次最大 {IMPORT_LIMITS.totalLabel} · 最多 {IMPORT_LIMITS.filesLabel} 个文件</small></>
            )}
            {mode === 'linked' ? <>
              <div className="im-source-actions"><button className="im-source-button" disabled={saving} onClick={() => sourceFolderRef.current?.click()}><Folder size={16} />选择来源文件夹</button><button className="im-source-button" disabled={saving} onClick={() => sourceZipRef.current?.click()}><FileArchive size={16} />选择来源ZIP</button></div>
              <input ref={sourceFolderRef} aria-label="关联导入来源文件夹" hidden type="file" multiple {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={event => { const files = Array.from(event.target.files || []);if (files.length) void processFiles(files);event.target.value = ''; }} />
              <input ref={sourceZipRef} aria-label="关联导入来源ZIP" hidden type="file" accept=".zip" onChange={event => { const files = Array.from(event.target.files || []);if (files.length) void processFiles(files);event.target.value = ''; }} />
              <p className="im-local-note">仅导入选中笔记、直接关联的笔记，以及这些笔记引用的附件。来源只在本地查找，确认后才上传。</p>
            </> : <input key={mode} ref={inputRef} aria-label="导入文件" hidden type="file" multiple accept={mode === 'zip' ? '.zip' : mode === 'markdown' ? '.md,.markdown,image/*,.pdf' : undefined} {...(mode === 'folder' ? { webkitdirectory: '', directory: '' } as Record<string, string> : {})} onChange={(event) => {
                const files = Array.from(event.target.files || []);
                if (files.length) void processFiles(files);
                event.target.value = '';
              }} />}
          </div>

          {mode === 'linked' && source && <section className="im-note-picker" aria-label="选择入口笔记">
            <div className="im-picker-heading"><div><strong>选择入口笔记</strong><span>来源共 {format(source.notes.length)} 篇 · 已选择 {format(entryPaths.size)} 篇入口</span></div><button className="im-text-button" disabled={busy || !entryPaths.size} onClick={() => { if (busyRef.current || savingRef.current) return;setEntryPaths(new Set());invalidateResult(); }}>清空选择</button></div>
            <label className="im-picker-search"><Search size={15} /><input type="text" aria-label="搜索入口笔记" placeholder="按标题或目录路径搜索…" value={sourceQuery} disabled={saving} onChange={event => { setSourceQuery(event.target.value);setPickerLimit(PAGE_SIZE); }} /></label>
            <div className="im-picker-list">
              {filteredSourceNotes.slice(0, pickerLimit).map(note => <label className={`im-picker-note ${entryPaths.has(note.path) ? 'is-selected' : ''}`} key={note.path} title={note.path}><input type="checkbox" aria-label={note.path} checked={entryPaths.has(note.path)} disabled={busy} onChange={() => toggleEntry(note.path)} /><span><strong>{note.title}</strong><small>{note.path}</small></span><small>{note.size < 1024 ? `${format(note.size)} B` : `${format(Math.ceil(note.size / 1024))} KB`}</small></label>)}
              {!filteredSourceNotes.length && <p className="im-picker-empty">{source.notes.length ? '没有匹配的笔记，请换一个关键词。' : '来源中没有可导入的 Markdown 笔记，请重新选择来源。'}</p>}
            </div>
            <div className="im-picker-paging"><span>{sourceQuery.trim() ? `搜索到 ${format(filteredSourceNotes.length)} 篇 · ` : ''}当前显示 {format(Math.min(filteredSourceNotes.length, pickerLimit))} / {format(filteredSourceNotes.length)} 篇</span>{filteredSourceNotes.length > pickerLimit && <button className="im-text-button" disabled={saving} onClick={() => setPickerLimit(previous => previous + PAGE_SIZE)}>显示更多入口笔记</button>}</div>
            <div className="im-analyze-row"><span>只关联一层：A → B → C，仅导入 A、B；B 引用的图片等附件一并保留。</span><button className="im-source-button im-analyze" disabled={busy || !entryPaths.size} onClick={() => void analyzeLinkedNotes()}><Link2 size={16} />分析关联内容</button></div>
          </section>}

          {error && <div className="im-error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}

          {result ? (
            <div className="im-preview" role="region" aria-label={mode === 'linked' ? '关联导入预览' : '导入预览'} aria-live="polite">
              <div className="im-section-label">导入预览<span>{mode === 'linked' ? '确认后仅上传下方笔记及引用附件' : '已为你检查文件完整性'}</span></div>
              <div className="im-stats">
                {mode === 'linked' ? <><div><FileText size={17} /><strong>{format(result.report.entryNotes ?? entryPaths.size)}</strong><span>入口笔记</span></div><div><Link2 size={17} /><strong>{format(result.report.relatedNotes ?? Math.max(0, result.report.notes - entryPaths.size))}</strong><span>关联笔记</span></div></> : <div><FileText size={17} /><strong>{format(result.report.notes)}</strong><span>篇笔记</span></div>}
                <div><Image size={17} /><strong>{format(result.report.attachments)}</strong><span>{mode === 'linked' ? '附件' : '个附件'}</span></div>
                {mode !== 'linked' && <div><Link2 size={17} /><strong>{format(result.report.resolvedLinks)}</strong><span>个有效链接</span></div>}
                <div className={result.report.unresolvedLinks ? 'im-stat-warning' : ''}><CheckCircle2 size={17} /><strong>{format(result.report.unresolvedLinks)}</strong><span>{mode === 'linked' ? '待补充链接' : '个待补充链接'}</span></div>
              </div>
              {mode === 'linked' && <div className="im-import-files"><div className="im-section-label">将导入 {format(result.notes.length)} 篇笔记<span>保留来源目录路径</span></div><ul className="im-import-paths" aria-label="将导入的笔记">{result.notes.slice(0, previewLimit).map(note => <li key={note.id}><FileText size={14} /><span>{note.path || `${note.title}.md`}</span><small>{entryPaths.has(note.path || '') ? '入口' : '关联'}</small></li>)}</ul>{result.notes.length > previewLimit && <button className="im-text-button" disabled={saving} onClick={() => setPreviewLimit(previous => previous + PAGE_SIZE)}>显示更多导入路径（{format(Math.min(result.notes.length, previewLimit))} / {format(result.notes.length)}）</button>}</div>}
              {!!result.warnings.length && <div className="im-warnings"><div className="im-warning-heading"><AlertCircle size={15} /><strong>部分链接需要补充文件，笔记内容仍可导入</strong></div>{displayedWarnings?.map((warning, index) => <p key={index}>{warning}</p>)}{result.warnings.length > 2 && <button className="im-text-button" onClick={() => setShowWarnings(!showWarnings)}>{showWarnings ? '收起提示' : `查看全部 ${format(result.warnings.length)} 项提示`}<ChevronDown size={13} style={{ transform: showWarnings ? 'rotate(180deg)' : undefined }} /></button>}</div>}
            </div>
          ) : mode !== 'linked' ? (
            <div className="im-guide"><div className="im-guide-title"><Link2 size={16} /><strong>图片和双向链接，也能一起搬家</strong></div><p>直接选择整个 Obsidian 库文件夹，或导入 ZIP。我们会保留文件夹分类、图片附件，以及 <code>[[笔记链接]]</code>。</p><div className="im-guide-tip"><span>小提示</span>大知识库推荐选择文件夹，无需压缩。只保存笔记实际引用的附件；单独导入 .md 时，请同时选择对应附件。</div></div>
          ) : null}

          <div className="im-category"><div><label htmlFor="im-category-select">知识库分类</label><span>保留原有层级、编号和完整目录路径</span></div><div className="im-select-wrap"><Folder size={15} /><select id="im-category-select" disabled={busy} value={category} onChange={(event) => setCategory(event.target.value)}><option value="auto">保留原有目录分类</option>{availableCategories.map((name) => <option key={name} value={name}>{name}</option>)}</select><ChevronDown size={14} /></div></div>
          <p className="im-overwrite-note">完整目录路径和文件名相同的笔记会更新原内容，保留阅读统计、收藏和已打开的标签；仅能更新你有编辑权限的笔记。</p>
        </div>

        <footer className="im-footer"><span><CheckCircle2 size={14} />保留 Markdown 原有格式</span><div><button className="im-cancel" disabled={saving} onClick={requestClose}>取消</button><button className="im-confirm" disabled={!result || busy} onClick={() => void handleImport()}>{busy ? <LoaderCircle size={16} className="im-spin" /> : <ArrowDownToLine size={16} />}{saving ? '正在保存…' : result ? `导入 ${format(result.report.notes)} 篇笔记` : '开始导入'}<ArrowRight size={15} /></button></div></footer>
      </div>
      <style>{styles}</style>
    </div>
  );
}

const styles = `
.im-overwrite-note{margin:14px 0 0;font-size:12px;line-height:1.8;color:var(--text-muted,#9992a6);max-width:38em}
.im-progress{width:260px;max-width:90%;height:5px;border-radius:4px;background:var(--border,#e8e3ee);overflow:hidden;margin:8px 0}.im-progress>i{display:block;height:100%;border-radius:inherit;background:var(--accent,#8670e5);transition:width .15s ease}.im-drop>.im-progress-detail{font-size:12px;font-variant-numeric:tabular-nums}.im-close:disabled,.im-cancel:disabled{opacity:.45}
.im-overlay{position:fixed;inset:0;z-index:1000;background:rgba(35,32,57,.35);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:28px;font-size:14px;color:#3b3a4f;animation:im-fade .18s ease}
.im-dialog{width:740px;max-width:100%;max-height:calc(100dvh - 56px);overflow:auto;border-radius:22px;background:#fff;box-shadow:0 30px 100px rgba(36,29,77,.2);font-family:inherit;animation:im-rise .22s ease}
.im-dialog button,.im-dialog select{font:inherit}.im-dialog button{cursor:pointer}.im-dialog button:disabled{cursor:not-allowed}.im-dialog button:focus-visible,.im-dialog select:focus-visible{outline:3px solid #c7baff;outline-offset:3px}.im-header{display:flex;align-items:center;gap:15px;padding:28px 30px 25px;border-bottom:1px solid #f0eff5}.im-header-icon{height:48px;width:48px;flex-shrink:0;display:grid;place-items:center;color:#8068e7;border:1px solid #eee8ff;border-radius:15px;background:linear-gradient(140deg,#f7f3ff,#f0edff)}.im-header h2{font-size:15.5px;font-weight:700;color:#333147;margin:0 0 7px;letter-spacing:.1px}.im-header p{font-size:14px;color:#9393a4;margin:0;line-height:1.5}.im-close{border:0;background:transparent;color:#9693a7;display:grid;place-items:center;width:30px;height:30px;align-self:flex-start;margin-left:auto;border-radius:8px}.im-close:hover{background:#f4f2f8;color:#6e5ac3}.im-content{padding:24px 30px 0}.im-tabs{display:flex;gap:6px;border-bottom:1px solid #eeeef4;margin-bottom:20px}.im-tab{position:relative;display:flex;align-items:center;justify-content:center;gap:7px;color:#9290a2;border:0;background:transparent;padding:0 12px 14px;font-size:14px;white-space:nowrap}.im-tab-active{color:#7c68e8!important;font-weight:600!important}.im-tab-active:after{position:absolute;content:'';height:3px;bottom:-1px;left:10px;right:10px;background:#8872ed;border-radius:2px}.im-recommend{background:#f1edff;padding:2px 5px;font-size:12px;color:#8b74e9;border-radius:4px;font-weight:500}.im-drop{display:flex;min-height:218px;padding:23px 20px;align-items:center;flex-direction:column;justify-content:center;gap:9px;border:1.5px dashed #d9d3ef;background:#fcfbff;border-radius:13px;text-align:center;transition:background .2s,border-color .2s}.im-drop-active{background:#f0eaff;border-color:#8c70ef}.im-drop strong{font-size:15.5px;font-weight:600;color:#4b465f;max-width:100%;overflow-wrap:anywhere}.im-drop>span{font-size:14px;color:#9692a8}.im-drop small{font-size:12px;color:#aaa5b9;margin-top:5px}.im-upload-icon{width:55px;height:55px;display:grid;place-items:center;color:#8b74e6;background:#f0ebff;border-radius:16px;margin-bottom:3px}.im-upload-success{background:#e7f8f0;color:#57b98b}.im-upload-busy{background:#f0ebff}.im-drop-complete{min-height:185px;border-style:solid;border-color:#e6e0f6;background:#fdfcff}.im-text-button{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:#8269df;font-size:inherit;font-weight:500;margin:0 3px}.im-text-button:hover{color:#6244c0;text-decoration:underline}.im-guide{margin-top:18px;background:#f7f8fc;border:1px solid #eff0f6;border-radius:12px;padding:17px 18px}.im-guide-title{display:flex;align-items:center;gap:8px;color:#737184}.im-guide-title svg{color:#8b7cbe}.im-guide-title strong{font-size:14px;font-weight:600;color:#666078}.im-guide p{max-width:540px;font-size:12px;line-height:1.9;color:#9894a6;margin:8px 0}.im-guide code{font-size:12px;color:#817294;font-family:inherit}.im-guide-tip{font-size:12px;color:#a09bad;line-height:1.7}.im-guide-tip>span{font-size:12px;color:#9688b1;background:#eeebf6;padding:2px 5px;margin-right:7px;border-radius:4px}.im-category{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:23px 0 25px}.im-category>div:first-child{display:flex;flex-direction:column;gap:6px}.im-category label{font-size:14px;font-weight:600;color:#5c576c}.im-category span{font-size:12px;color:#a19aaa}.im-select-wrap{display:flex;align-items:center;position:relative;gap:8px;border:1px solid #e7e4ef;border-radius:8px;padding:0 11px;color:#a29baa;height:39px;background:#fff}.im-select-wrap select{font-size:14px;color:#71697f;border:0;outline:0;background:transparent;appearance:none;cursor:pointer;padding-right:15px}.im-select-wrap>svg:last-child{pointer-events:none;position:absolute;right:10px}.im-footer{border-top:1px solid #f0eff5;background:#fefeff;padding:19px 30px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-radius:0 0 22px 22px}.im-footer>span{display:flex;align-items:center;gap:6px;font-size:12px;color:#a29baa}.im-footer>span svg{color:#9ec9b8}.im-footer>div{display:flex;gap:10px}.im-cancel{border:1px solid #e7e3ef;color:#8f879e;background:#fff;border-radius:8px;padding:9px 19px;font-size:14px!important}.im-cancel:hover{background:#f8f6fc}.im-confirm{display:flex;align-items:center;justify-content:center;gap:8px;border:0;background:linear-gradient(110deg,#8f76eb,#7c68df);border-radius:8px;color:white;padding:10px 17px;font-size:14px!important;box-shadow:0 4px 10px #8f76eb22;font-weight:500!important}.im-confirm:hover{background:linear-gradient(110deg,#8164df,#7057d1)}.im-confirm:disabled{opacity:.42}.im-preview{margin-top:19px}.im-section-label{display:flex;justify-content:space-between;font-size:14px;font-weight:600;color:#666073;margin-bottom:12px}.im-section-label span{font-size:12px;font-weight:400;color:#a59ead}.im-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.im-stats>div{background:#f8f7fc;border:1px solid #efecf7;border-radius:10px;padding:13px 10px;display:grid;grid-template-columns:auto 1fr;align-items:center;gap:5px 8px}.im-stats svg{color:#9a89ca}.im-stats strong{font-size:27px;font-weight:700;color:#696078}.im-stats span{font-size:12px;color:#a099aa;grid-column:2}.im-stats .im-stat-warning{background:#fff9ef;border-color:#f7eddb}.im-stat-warning svg,.im-stat-warning strong{color:#cc9a48}.im-warnings{background:#fffbf3;color:#a88b62;border-radius:9px;padding:13px 14px;margin-top:13px;border:1px solid #f7ecd9}.im-warning-heading{display:flex;align-items:center;gap:6px}.im-warning-heading strong{font-size:12px;font-weight:600}.im-warnings p{font-size:12px;line-height:1.7;margin:6px 0 0;overflow-wrap:anywhere}.im-warnings .im-text-button{font-size:12px;color:#ad884f;margin:8px 0 0}.im-error{display:flex;align-items:flex-start;gap:8px;color:#bf6872;border:1px solid #f2dce0;background:#fff7f8;padding:12px 14px;border-radius:9px;margin-top:14px;font-size:12px;line-height:1.7}.im-error svg{flex-shrink:0;margin-top:2px}.im-spin{animation:im-spin 1s linear infinite}@keyframes im-spin{to{transform:rotate(360deg)}}@keyframes im-fade{from{opacity:0}to{opacity:1}}@keyframes im-rise{from{transform:translateY(12px);opacity:.5}to{transform:translateY(0);opacity:1}}
@media(max-width:600px){.im-overlay{padding:12px}.im-dialog{max-height:calc(100dvh - 24px);border-radius:17px}.im-header{padding:22px 19px;gap:11px}.im-header-icon{height:42px;width:42px}.im-header h2{font-size:15.5px}.im-header p{font-size:12px}.im-content{padding:20px 19px 0}.im-tab{padding:0 5px 12px;font-size:12px!important;gap:5px;flex:1}.im-tab svg{width:14px}.im-recommend{display:none}.im-tabs{gap:1px}.im-drop{padding:21px 13px}.im-drop small{line-height:1.7}.im-guide{padding:14px}.im-category{align-items:flex-start}.im-category span{max-width:145px;line-height:1.6}.im-select-wrap{padding-left:8px}.im-select-wrap select{max-width:139px}.im-footer{padding:17px 19px}.im-footer>span{display:none}.im-footer>div{width:100%;justify-content:flex-end}.im-stats{grid-template-columns:repeat(2,1fr)}.im-section-label span{display:none}.im-warnings p{line-height:1.8}}@media(prefers-reduced-motion:reduce){.im-overlay,.im-dialog,.im-spin{animation:none}.im-drop{transition:none}}
.im-overlay{color:var(--text-primary,#343447)}
.im-dialog,.im-select-wrap,.im-cancel,.im-footer{background:var(--surface,#fff)}
.im-header,.im-tabs,.im-footer,.im-select-wrap,.im-cancel{border-color:var(--border,#e8e3ee)}
.im-header h2,.im-drop strong,.im-category label,.im-guide-title strong,.im-section-label,.im-stats strong,.im-select-wrap select{color:var(--text-primary,#343447)}
.im-header p,.im-drop>span,.im-drop small,.im-category span,.im-guide p,.im-guide-tip,.im-section-label span,.im-stats span,.im-footer>span,.im-close,.im-tab{color:var(--text-muted,#9292a1)}
.im-drop,.im-drop-complete,.im-guide,.im-stats>div{background:color-mix(in srgb,var(--surface,#fff) 96%,var(--accent,#8670e5));border-color:var(--border,#e8e3ee)}
.im-header-icon,.im-upload-icon,.im-recommend,.im-guide-tip>span{background:color-mix(in srgb,var(--surface,#fff) 87%,var(--accent,#8670e5));color:var(--accent,#8670e5);border-color:var(--border,#e8e3ee)}
.im-tab-active,.im-text-button{color:var(--accent,#8670e5)!important}.im-tab-active:after{background:var(--accent,#8670e5)}
.im-drop-active{background:color-mix(in srgb,var(--surface,#fff) 88%,var(--accent,#8670e5));border-color:var(--accent,#8670e5)}
.im-upload-success{background:color-mix(in srgb,var(--surface,#fff) 88%,#57b98b);color:#57b98b}.im-cancel{color:var(--text-muted,#9292a1)}.im-cancel:hover,.im-close:hover{background:color-mix(in srgb,var(--surface,#fff) 92%,var(--accent,#8670e5))}
.im-warnings,.im-stats .im-stat-warning{background:color-mix(in srgb,var(--surface,#fff) 94%,#cc9a48);border-color:color-mix(in srgb,var(--border,#e8e3ee) 70%,#cc9a48)}.im-error{background:color-mix(in srgb,var(--surface,#fff) 94%,#bf6872);border-color:color-mix(in srgb,var(--border,#e8e3ee) 70%,#bf6872)}
.im-tabs{overflow-x:auto;scrollbar-width:thin}.im-tab{flex-shrink:0}.im-dialog input:focus-visible{outline:3px solid var(--accent,#8670e5);outline-offset:2px}.im-dialog button:disabled{opacity:.45}.im-linked-drop{min-height:170px;padding:20px}.im-source-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:4px}.im-source-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--border,#e8e3ee);border-radius:8px;padding:9px 13px;color:var(--text-primary,#343447);background:var(--surface,#fff);font-size:14px!important;line-height:1.4}.im-source-button:hover:not(:disabled){border-color:var(--accent,#8670e5);color:var(--accent,#8670e5)}.im-local-note{font-size:12px;color:var(--text-muted,#9292a1);line-height:1.7;max-width:38em;margin:4px 0 0}.im-note-picker{margin-top:18px;padding:16px;border:1px solid var(--border,#e8e3ee);border-radius:12px;background:var(--surface,#fff)}.im-picker-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.im-picker-heading>div{display:flex;flex-direction:column;gap:6px;min-width:0}.im-picker-heading strong{font-size:15.5px;font-weight:600;color:var(--text-primary,#343447)}.im-picker-heading span,.im-picker-paging,.im-analyze-row>span{font-size:12px;color:var(--text-muted,#9292a1);line-height:1.6}.im-picker-heading .im-text-button{font-size:12px;flex-shrink:0}.im-picker-search{display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--border,#e8e3ee);border-radius:8px;color:var(--text-muted,#9292a1)}.im-picker-search svg{flex-shrink:0}.im-picker-search input{min-width:0;width:100%;border:0;background:transparent;outline:0;color:var(--text-primary,#343447);font:inherit;font-size:14px}.im-picker-search:focus-within{border-color:var(--accent,#8670e5)}.im-picker-search input:focus-visible{outline:0}.im-picker-list{max-height:240px;overflow:auto;overscroll-behavior:contain;margin-top:10px;scrollbar-width:thin}.im-picker-note{display:flex;align-items:center;gap:10px;padding:10px 9px;border-radius:7px;text-align:left;cursor:pointer}.im-picker-note:hover,.im-picker-note.is-selected{background:color-mix(in srgb,var(--surface,#fff) 92%,var(--accent,#8670e5))}.im-picker-note input{width:15px;height:15px;flex-shrink:0;margin:0;accent-color:var(--accent,#8670e5)}.im-picker-note>span{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}.im-picker-note strong{font-size:14px;font-weight:500;color:var(--text-primary,#343447);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.im-picker-note small{font-size:12px;color:var(--text-muted,#9292a1)}.im-picker-note>span>small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.im-picker-note>small{flex-shrink:0;font-variant-numeric:tabular-nums}.im-picker-empty{font-size:12px;color:var(--text-muted,#9292a1);text-align:center;line-height:1.7;margin:22px 0}.im-picker-paging{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;margin-top:10px}.im-picker-paging .im-text-button{font-size:12px}.im-analyze-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding-top:13px;border-top:1px solid var(--border,#e8e3ee)}.im-analyze{flex-shrink:0;color:var(--accent,#8670e5);font-weight:500!important}.im-import-files{margin-top:16px}.im-import-files .im-section-label{font-size:14px}.im-import-paths{list-style:none;padding:0;margin:0 0 8px;border:1px solid var(--border,#e8e3ee);border-radius:9px;max-height:220px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.im-import-paths li{display:flex;align-items:flex-start;gap:8px;padding:9px 11px;font-size:12px;line-height:1.7;color:var(--text-primary,#343447)}.im-import-paths li+li{border-top:1px solid var(--border,#e8e3ee)}.im-import-paths svg{flex-shrink:0;margin-top:3px;color:var(--text-muted,#9292a1)}.im-import-paths li>span{flex:1;min-width:0;overflow-wrap:anywhere}.im-import-paths small{font-size:12px;flex-shrink:0;color:var(--text-muted,#9292a1)}.im-import-files>.im-text-button{font-size:12px}
@media(max-width:600px){.im-tab{flex:none;padding:0 9px 12px}.im-tabs{padding-top:3px}.im-linked-drop{padding:18px 12px}.im-source-actions{gap:8px}.im-source-button{padding:9px 10px;font-size:12px!important}.im-note-picker{padding:12px}.im-picker-list{max-height:210px}.im-picker-note{padding:9px 4px;gap:8px}.im-picker-note>small{display:none}.im-analyze-row{align-items:stretch;flex-direction:column;gap:8px}.im-analyze-row>span{max-width:34em}.im-picker-heading strong{font-size:15.5px}.im-picker-paging{font-size:12px}}
`;
