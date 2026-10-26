import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Trash2, X } from 'lucide-react';

export default function DeleteFolderDialog({ path, noteCount, childFolderCount, onClose, onConfirm }: {
  path: string;
  noteCount: number;
  childFolderCount: number;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cancel.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending.current) close.current();
      if (event.key !== 'Tab') return;
      const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
      if (!buttons.length) { event.preventDefault(); return; }
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const submit = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await onConfirm(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败，请稍后重试。'); }
    finally { pending.current = false; setBusy(false); }
  };
  const number = (value: number) => value.toLocaleString('en-US');
  return <div className="delete-folder-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !pending.current) onClose(); }}>
    <section className="delete-folder-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="delete-folder-title" aria-describedby="delete-folder-description" aria-busy={busy}>
      <header><span className="delete-folder-icon"><Trash2 size={20}/></span><h2 id="delete-folder-title">删除文件夹</h2><button className="icon-button" disabled={busy} aria-label="关闭删除文件夹窗口" onClick={onClose}><X size={18}/></button></header>
      <p id="delete-folder-description">确定删除「<strong>{path}</strong>」吗？将永久删除此文件夹、<strong>{number(childFolderCount)} 个子文件夹</strong>和 <strong>{number(noteCount)} 篇笔记</strong>。删除后无法恢复，指向这些文档的链接也将失效。</p>
      {error && <p className="delete-folder-error" role="alert">{error}</p>}
      <footer><button ref={cancel} className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button delete-folder-confirm" disabled={busy} onClick={() => void submit()}>{busy ? <LoaderCircle size={16} className="delete-folder-spin"/> : <Trash2 size={16}/>}确认删除</button></footer>
    </section>
    <style>{`.delete-folder-backdrop{position:fixed;inset:0;z-index:1400;display:grid;grid-template-columns:minmax(0,1fr);place-items:center;box-sizing:border-box;padding:20px;background:#1118;backdrop-filter:blur(5px)}.delete-folder-dialog{box-sizing:border-box;width:440px;min-width:0;max-width:100%;max-height:calc(100dvh - 40px);overflow:auto;background:var(--surface,#fff);border:1px solid var(--border,#eee);border-radius:18px;padding:24px;color:var(--text-primary,#333);box-shadow:0 24px 80px #0003}.delete-folder-dialog header{display:flex;align-items:center;gap:10px}.delete-folder-dialog header .icon-button{margin-left:auto;flex-shrink:0}.delete-folder-dialog h2{font-size:15.5px;font-weight:600;margin:0}.delete-folder-icon{display:grid;place-items:center;flex-shrink:0;width:38px;height:38px;background:#dc66661a;border-radius:11px;color:#d46c74}.delete-folder-dialog p{font-size:14px;line-height:1.9;color:var(--text-muted,#888);overflow-wrap:anywhere;margin:20px 0;max-width:36em}.delete-folder-dialog strong{font-weight:600;color:var(--text-primary,#333)}.delete-folder-dialog footer{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}.delete-folder-confirm{background:#c65d69;color:#fff}.delete-folder-confirm:hover{background:#b64f5b}.delete-folder-dialog .delete-folder-error{font-size:12px;color:#d46c74}.delete-folder-dialog button:disabled{opacity:.5;cursor:wait}.delete-folder-spin{animation:delete-folder-spin 1s linear infinite}@keyframes delete-folder-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.delete-folder-spin{animation:none}}`}</style>
  </div>;
}
