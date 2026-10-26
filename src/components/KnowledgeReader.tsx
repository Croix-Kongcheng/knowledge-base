import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight, FileText, Folder, Link2, List, LoaderCircle, LockKeyhole, PanelRightClose, PencilLine, Star, Trash2, UsersRound } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { ImportedNote } from '../lib/importer';
import { getFolderPath } from '../lib/library';
import { assetIdFromReference, useAssetUrl } from '../lib/assets';
import { apiRequest } from '../lib/api';

interface KnowledgeReaderProps {
  tabs?: ReactNode;
  note: ImportedNote;
  notes: ImportedNote[];
  onOpenNote: (id: string) => void;
  onClose: () => void;
  favorite: boolean;
  onToggleFavorite: () => void;
  onCategoryChange?: (category: string) => void;
  canEdit: boolean;
  canDelete: boolean;
  canManageSharing: boolean;
  collaborative: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggleSharing: (enabled: boolean) => Promise<void>;
}

interface Heading { id: string; title: string; level: number; line: number }

function plainText(text: string): string {
  return text.replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').replace(/<[^>]*>/g, '').trim();
}

function slug(text: string): string {
  return plainText(text).toLocaleLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
}

function headingsFrom(content: string): Heading[] {
  const headings: Heading[] = [];
  const occurrences = new Map<string, number>();
  let fence = '';
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      return;
    }
    if (fence) return;
    const match = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
    const setext = !match && line.trim() ? lines[index + 1]?.match(/^\s{0,3}(=+|-+)\s*$/) : null;
    if (!match && !setext) return;
    const title = plainText(match ? match[2] : line);
    const base = slug(title) || 'section';
    const count = occurrences.get(base) || 0;
    occurrences.set(base, count + 1);
    headings.push({ title, id: `kr-${base}${count ? `-${count}` : ''}`, level: match ? match[1].length : setext?.[1].startsWith('=') ? 1 : 2, line: index + 1 });
  });
  return headings;
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '刚刚' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function ReaderImage({ src, alt, ...props }: ComponentProps<'img'>) {
  const reference = typeof src === 'string' ? src : undefined;
  const asset = useAssetUrl(reference);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (assetIdFromReference(reference)) {
    if (!asset.url) return <span className="kr-asset-state" role="status">{asset.error || `正在读取${alt ? `：${alt}` : '图片'}…`}</span>;
    if (failedUrl === asset.url) return <span className="kr-asset-state" role="status">图片加载失败，请刷新页面后重试。</span>;
    return <img {...props} src={asset.url} loading="lazy" alt={alt || '笔记图片'} onError={() => setFailedUrl(asset.url || null)}/>;
  }
  return <img {...props} src={src} loading="lazy" alt={alt || '笔记图片'}/>;
}

interface ReaderLinkProps extends ComponentProps<'a'> {
  onOpenNote: (id: string) => void;
  onHeading: (anchor: string) => void;
}

function ReaderLink({ href, children, onOpenNote, onHeading, ...props }: ReaderLinkProps) {
  const asset = useAssetUrl(href);
  const isAsset = Boolean(assetIdFromReference(href));
  const external = /^https?:/i.test(href || '');
  return <a {...props} href={isAsset ? asset.url : href}
    target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}
    download={isAsset ? asset.filename || true : href?.startsWith('data:') ? true : undefined}
    aria-busy={isAsset && asset.loading ? true : undefined} title={isAsset ? asset.error || (asset.loading ? '正在读取附件…' : asset.filename) : props.title}
    onClick={event => {
      if (isAsset) { if (!asset.url) event.preventDefault(); return; }
      if (href?.startsWith('#note/')) {
        event.preventDefault();
        try { onOpenNote(decodeURIComponent(href.slice(6))); } catch { onOpenNote(href.slice(6)); }
      } else if (href?.startsWith('#')) {
        event.preventDefault();
        let target = href.slice(1);
        try { target = decodeURIComponent(target); } catch { /* Keep malformed anchors readable. */ }
        onHeading(target);
      }
    }}>{children}{isAsset && asset.error ? <span className="kr-asset-state">（{asset.error}）</span> : null}</a>;
}

export default function KnowledgeReader({ tabs, note, notes, onOpenNote, onClose, favorite, onToggleFavorite, canEdit, canDelete, canManageSharing, collaborative, onEdit, onDelete, onToggleSharing }: KnowledgeReaderProps) {
  const [tocMode, setTocMode] = useState<'auto' | 'open' | 'closed'>('auto');
  const [wideReader, setWideReader] = useState(false);
  const [activeHeading, setActiveHeading] = useState('');
  const [sharingBusy, setSharingBusy] = useState(false);
  const [sharingError, setSharingError] = useState('');
  const [backlinkIds, setBacklinkIds] = useState<string[]>([]);
  const [backlinksReady, setBacklinksReady] = useState(false);
  const openNoteRef = useRef(onOpenNote);
  openNoteRef.current = onOpenNote;
  const openLinkedNote = useCallback((id: string) => openNoteRef.current(id), []);
  const sharingPending = useRef(false);
  const currentNoteId = useRef(note.id);
  currentNoteId.current = note.id;
  useEffect(() => { setSharingError(''); }, [note.id]);
  const articleRef = useRef<HTMLElement>(null);
  const readerRef = useRef<HTMLElement>(null);
  const showToc = tocMode === 'open' || (tocMode === 'auto' && wideReader);
  const displayContent = useMemo(() => {
    const firstHeading = note.content.match(/^(?:[ \t]*\r?\n)*#\s+(.+)\r?(?:\n|$)/);
    return firstHeading && plainText(firstHeading[1]) === plainText(note.title) ? note.content.slice(firstHeading[0].length).trimStart() : note.content;
  }, [note.content, note.title]);
  const headings = useMemo(() => headingsFrom(displayContent), [displayContent]);
  const headingByLine = useMemo(() => new Map(headings.map(heading => [heading.line, heading.id])), [headings]);
  const folder = getFolderPath(note);
  useEffect(() => {
    let active = true;
    setBacklinksReady(false);setBacklinkIds([]);
    void apiRequest<{ids: string[]}>(`/notes/${encodeURIComponent(note.id)}/backlinks`).then(result => {
      if (active) { setBacklinkIds(result.ids);setBacklinksReady(true); }
    }).catch(() => { if (active) setBacklinksReady(true); });
    return () => { active = false; };
  }, [note.id, note.revision, notes]);
  const backlinks = useMemo(() => {
    const ids = new Set(backlinkIds);
    return notes.filter(other => ids.has(other.id));
  }, [backlinkIds, notes]);
  const wordCount = useMemo(() => {
    const plain = displayContent.replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    return (plain.match(/[\p{Script=Han}]|[a-zA-Z0-9]+/gu) || []).length;
  }, [displayContent]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;
    const update = () => setWideReader(reader.clientWidth >= 1040);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(reader);
    if (!observer) window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [note.id]);

  useEffect(() => {
    setActiveHeading('');
    const elements = articleRef.current?.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id]');
    if (!elements?.length || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting);
      if (visible.length) setActiveHeading(visible[0].target.id);
    }, { rootMargin: '-80px 0px -65% 0px', threshold: 0 });
    elements.forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [note.id, headings]);

  const goToHeading = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveHeading(id);
  }, []);

  const toggleSharing = async () => {
    if (!canManageSharing || sharingPending.current) return;
    const targetId = note.id;
    sharingPending.current = true;
    setSharingBusy(true);
    setSharingError('');
    try {
      await onToggleSharing(!collaborative);
    } catch (error) {
      if (currentNoteId.current === targetId) setSharingError(error instanceof Error ? error.message : '权限更新失败，请稍后重试。');
    } finally {
      sharingPending.current = false;
      setSharingBusy(false);
    }
  };

  const renderedMarkdown = useMemo(() => (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
            urlTransform={url => assetIdFromReference(url) || /^(?:https?:|mailto:|#|data:(?:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif|bmp)|application\/pdf|text\/(?:plain|csv)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+);base64,)/i.test(url) ? url : undefined}
            components={{
              h1: ({ node, ...props }) => <h1 {...props} id={headingByLine.get(node?.position?.start.line || 0)}/>,
              h2: ({ node, ...props }) => <h2 {...props} id={headingByLine.get(node?.position?.start.line || 0)}/>,
              h3: ({ node, ...props }) => <h3 {...props} id={headingByLine.get(node?.position?.start.line || 0)}/>,
              table: ({ node: _node, ...props }) => <div className="kr-table-wrap"><table {...props}/></div>,
              img: ({ node: _node, ...props }) => <ReaderImage {...props}/>,
              a: ({ node: _node, ...props }) => <ReaderLink {...props} onOpenNote={openLinkedNote} onHeading={target => {
                const heading = headings.find(item => item.id === target || item.id === `kr-${slug(target)}` || item.title === target);
                if (heading) goToHeading(heading.id);
              }}/>,
            }}>{displayContent}</ReactMarkdown>
  ), [displayContent, headingByLine, headings, goToHeading, openLinkedNote]);

  return <section ref={readerRef} className={`kr-reader ${showToc ? 'kr-with-toc' : ''}`} aria-label="知识库阅读区">
    <style>{`
      .kr-reader{background:var(--reader-bg,var(--surface,#fff));border:1px solid var(--border,#e9e7ee);border-radius:14px;min-height:calc(100dvh - 146px);min-width:0;color:var(--text-primary,#34323b);overflow:clip;container:knowledge-reader / inline-size}
      .kr-tabbar{height:46px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 15px;border-bottom:1px solid var(--border,#e9e7ee);background:var(--surface-secondary,#f7f6f9)}
      .kr-tabbar-left,.kr-tab,.kr-actions,.kr-breadcrumbs,.kr-meta{display:flex;align-items:center;gap:10px;min-width:0}
      .kr-tab{height:35px;align-self:flex-end;border-radius:8px 8px 0 0;background:var(--surface,#fff);padding:0 18px;font-size:14px;border:1px solid var(--border,#e9e7ee);border-bottom:0;max-width:430px}
      .kr-tab span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kr-tab svg{flex-shrink:0;color:var(--text-muted,#96929f)}
      .kr-reader .kr-icon{display:grid;place-items:center;width:29px;height:29px;border:0;border-radius:6px;cursor:pointer;background:transparent;color:var(--text-secondary,#77757f);flex-shrink:0;padding:0}
      .kr-reader .kr-icon:hover{color:var(--text-primary,#34323b);background:color-mix(in srgb,var(--text-primary,#34323b) 7%,transparent)}
      .kr-reader .kr-icon:focus-visible,.kr-reader a:focus-visible,.kr-reader button:focus-visible{outline:2px solid var(--accent,#9274e8);outline-offset:2px}
      .kr-reader .kr-icon.kr-favorited{color:#d2a14d}.kr-actions{gap:7px}
      .kr-tabbar-left{flex:1;overflow:hidden}.kr-actions{flex-shrink:0}.kr-tab{min-width:0}
      .kr-reader .kr-command{display:flex;align-items:center;gap:6px;height:30px;border:1px solid var(--border,#e9e7ee);border-radius:6px;padding:0 10px;background:var(--surface,#fff);color:var(--text-secondary,#77757f);font:inherit;font-size:14px;cursor:pointer;white-space:nowrap}.kr-reader .kr-command:hover{color:var(--accent,#9274e8);border-color:var(--accent,#9274e8)}
      .kr-reader .kr-delete:hover{color:#df6876;background:color-mix(in srgb,#df6876 10%,transparent)}
      .kr-permissions{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;padding:12px 14px;border:1px solid var(--border,#e9e7ee);border-radius:8px;background:var(--surface-secondary,#f7f6f9);margin:-14px 0 26px;font-size:12px;line-height:1.7;color:var(--text-secondary,#77757f)}
      .kr-permission-label,.kr-sharing-control{display:flex;align-items:center;gap:7px}.kr-permission-label svg{flex-shrink:0;color:var(--text-muted,#96929f)}.kr-permission-label.kr-collaborative svg{color:var(--accent,#9274e8)}
      .kr-sharing-control{cursor:pointer;user-select:none}.kr-sharing-toggle{border:0;width:30px;height:18px;flex-shrink:0;border-radius:12px;padding:2px;background:var(--text-muted,#96929f);cursor:pointer;transition:background .15s;display:flex;align-items:center}.kr-sharing-toggle[aria-checked=true]{background:var(--accent,#9274e8)}.kr-sharing-toggle>span{height:14px;width:14px;border-radius:50%;background:white;box-shadow:0 1px 3px #0002;transform:translateX(0);transition:transform .15s}.kr-sharing-toggle[aria-checked=true]>span{transform:translateX(12px)}.kr-sharing-toggle:disabled{opacity:.6;cursor:wait}.kr-sharing-busy{animation:kr-spin 1s linear infinite}.kr-sharing-error{width:100%;color:#df6876;margin:0;font-size:12px}@keyframes kr-spin{to{transform:rotate(360deg)}}
      .kr-breadcrumbs{padding:15px 27px 0;color:var(--text-muted,#96929f);font-size:12px;flex-wrap:wrap;gap:5px;line-height:1.7}
      .kr-breadcrumbs .kr-path{overflow-wrap:anywhere}.kr-breadcrumbs>svg{flex-shrink:0}.kr-breadcrumbs>span:last-child{color:var(--text-secondary,#77757f)}
      .kr-workspace{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;min-width:0}.kr-document{grid-column:1;grid-row:1}.kr-with-toc .kr-document{grid-row:2}
      .kr-document{box-sizing:border-box;width:100%;max-width:none;min-width:0;margin:0 auto;padding:36px min(var(--reading-page-margin,48px),max(12px,calc((100cqw - 240px)/2))) 28px}
      .kr-title{display:block;font-size:27px!important;font-weight:700!important;line-height:1.45!important;letter-spacing:-.5px;margin:0 0 12px!important;color:var(--text-primary,#34323b);overflow-wrap:anywhere}
      .kr-meta{font-size:12px;line-height:1.7;color:var(--text-muted,#96929f);flex-wrap:wrap;gap:6px 11px;margin-bottom:32px}
      .kr-meta .kr-dot{font-size:12px;opacity:.6;flex-shrink:0}.kr-meta>span{min-width:0}.kr-meta .kr-author,.kr-meta .kr-updated{white-space:nowrap}.kr-folder-path{display:inline-flex;align-items:flex-start;gap:6px;max-width:100%;min-width:0}.kr-folder-path>svg{margin-top:3px;flex-shrink:0}.kr-folder-path>span{min-width:0;overflow-wrap:anywhere}
      .kr-markdown{font-size:var(--reading-font-size,14px);line-height:1.95;overflow-wrap:break-word;color:var(--text-primary,#34323b)}
      .kr-markdown>*:first-child{margin-top:0}.kr-markdown p,.kr-markdown ul,.kr-markdown ol{margin:0 0 18px}.kr-markdown li{margin:4px 0}.kr-markdown li>p{margin-bottom:8px}
      .kr-markdown h1{display:block;font-size:calc(var(--reading-font-size,14px) + 13px);font-weight:700;line-height:1.5;margin:36px 0 20px;color:var(--text-primary,#34323b)}.kr-markdown h2,.kr-markdown h3,.kr-markdown h4,.kr-markdown h5,.kr-markdown h6{font-size:calc(var(--reading-font-size,14px) + 1.5px);font-weight:600;line-height:1.7;margin:32px 0 14px;color:var(--text-primary,#34323b)}
      .kr-markdown h3{color:var(--text-secondary,#77757f)}.kr-markdown h1,.kr-markdown h2,.kr-markdown h3{scroll-margin-top:28px}
      .kr-markdown a{color:var(--accent,#9274e8);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--accent,#9274e8) 40%,transparent);text-underline-offset:3px}
      .kr-markdown strong{font-weight:600;color:var(--text-primary,#34323b)}.kr-markdown img{max-width:100%;height:auto;border-radius:6px;display:block;margin:22px auto}
      .kr-asset-state{font-size:12px;line-height:1.8;color:var(--text-muted,#96929f)}
      .kr-markdown ul,.kr-markdown ol{padding-left:24px}.kr-markdown blockquote{margin:22px 0;padding:10px 18px;border-left:3px solid var(--accent,#9274e8);background:color-mix(in srgb,var(--accent,#9274e8) 6%,var(--surface,#fff));border-radius:0 6px 6px 0;color:var(--text-secondary,#77757f)}
      .kr-markdown blockquote>p:last-child{margin:0}.kr-markdown pre{overflow:auto;max-width:100%;font-size:max(12px,calc(var(--reading-font-size,14px) - 2px));line-height:1.8;padding:17px 20px;border-radius:8px;border:1px solid var(--border,#e9e7ee);background:var(--surface-secondary,#f7f6f9);margin:22px 0}
      .kr-markdown code{font-family:'Cascadia Code','SFMono-Regular',Consolas,monospace;font-size:max(12px,calc(var(--reading-font-size,14px) - 2px));background:var(--surface-secondary,#f7f6f9);padding:2px 5px;border-radius:4px;color:var(--accent,#9274e8)}
      .kr-markdown pre code{padding:0;background:transparent;color:var(--text-primary,#34323b);font-size:inherit}.kr-markdown hr{border:0;border-top:1px solid var(--border,#e9e7ee);margin:30px 0}
      .kr-markdown .kr-table-wrap{overflow-x:auto;width:100%;margin:20px 0}.kr-markdown table{width:100%;border-collapse:collapse;font-size:inherit;line-height:1.8}.kr-markdown th,.kr-markdown td{padding:9px 12px;border:1px solid var(--border,#e9e7ee);text-align:left}.kr-markdown th{font-weight:600;background:var(--surface-secondary,#f7f6f9)}
      .kr-markdown .katex-display{overflow-x:auto;overflow-y:hidden;padding:8px 0;margin:24px 0}.kr-markdown .katex{font-size:1.1em}.kr-markdown input[type=checkbox]{accent-color:var(--accent,#9274e8);margin-right:7px}
      .kr-tags{display:flex;flex-wrap:wrap;gap:7px;margin:30px 0 24px}.kr-tags span{color:var(--accent,#9274e8);font-size:12px;line-height:1.7;padding:3px 8px;background:color-mix(in srgb,var(--accent,#9274e8) 9%,transparent);border-radius:5px}
      .kr-toc{grid-column:1;grid-row:1;box-sizing:border-box;border-bottom:1px solid var(--border,#e9e7ee);margin:18px clamp(24px,3.8cqw,48px) 0;padding:0 0 16px;min-width:0;max-height:210px;overflow:auto;overscroll-behavior:contain}
      .kr-toc-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--text-muted,#96929f);margin-bottom:16px}
      .kr-toc nav{display:flex;flex-direction:column;gap:2px}.kr-toc nav button{font-size:12px;line-height:1.7;text-align:left;padding:6px 7px;border:0;border-radius:5px;background:transparent;color:var(--text-secondary,#77757f);cursor:pointer;overflow-wrap:anywhere}
      .kr-toc nav button:hover{background:var(--surface-secondary,#f7f6f9);color:var(--text-primary,#34323b)}.kr-toc nav .kr-current{color:var(--accent,#9274e8);background:color-mix(in srgb,var(--accent,#9274e8) 9%,transparent)}
      .kr-toc-empty{font-size:12px;color:var(--text-muted,#96929f);line-height:1.9;margin:0}.kr-backlinks{margin:34px 0 8px;padding-top:20px;border-top:1px solid var(--border,#e9e7ee)}
      .kr-backlinks h2{font-size:15.5px;font-weight:600;display:flex;align-items:center;gap:8px;margin:0 0 13px;color:var(--text-secondary,#77757f)}.kr-backlinks h2 span{font-size:12px;font-weight:400;color:var(--text-muted,#96929f);margin-left:3px}
      .kr-backlinks-list{display:grid;gap:7px}.kr-backlinks-list button{display:flex;gap:10px;align-items:flex-start;text-align:left;background:var(--surface-secondary,#f7f6f9);border:1px solid var(--border,#e9e7ee);border-radius:7px;padding:11px 12px;color:var(--text-primary,#34323b);cursor:pointer;font-size:14px;width:100%;min-width:0}
      .kr-backlinks-list button>svg{flex-shrink:0;margin-top:3px;color:var(--text-muted,#96929f)}.kr-backlinks-list button>span{min-width:0;overflow-wrap:anywhere}.kr-backlinks-list small{display:block;font-size:12px;color:var(--text-muted,#96929f);margin-top:3px;line-height:1.6}
      .kr-backlinks p{font-size:12px;color:var(--text-muted,#96929f);margin:0;line-height:1.8}.kr-status{display:flex;justify-content:flex-end;gap:15px;padding:9px 19px;border-top:1px solid var(--border,#e9e7ee);font-size:12px;color:var(--text-muted,#96929f);font-variant-numeric:tabular-nums;background:var(--surface-secondary,#f7f6f9)}
      @container knowledge-reader (min-width:1040px){.kr-with-toc .kr-workspace{grid-template-columns:minmax(0,1fr) 224px}.kr-with-toc .kr-document{grid-row:1}.kr-toc{grid-column:2;grid-row:1;border-left:1px solid var(--border,#e9e7ee);border-bottom:0;margin:31px 0 28px;padding:0 15px;align-self:start;position:sticky;top:25px;max-height:calc(100dvh - 80px)}}
      @container knowledge-reader (max-width:600px){.kr-reader{border-radius:10px}.kr-document{padding-top:25px;padding-bottom:20px}.kr-breadcrumbs{padding:13px 20px 0}.kr-tabbar{padding:0 9px;gap:7px}.kr-tab{padding:0 11px}.kr-actions{gap:2px}.kr-reader .kr-command{padding:0 6px}.kr-command>span{display:none}.kr-status{gap:12px;padding:9px 13px;flex-wrap:wrap}.kr-meta{margin-bottom:25px}.kr-toc{margin-left:20px;margin-right:20px}}
    `}</style>
    <header className="kr-tabbar">
      <div className="kr-tabbar-left"><button type="button" className="kr-icon" onClick={onClose} aria-label="返回知识库" title="返回知识库"><ArrowLeft size={17}/></button>{tabs || <div className="kr-tab"><FileText size={15}/><span>{note.title}</span></div>}</div>
      <div className="kr-actions">{canEdit && <button type="button" className="kr-command" onClick={onEdit} aria-label="编辑笔记" title="编辑笔记"><PencilLine size={15}/><span>编辑</span></button>}{canDelete && <button type="button" className="kr-icon kr-delete" onClick={onDelete} aria-label="删除笔记" title="删除笔记"><Trash2 size={16}/></button>}<button type="button" className={`kr-icon ${favorite ? 'kr-favorited' : ''}`} onClick={onToggleFavorite} aria-label={favorite ? '取消收藏当前笔记' : '收藏当前笔记'} title={favorite ? '取消收藏' : '收藏'}><Star size={17} fill={favorite ? 'currentColor' : 'none'}/></button><button type="button" className="kr-icon" onClick={() => setTocMode(showToc ? 'closed' : 'open')} aria-label={showToc ? '收起文档大纲' : '展开文档大纲'} aria-expanded={showToc} aria-controls="kr-document-outline" title="文档大纲">{showToc ? <PanelRightClose size={17}/> : <List size={17}/>}</button></div>
    </header>
    <div className="kr-breadcrumbs"><span>知识库</span><ChevronRight size={12}/>{folder && <><span className="kr-path">{folder.replace(/\//g, ' / ')}</span><ChevronRight size={12}/></>}<span>{note.title}</span></div>
    <div className="kr-workspace">
      <div className="kr-document">
        <h1 className="kr-title">{note.title}</h1>
        <div className="kr-meta">
          <span className="kr-folder-path" title={folder || '知识库根目录'}><Folder size={13}/><span>{folder || '知识库根目录'}</span></span>
          <span className="kr-dot">·</span><span className="kr-author">{note.author}</span><span className="kr-dot">·</span><span className="kr-updated">更新于 {displayDate(note.updatedAt)}</span>
        </div>
        <section className="kr-permissions" aria-label="笔记权限">
          <span className={`kr-permission-label ${collaborative ? 'kr-collaborative' : ''}`}>{collaborative ? <UsersRound size={14}/> : canEdit ? <PencilLine size={14}/> : <LockKeyhole size={14}/>}<span>{collaborative ? '协作笔记 · 所有成员可编辑' : canEdit ? '作者可编辑' : '只读 · 仅作者可修改'}</span></span>
          {canManageSharing && <label className="kr-sharing-control"><button className="kr-sharing-toggle" type="button" role="switch" aria-label="允许所有成员编辑" aria-checked={collaborative} disabled={sharingBusy} onClick={() => { void toggleSharing(); }}><span/></button><span>允许所有成员编辑</span>{sharingBusy && <LoaderCircle className="kr-sharing-busy" size={13} aria-label="正在更新权限"/>}</label>}
          {sharingError && <p className="kr-sharing-error" role="alert">{sharingError}</p>}
        </section>
        <article className="kr-markdown" ref={articleRef}>
          {renderedMarkdown}
        </article>
        {note.tags.length > 0 && <div className="kr-tags" aria-label="笔记标签">{note.tags.map(tag => <span key={tag}># {tag}</span>)}</div>}
        <section className="kr-backlinks" aria-label="反向链接"><h2><Link2 size={16}/>反向链接<span>{backlinks.length.toLocaleString('zh-CN')}</span></h2>
          {backlinks.length > 0 ? <div className="kr-backlinks-list">{backlinks.map(link => <button type="button" key={link.id} onClick={() => onOpenNote(link.id)}><FileText size={15}/><span>{link.title}<small>{getFolderPath(link) || '知识库根目录'}</small></span></button>)}</div> : <p>{backlinksReady?'还没有其他笔记链接到这里。':'正在读取反向链接…'}</p>}
        </section>
      </div>
      {showToc && <aside id="kr-document-outline" className="kr-toc" aria-label="文档大纲"><div className="kr-toc-title"><List size={14}/>文档大纲</div>{headings.length ? <nav>{headings.map(heading => <button type="button" key={heading.id} className={activeHeading === heading.id ? 'kr-current' : ''} style={{ paddingLeft: 7 + (heading.level - 1) * 12 }} onClick={() => goToHeading(heading.id)}>{heading.title}</button>)}</nav> : <p className="kr-toc-empty">这篇笔记还没有标题。</p>}</aside>}
    </div>
    <footer className="kr-status"><span>{backlinks.length.toLocaleString('zh-CN')} 条反向链接</span><span>{wordCount.toLocaleString('zh-CN')} 字</span><span>{note.content.length.toLocaleString('zh-CN')} 个字符</span></footer>
  </section>;
}
