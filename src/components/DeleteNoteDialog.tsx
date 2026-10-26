import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Trash2, X } from 'lucide-react';
import type { ImportedNote } from '../lib/importer';

export default function DeleteNoteDialog({ note, onClose, onConfirm }: {
  note: ImportedNote;
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
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  const submit = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await onConfirm(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败，请稍后重试。'); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="delete-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="delete-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="delete-note-title" aria-describedby="delete-note-description">
      <header><span className="delete-icon"><Trash2 size={20}/></span><h2 id="delete-note-title">删除笔记</h2><button className="icon-button" disabled={busy} aria-label="关闭删除窗口" onClick={onClose}><X size={18}/></button></header>
      <p id="delete-note-description">确定删除「<strong>{note.title}</strong>」吗？删除后无法恢复，指向此文档的链接也将失效。</p>
      {error&&<p className="delete-error" role="alert">{error}</p>}
      <footer><button ref={cancel} className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button delete-confirm" disabled={busy} onClick={()=>void submit()}>{busy?<LoaderCircle size={16} className="delete-spin"/>:<Trash2 size={16}/>}确认删除</button></footer>
    </section>
    <style>{`.delete-backdrop{position:fixed;inset:0;z-index:1400;display:grid;place-items:center;padding:20px;background:#1118;backdrop-filter:blur(5px)}.delete-dialog{width:440px;max-width:100%;background:var(--surface,#fff);border:1px solid var(--border,#eee);border-radius:18px;padding:24px;color:var(--text-primary,#333);box-shadow:0 24px 80px #0003}.delete-dialog header{display:flex;align-items:center;gap:10px}.delete-dialog header .icon-button{margin-left:auto}.delete-dialog h2{font-size:15.5px;font-weight:600;margin:0}.delete-icon{display:grid;place-items:center;width:38px;height:38px;background:#dc66661a;border-radius:11px;color:#d46c74}.delete-dialog p{font-size:14px;line-height:1.9;color:var(--text-muted,#888);overflow-wrap:anywhere;margin:20px 0;max-width:36em}.delete-dialog strong{font-weight:600;color:var(--text-primary,#333)}.delete-dialog footer{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}.delete-confirm{background:#c65d69;color:#fff}.delete-confirm:hover{background:#b64f5b}.delete-dialog .delete-error{font-size:12px;color:#d46c74}.delete-dialog button:disabled{opacity:.5;cursor:wait}.delete-spin{animation:delete-spin 1s linear infinite}@keyframes delete-spin{to{transform:rotate(360deg)}}`}</style>
  </div>;
}
