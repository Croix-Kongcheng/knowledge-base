import { useReadingPreferences } from '../lib/useReadingPreferences';
import { useEffect, useRef, useState, type ComponentProps, type FormEvent } from 'react';
import { Bold, Check, Code2, Eye, FileText, Hash, ImagePlus, Italic, Link2, List, LoaderCircle, PencilLine, Quote, Table2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { isExcludedPath } from '../lib/privacy';
import type { ImportedNote } from '../lib/importer';
import { getFolderPath, getNotePath } from '../lib/library';
import { assetIdFromReference, useAssetUrl } from '../lib/assets';
import LiveMarkdownEditor, { type LiveMarkdownHandle } from './LiveMarkdownEditor';
import { deleteEditorImages, uploadEditorImage, type EditorImageAsset } from '../lib/editorImages';

export type NoteDraft = Pick<ImportedNote, 'title' | 'content' | 'category' | 'tags' | 'path' | 'attachments' | 'attachmentSizes'>;

type NoteEditorProps = {
  open: boolean;
  onClose: () => void;
  onSave: (note: NoteDraft) => void | Promise<void>;
  categories?: string[];
  initialCategory?: string;
  existingNote?: ImportedNote;
  inline?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
};

function normalizeFolder(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/').normalize('NFC');
}

function PreviewImage({ src, alt, ...props }: ComponentProps<'img'>) {
  const asset = useAssetUrl(src);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (assetIdFromReference(src)) {
    if (!asset.url) return <span className="ne-label-helper" role="status">{asset.error || '正在读取图片…'}</span>;
    if (failedUrl === asset.url) return <span className="ne-label-helper" role="status">图片加载失败，请刷新页面后重试。</span>;
    return <img {...props} src={asset.url} alt={alt || '笔记图片'} onError={() => setFailedUrl(asset.url || null)} />;
  }
  return <img {...props} src={src} alt={alt || '笔记图片'} />;
}

function PreviewLink({ href, children, ...props }: ComponentProps<'a'>) {
  const asset = useAssetUrl(href);
  const isAsset = Boolean(assetIdFromReference(href));
  return <a {...props} href={isAsset ? asset.url : href} target="_blank" rel="noopener noreferrer" download={isAsset ? asset.filename || true : undefined} onClick={event => {
    if ((isAsset && !asset.url) || href?.startsWith('#')) event.preventDefault();
  }}>{children}</a>;
}

export default function NoteEditor({ open, onClose, onSave, categories = [], initialCategory, existingNote, inline = false, onDirtyChange, onBusyChange }: NoteEditorProps) {
  const { preferences } = useReadingPreferences();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState(existingNote?.content || '');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [tab, setTab] = useState<'edit' | 'source' | 'preview'>('edit');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const liveEditor = useRef<LiveMarkdownHandle>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const contentRef = useRef(content);
  const mounted = useRef(false);
  const uploadCount = useRef(0);
  const imageSequence = useRef(0);
  const uploadedImages = useRef(new Map<string, EditorImageAsset>());
  const imageResolutions = useRef(new Map<string, string>());
  const uploadControllers = useRef(new Set<AbortController>());
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const saving = useRef(false);
  const baseline = useRef('');
  const resetting = useRef(false);
  const dirtyRef = useRef(onDirtyChange);
  const busyRef = useRef(onBusyChange);
  dirtyRef.current = onDirtyChange;
  busyRef.current = onBusyChange;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const existingFolder = existingNote ? getFolderPath(existingNote) : '';
  const folders = [...new Set([...categories, existingFolder].filter(path => !isExcludedPath(path)).map(normalizeFolder).filter(Boolean))];
  const requestedFolder = normalizeFolder(initialCategory || '');
  const initialFolder = initialCategory === '' || folders.includes(requestedFolder) ? requestedFolder : folders[0] || '';

  const changeContent = (value: string) => {
    // Undo/redo may restore an asynchronous upload placeholder. Resolve it to
    // the final Markdown (or remove a failed upload) before it can be saved.
    const original = value;
    for (const [marker, replacement] of imageResolutions.current) {
      if (value.includes(marker)) value = value.split(marker).join(replacement);
    }
    contentRef.current = value;
    setContent(value);
    if (value !== original) queueMicrotask(() => {
      // CodeMirror cannot dispatch while notifying onChange. Also synchronize
      // when React skips an identical value after restoring an old placeholder.
      if (!mounted.current) return;
      for (const [marker, replacement] of imageResolutions.current) liveEditor.current?.replaceToken(marker, replacement);
    });
  };

  const cleanDraftImages = () => {
    const images = [...uploadedImages.current.values()];
    uploadedImages.current.clear();
    if (images.length) void deleteEditorImages(images).catch(() => { /* Saved images are protected by the server. */ });
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadControllers.current.forEach(controller => controller.abort());
      if (!saving.current) cleanDraftImages();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    resetting.current = true;
    baseline.current = JSON.stringify([existingNote?.title || '', existingNote?.content || '', existingNote ? existingFolder : initialFolder, existingNote?.tags.join(', ') || '']);
    setTitle(existingNote?.title || '');
    contentRef.current = existingNote?.content || '';
    setContent(contentRef.current);
    setCategory(existingNote ? existingFolder : initialFolder);
    setTags(existingNote?.tags.join(', ') || '');
    setTab('edit');
    setError('');
    setBusy(false);
    saving.current = false;
    dirtyRef.current?.(false);
    busyRef.current?.(false);
    // Keep an in-progress draft intact when the surrounding library refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existingNote?.id]);

  useEffect(() => {
    if (!open) return;
    if (resetting.current) { resetting.current = false; return; }
    dirtyRef.current?.(JSON.stringify([title, content, category, tags]) !== baseline.current);
  }, [open, title, content, category, tags]);

  useEffect(() => () => { dirtyRef.current?.(false); busyRef.current?.(false); }, []);

  useEffect(() => {
    if (!open || !inline || tab !== 'source' || !textarea.current) return;
    const target = textarea.current;
    const resize = () => {
      target.style.height = 'auto';
      target.style.height = `${Math.max(460, target.scrollHeight)}px`;
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width !== previousWidth) { previousWidth = width; resize(); }
    });
    let previousWidth = target.clientWidth;
    observer?.observe(target);
    return () => observer?.disconnect();
  }, [open, inline, tab, content, preferences.fontSize, preferences.lineHeight]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    if (!inline) document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
        if (modal && !dialog.current?.contains(modal)) return;
        if (!saving.current) form.current?.requestSubmit();
        return;
      }
      if (inline) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!saving.current) closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]') || [])].filter(item => item.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      if (!inline) document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [open, inline]);

  if (!open) return null;

  const requestClose = () => { if (!saving.current) onClose(); };

  const insert = (before: string, after = '', fallback = '文字') => {
    if (tab === 'edit') { liveEditor.current?.insert(before, after, fallback); return; }
    const target = textarea.current;
    if (!target) return;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const selected = content.slice(start, end) || fallback;
    changeContent(contentRef.current.slice(0, start) + before + selected + after + contentRef.current.slice(end));
    requestAnimationFrame(() => { target.focus(); target.setSelectionRange(start + before.length, start + before.length + selected.length); });
  };

  const insertBlock = (text: string) => {
    if (tab === 'edit') { liveEditor.current?.insertText(text, { block: true }); return; }
    const target = textarea.current;
    if (!target) return;
    const current = contentRef.current;
    const start = target.selectionStart, end = target.selectionEnd;
    const prefix = start > 0 ? current.slice(0, start).endsWith('\n\n') ? '' : current[start - 1] === '\n' ? '\n' : '\n\n' : '';
    const suffix = current.slice(end).startsWith('\n\n') ? '' : current[end] === '\n' ? '\n' : '\n\n';
    const insertion = prefix + text + suffix;
    changeContent(current.slice(0, start) + insertion + current.slice(end));
    requestAnimationFrame(() => { target.focus(); target.setSelectionRange(start + insertion.length, start + insertion.length); });
  };

  const resolveImage = (marker: string, replacement: string) => {
    imageResolutions.current.set(marker, replacement);
    const current = contentRef.current;
    const position = current.indexOf(marker);
    if (position < 0) return;
    const target = textarea.current;
    const selection = target && document.activeElement === target ? [target.selectionStart, target.selectionEnd] : null;
    if (!liveEditor.current || liveEditor.current.getValue() !== current || !liveEditor.current.replaceToken(marker, replacement)) {
      changeContent(current.replace(marker, replacement));
    }
    if (selection && target) requestAnimationFrame(() => {
      if (document.activeElement !== target) return;
      const map = (offset: number) => offset <= position ? offset : offset >= position + marker.length ? offset + replacement.length - marker.length : position + replacement.length;
      target.setSelectionRange(map(selection[0]), map(selection[1]));
    });
  };

  const pasteImages = async (files: File[]) => {
    if (saving.current || !files.length) return;
    const controller = new AbortController();
    uploadControllers.current.add(controller);
    const items = files.map(file => ({ file, marker: `![正在上传图片…](pending-image:${Date.now()}-${++imageSequence.current})` }));
    insertBlock(items.map(item => item.marker).join('\n\n'));
    uploadCount.current += items.length;
    setUploading(uploadCount.current);
    setError('');
    try {
      for (const { file, marker } of items) {
        if (controller.signal.aborted) break;
        try {
          const image = await uploadEditorImage(file, { signal: controller.signal });
          if (!mounted.current || controller.signal.aborted) {
            void deleteEditorImages([image]).catch(() => {});
            continue;
          }
          uploadedImages.current.set(image.id, image);
          resolveImage(marker, image.markdown);
        } catch (cause) {
          if (mounted.current && !controller.signal.aborted) {
            resolveImage(marker, '');
            setError(cause instanceof Error ? cause.message : '图片上传失败，请重新粘贴。');
          }
        }
      }
    } finally {
      uploadControllers.current.delete(controller);
      uploadCount.current -= items.length;
      if (mounted.current) setUploading(uploadCount.current);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving.current) return;
    if (uploadCount.current) { setError('图片正在上传，请稍候再保存。'); return; }
    if (!title.trim()) { setError('请为这篇笔记起个标题。'); return; }
    if (!content.trim()) { setError('写下一点内容，再保存笔记吧。'); setTab('edit'); return; }
    const folder = normalizeFolder(category);
    const filename = existingNote && title.trim() === existingNote.title ? getNotePath(existingNote).split('/').pop()! : `${title.trim().replace(/[\\/]/g, '／')}.md`;
    saving.current = true;
    setBusy(true);
    busyRef.current?.(true);
    setError('');
    try {
      const images = [...uploadedImages.current.values()];
      const attached = images.filter(image => content.includes(image.reference));
      const unused = images.filter(image => !content.includes(image.reference));
      const attachments = { ...existingNote?.attachments };
      const attachmentSizes = { ...existingNote?.attachmentSizes };
      for (const image of attached) { attachments[image.path] = image.reference; attachmentSizes[image.reference] = image.size; }
      await onSave({ title: title.trim(), content, category: folder.split('/')[0] || '未分类', path: `${folder ? `${folder}/` : ''}${filename}`, tags: [...new Set(tags.split(/[,，、]/).map(tag => tag.trim().replace(/^#/, '')).filter(Boolean))], attachments, attachmentSizes });
      uploadedImages.current.clear();
      if (unused.length) void deleteEditorImages(unused).catch(() => {});
      baseline.current = JSON.stringify([title, content, category, tags]);
      dirtyRef.current?.(false);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试。你的修改仍保留在这里。');
    } finally {
      saving.current = false;
      setBusy(false);
      busyRef.current?.(false);
      if (!mounted.current) cleanDraftImages();
    }
  };

  return (
    <div className={inline ? 'ne-inline-host' : 'ne-backdrop'} onMouseDown={event => { if (!inline && event.target === event.currentTarget) requestClose(); }}>
      <style>{`
        .ne-backdrop{position:fixed;inset:0;z-index:1100;background:rgba(34,31,54,.34);backdrop-filter:blur(7px);display:flex;align-items:center;justify-content:center;padding:24px;color:#343447;font-family:inherit}.ne-modal{width:800px;max-width:100%;max-height:calc(100dvh - 48px);border-radius:24px;background:#fff;box-shadow:0 24px 90px rgba(43,35,75,.2);overflow-y:auto;animation:ne-enter .2s ease-out}.ne-header{display:flex;align-items:center;justify-content:space-between;padding:25px 30px 22px;border-bottom:1px solid #f0edf5}.ne-heading{display:flex;align-items:center;gap:12px}.ne-heading-icon{height:40px;width:40px;background:#f0ebfc;color:#8670e5;border-radius:12px;display:grid;place-items:center}.ne-title{font-size:15.5px!important;font-weight:600;line-height:1.5;margin:0}.ne-subtitle{font-size:12px;color:#a19aaa;margin:2px 0 0}.ne-close{border:0;background:none;width:32px;height:32px;display:grid;place-items:center;color:#a49cac;border-radius:9px;cursor:pointer}.ne-close:hover{background:#f4f1fa;color:#7862d7}.ne-form{padding:26px 30px 0}.ne-field{margin-bottom:20px}.ne-field>label{display:block;font-size:14px;font-weight:500;color:#686071;margin-bottom:8px}.ne-input{width:100%;box-sizing:border-box;height:42px;border:1px solid #e8e3ee;border-radius:9px;padding:0 13px;font:inherit;font-size:14px;outline:none;background:white;color:#4c4357;transition:border-color .15s,box-shadow .15s}.ne-input:focus{border-color:#ad9ce8;box-shadow:0 0 0 3px #8670e510}.ne-input::placeholder{color:#b3aaba}.ne-note-title{height:45px;font-size:15.5px;font-weight:600}.ne-meta{display:grid;grid-template-columns:1fr 1.6fr;gap:16px}.ne-tags-wrap{position:relative}.ne-tags-wrap>svg{position:absolute;left:12px;top:13px;color:#b4a6c7}.ne-tags-input{padding-left:35px}.ne-label-helper{font-size:12px;font-weight:400;color:#aaa1b3;margin-left:7px}.ne-editor{border:1px solid #e7e2ee;border-radius:12px;overflow:hidden}.ne-editor-top{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #eee9f4;background:#fcfbfe;padding:0 13px;gap:8px}.ne-tabs{display:flex;align-items:center;gap:19px}.ne-tab{border:0;border-bottom:2px solid transparent;margin-bottom:-1px;background:none;color:#a197ac;font:inherit;font-size:12px;height:43px;display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;padding:0 2px;font-weight:500}.ne-tab.active{color:#8670e5;border-bottom-color:#8670e5}.ne-tools{display:flex;gap:1px;align-items:center}.ne-tool{border:0;border-radius:5px;background:none;color:#9b91a6;width:28px;height:27px;display:grid;place-items:center;cursor:pointer}.ne-tool:hover{color:#8670e5;background:#eee8fb}.ne-textarea{box-sizing:border-box;width:100%;height:270px;min-height:170px;resize:vertical;border:0;outline:none;padding:20px;font-family:inherit;font-size:14px;line-height:1.9;color:#5d526a;display:block;background:#fff}.ne-textarea::placeholder{color:#b5adbd}.ne-preview{box-sizing:border-box;height:270px;overflow-y:auto;padding:18px 22px;font-size:14px;line-height:1.9;color:#655b71;overflow-wrap:anywhere}.ne-preview>*{max-width:38em}.ne-preview>p{margin:0 0 14px}.ne-preview h1,.ne-preview h2,.ne-preview h3,.ne-preview h4{font-size:15.5px!important;font-weight:600;color:#44394f;margin:18px 0 10px}.ne-preview h1{margin-top:0}.ne-preview ul,.ne-preview ol{padding-left:23px}.ne-preview a{color:#8670e5}.ne-preview blockquote{border-left:3px solid #cdbff3;background:#f8f5fe;margin:14px 0;padding:1px 14px;color:#9784ae}.ne-preview pre{background:#f6f3fa;padding:14px;border-radius:8px;font-size:12px;overflow:auto}.ne-preview code{background:#f1edf8;border-radius:4px;padding:2px 4px;font-size:12px}.ne-preview pre code{padding:0}.ne-preview img{max-width:100%;border-radius:8px}.ne-preview table{border-collapse:collapse;max-width:100%;font-size:12px}.ne-preview th,.ne-preview td{border:1px solid #e7e0ef;padding:5px 9px}.ne-preview-empty{display:grid;place-items:center;height:100%;color:#b1a6bd;font-size:14px}.ne-editor-bottom{padding:8px 13px;background:#fcfbfe;border-top:1px solid #f0ebf5;display:flex;justify-content:space-between;color:#aaa0b5;font-size:12px;gap:10px}.ne-error{background:#fff2f3;color:#d86875;font-size:12px;line-height:1.6;border-radius:8px;padding:9px 12px;margin:14px 0 0}.ne-footer{margin:24px -30px 0;padding:18px 30px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid #f0edf5;gap:14px}.ne-footer-note{font-size:12px;color:#a69cad;display:flex;gap:6px;align-items:center}.ne-actions{display:flex;gap:10px}.ne-cancel,.ne-save{height:39px;border-radius:9px;font:inherit;font-size:14px;font-weight:500;padding:0 19px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap}.ne-cancel{border:1px solid #e9e2ef;background:#fff;color:#8c8099}.ne-cancel:hover{background:#f8f5fc}.ne-save{border:1px solid #8670e5;color:#fff;background:#8670e5;box-shadow:0 4px 10px #8670e51f}.ne-save:hover{background:#7862d7}.ne-fields{padding:0;margin:0;border:0;min-width:0}.ne-modal button:disabled{opacity:.55;cursor:wait}.ne-modal input:disabled,.ne-modal select:disabled,.ne-modal textarea:disabled{opacity:.75;cursor:wait}.ne-spinner{animation:ne-spin 1s linear infinite}@keyframes ne-spin{to{transform:rotate(360deg)}}.ne-inline-label{font-size:14px;font-weight:500;color:#686071;display:block;margin-bottom:8px}@keyframes ne-enter{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:translateY(0)}}@media(max-width:620px){.ne-backdrop{padding:12px}.ne-modal{max-height:calc(100dvh - 24px)}.ne-header{padding:21px 20px}.ne-form{padding:21px 20px 0}.ne-meta{grid-template-columns:1fr;gap:0}.ne-field{margin-bottom:16px}.ne-footer{margin-left:-20px;margin-right:-20px;padding:16px 20px}.ne-footer-note{display:none}.ne-actions{margin-left:auto}.ne-tools{gap:0}.ne-tool{width:23px}.ne-editor-top{padding:0 9px}.ne-tabs{gap:12px}.ne-textarea,.ne-preview{height:230px}.ne-label-helper{margin-left:4px}}
      `}</style>
      <style>{`
        .ne-location{min-width:0;overflow-wrap:anywhere;font-size:12px;line-height:1.7;color:var(--text-secondary,#686071);padding:5px 0}.ne-location small{display:block;font-size:12px;color:var(--text-muted,#9995a6)}
        .ne-inline-host{width:100%;min-width:0;color:var(--text-primary,#343447);background:var(--reader-bg,var(--surface,#fff))}
        .ne-inline{width:100%;max-width:none;max-height:none;min-height:calc(100dvh - 64px);border-radius:0;box-shadow:none;overflow:visible;animation:none;background:var(--reader-bg,var(--surface,#fff));color:var(--text-primary,#343447);container-type:inline-size}
        .ne-inline .ne-header{position:sticky;top:0;z-index:20;gap:20px;padding:15px clamp(20px,3cqw,48px);background:var(--surface-secondary,#f7f6f9);border-bottom-color:var(--border,#e9e7ee);flex-wrap:wrap}
        .ne-inline .ne-heading{min-width:0}.ne-inline .ne-heading>div{min-width:0}.ne-inline .ne-heading-icon{height:36px;width:36px;background:color-mix(in srgb,var(--accent,#8670e5) 13%,transparent);color:var(--accent,#8670e5)}
        .ne-inline .ne-title{font-size:15.5px!important;color:var(--text-primary,#343447)}.ne-inline .ne-subtitle{color:var(--text-muted,#a19aaa);line-height:1.7}.ne-inline .ne-actions{margin-left:auto;flex-shrink:0}
        .ne-inline .ne-form{max-width:1240px;width:100%;min-width:0;margin:0 auto;padding:30px clamp(20px,3cqw,48px) 24px}.ne-inline .ne-field{min-width:0}.ne-inline .ne-meta{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
        .ne-inline .ne-input{min-width:0;max-width:100%;text-overflow:ellipsis;color:var(--text-primary,#343447);background:var(--surface,#fff);border-color:var(--border,#e9e7ee)}.ne-inline .ne-note-title{height:53px;font-size:27px;font-weight:700;padding:0 12px}
        .ne-inline .ne-field>label,.ne-inline .ne-inline-label{color:var(--text-secondary,#686071)}.ne-inline .ne-editor{border-color:var(--border,#e9e7ee);background:var(--reader-bg,var(--surface,#fff))}.ne-inline .ne-editor-top{position:static;background:var(--surface-secondary,#f7f6f9);border-color:var(--border,#e9e7ee)}
        .ne-inline .ne-textarea{height:auto;min-height:460px;resize:none;overflow:hidden;background:var(--reader-bg,var(--surface,#fff));color:var(--text-primary,#343447);padding:24px;line-height:1.95;tab-size:2}.ne-inline .ne-preview{height:auto;min-height:460px;overflow:visible;max-width:none;padding:24px;background:var(--reader-bg,var(--surface,#fff));color:var(--text-primary,#343447)}.ne-inline .ne-preview>*{max-width:none}
        .ne-inline .ne-preview h1{font-size:27px!important;font-weight:700;display:block}.ne-inline .ne-preview h2,.ne-inline .ne-preview h3,.ne-inline .ne-preview h4{font-size:15.5px!important}.ne-inline .ne-preview pre{max-width:100%;background:var(--surface-secondary,#f6f3fa)}.ne-inline .ne-preview table{font-size:14px;display:block;overflow:auto}.ne-inline .ne-preview .katex-display{overflow:auto}
        .ne-inline .ne-editor-bottom{background:var(--surface-secondary,#f7f6f9);border-color:var(--border,#e9e7ee);color:var(--text-muted,#aaa0b5)}.ne-inline .ne-footer{margin:0;padding:16px 0 0;border-top:0;flex-wrap:wrap}.ne-inline .ne-footer-note{color:var(--text-muted,#a69cad)}.ne-inline .ne-shortcut{font-size:12px;color:var(--text-muted,#a69cad)}
        .ne-inline .ne-tab.active{color:var(--accent,#8670e5);border-bottom-color:var(--accent,#8670e5)}.ne-inline .ne-tool:hover{color:var(--accent,#8670e5);background:color-mix(in srgb,var(--accent,#8670e5) 12%,transparent)}.ne-inline .ne-input:focus{border-color:var(--accent,#8670e5);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent,#8670e5) 10%,transparent)}.ne-inline .ne-preview a,.ne-inline .ne-preview code{color:var(--accent,#8670e5)}.ne-inline .ne-preview blockquote{color:var(--text-secondary,#9784ae);border-left-color:var(--accent,#8670e5);background:color-mix(in srgb,var(--accent,#8670e5) 7%,var(--surface,#fff))}
        .ne-inline .ne-cancel{background:var(--surface,#fff);color:var(--text-secondary,#8c8099);border-color:var(--border,#e9e7ee)}.ne-inline .ne-save{background:var(--accent,#8670e5);border-color:var(--accent,#8670e5)}.ne-inline button:disabled{opacity:.55;cursor:wait}.ne-inline input:disabled,.ne-inline select:disabled,.ne-inline textarea:disabled{opacity:.75;cursor:wait}.ne-inline .ne-error{position:sticky;top:76px;z-index:21;margin:0 0 18px;scroll-margin-top:110px}
        @container(max-width:650px){.ne-inline .ne-header{padding:12px 16px;gap:12px}.ne-inline .ne-heading-icon{display:none}.ne-inline .ne-subtitle{display:none}.ne-inline .ne-header .ne-actions{gap:6px}.ne-inline .ne-cancel,.ne-inline .ne-save{height:35px;padding:0 11px}.ne-inline .ne-form{padding:22px 16px}.ne-inline .ne-meta{grid-template-columns:minmax(0,1fr);gap:0}.ne-inline .ne-editor-top{top:60px;flex-wrap:wrap;gap:0}.ne-inline .ne-textarea,.ne-inline .ne-preview{padding:16px;min-height:420px}.ne-inline .ne-shortcut{display:none}}
      `}</style>
      <style>{`
        .ne-editor-top{flex-wrap:wrap}.ne-tabs{gap:14px}.ne-tool{color:var(--text-secondary,#9b91a6)}.ne-tools{padding:4px 0;flex-wrap:wrap}.ne-editor-bottom [role=status]{display:inline-flex;align-items:center;gap:5px}.ne-editor [hidden]{display:none!important}
      `}</style>
      <section ref={dialog} className={inline ? 'ne-inline' : 'ne-modal'} role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : true} aria-labelledby="ne-heading" aria-busy={busy}>
        <header className="ne-header"><div className="ne-heading"><span className="ne-heading-icon"><FileText size={20} strokeWidth={1.7} /></span><div><h2 id="ne-heading" className="ne-title">{existingNote ? '编辑笔记' : '记录新的灵感'}</h2><p className="ne-subtitle">{existingNote ? '直接修改文档，保存后返回阅读' : '让零散的想法，成为有价值的知识'}</p></div></div>{inline ? <div className="ne-actions"><button className="ne-cancel" type="button" onClick={requestClose} disabled={busy}>取消</button><button className="ne-save" type="submit" form="ne-form" disabled={busy || uploading > 0}>{busy ? <LoaderCircle size={15} className="ne-spinner"/> : <Check size={15}/>} {busy ? '正在保存…' : existingNote ? '保存修改' : '保存笔记'}</button></div> : <button className="ne-close" type="button" onClick={requestClose} disabled={busy} aria-label="关闭笔记编辑器"><X size={20} /></button>}</header>
        <form ref={form} id="ne-form" className="ne-form" onSubmit={submit}>
          {inline && error && <div className="ne-error" role="alert">{error}</div>}
          <fieldset className="ne-fields" disabled={busy}>
          <div className="ne-field"><label htmlFor="ne-note-title">笔记标题</label><input id="ne-note-title" className="ne-input ne-note-title" autoFocus={!existingNote||Boolean(existingNote.content.trim())} placeholder="一个清晰的标题，是整理思路的开始" value={title} onChange={event => setTitle(event.target.value)} maxLength={120} /></div>
          <div className="ne-meta">
            <div className="ne-field">{existingNote ? <><span className="ne-inline-label">文档位置</span><div className="ne-location" title={existingFolder || '知识库根目录'}>{existingFolder || '知识库根目录'}<small>在左侧目录拖动文档可移动位置</small></div></> : <><label htmlFor="ne-category">知识分类</label><select id="ne-category" className="ne-input" value={category} onChange={event => setCategory(event.target.value)}><option value="">知识库根目录</option>{folders.map(folder => <option key={folder} value={folder}>{folder}</option>)}</select></>}</div>
            <div className="ne-field"><label htmlFor="ne-tags">添加标签<span className="ne-label-helper">用逗号分隔</span></label><div className="ne-tags-wrap"><Hash size={15} /><input id="ne-tags" className="ne-input ne-tags-input" placeholder="例如：React, 前端, 学习" value={tags} onChange={event => setTags(event.target.value)} /></div></div>
          </div>
          <label className="ne-inline-label" htmlFor={tab === 'source' ? 'ne-content-source' : 'ne-content'}>笔记内容</label>
          <div className="ne-editor">
            <div className="ne-editor-top">
              <div className="ne-tabs" role="tablist" aria-label="编辑模式">
                <button className={`ne-tab ${tab === 'edit' ? 'active' : ''}`} role="tab" aria-selected={tab === 'edit'} type="button" onClick={() => setTab('edit')}><PencilLine size={14}/>编辑</button>
                <button className={`ne-tab ${tab === 'source' ? 'active' : ''}`} role="tab" aria-selected={tab === 'source'} type="button" onClick={() => setTab('source')}><Code2 size={14}/>源码</button>
                <button className={`ne-tab ${tab === 'preview' ? 'active' : ''}`} role="tab" aria-selected={tab === 'preview'} type="button" onClick={() => setTab('preview')}><Eye size={14}/>预览</button>
              </div>
              {tab !== 'preview' && <div className="ne-tools" onMouseDown={event => event.preventDefault()}>
                <button className="ne-tool" title="粗体 · Ctrl/⌘ B" aria-label="插入粗体" type="button" onClick={() => insert('**', '**')}><Bold size={14}/></button>
                <button className="ne-tool" title="斜体 · Ctrl/⌘ I" aria-label="插入斜体" type="button" onClick={() => insert('*', '*')}><Italic size={14}/></button>
                <button className="ne-tool" title="链接" aria-label="插入链接" type="button" onClick={() => insert('[', '](https://example.com)', '链接文字')}><Link2 size={14}/></button>
                <button className="ne-tool" title="列表" aria-label="插入列表" type="button" onClick={() => insert('\n- ', '', '列表项')}><List size={15}/></button>
                <button className="ne-tool" title="引用" aria-label="插入引用" type="button" onClick={() => insert('\n> ', '', '引用内容')}><Quote size={14}/></button>
                <button className="ne-tool" title="代码" aria-label="插入代码" type="button" onClick={() => insert('`', '`', 'code')}><Code2 size={14}/></button>
                <button className="ne-tool" title="插入表格" aria-label="插入表格" type="button" onClick={() => insertBlock('| 列1 | 列2 |\n| --- | --- |\n| 内容 | 内容 |')}><Table2 size={14}/></button>
                <button className="ne-tool" title="插入图片 · 也可直接 Ctrl/⌘ V 粘贴" aria-label="插入图片" type="button" onClick={() => imageInput.current?.click()}><ImagePlus size={14}/></button>
                <input ref={imageInput} hidden type="file" aria-label="选择笔记图片" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp" multiple onChange={event => { const files = [...(event.target.files || [])]; event.target.value = ''; void pasteImages(files); }}/>
              </div>}
            </div>
            <div hidden={tab !== 'edit'}><LiveMarkdownEditor ref={liveEditor} value={content} onChange={changeContent} onPasteImages={files => void pasteImages(files)} attachments={existingNote?.attachments} active={tab === 'edit'} disabled={busy} autoFocus={Boolean(existingNote && !existingNote.content.trim())}/></div>
            {tab === 'source' && <textarea ref={textarea} aria-label="笔记内容" autoFocus={Boolean(existingNote && !existingNote.content.trim())} id="ne-content-source" className="ne-textarea" placeholder={'从一个想法开始…\n\n支持 Markdown 语法，也可直接粘贴图片。'} value={content} onChange={event => changeContent(event.target.value)} onPaste={event => {
              const files = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
              if (files.length) { event.preventDefault(); void pasteImages(files); }
            }}/>}
            {tab === 'preview' && <div className="ne-preview" role="tabpanel">{content.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]} urlTransform={url => assetIdFromReference(url) || /^(?:https?:|mailto:|#|data:(?:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif|bmp)|application\/pdf|text\/(?:plain|csv)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+);base64,)/i.test(url) ? url : undefined} components={{ img: ({ node: _node, ...props }) => <PreviewImage {...props}/>, a: ({ node: _node, ...props }) => <PreviewLink {...props}/> }}>{content}</ReactMarkdown> : <div className="ne-preview-empty">写下一点内容，就能在这里预览</div>}</div>}
            <div className="ne-editor-bottom"><span>{uploading > 0 ? <span role="status" aria-live="polite"><LoaderCircle size={12} className="ne-spinner"/> 正在上传图片…{uploading > 1 ? `（${uploading} 张）` : ''}</span> : tab === 'edit' ? '实时预览 · Ctrl / ⌘ + V 粘贴图片' : 'Markdown · Ctrl / ⌘ + V 粘贴图片'}</span><span>{content.length.toLocaleString('zh-CN')} 字符</span></div>
          </div>
          </fieldset>
          {!inline && error && <div className="ne-error" role="alert">{error}</div>}
          <footer className="ne-footer"><span className="ne-footer-note"><Check size={13} />{existingNote ? '保留原有图片与笔记链接' : '保存到知识库'}</span>{inline ? <span className="ne-shortcut">Ctrl / ⌘ + S 保存</span> : <div className="ne-actions"><button className="ne-cancel" type="button" onClick={requestClose} disabled={busy}>取消</button><button className="ne-save" type="submit" disabled={busy || uploading > 0}>{busy ? <LoaderCircle size={15} className="ne-spinner"/> : <Check size={15}/>} {busy ? '正在保存…' : existingNote ? '保存修改' : '保存笔记'}</button></div>}</footer>
        </form>
      </section>
    </div>
  );
}
