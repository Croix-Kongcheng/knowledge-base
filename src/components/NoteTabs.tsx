import { useEffect, useRef, type KeyboardEvent } from 'react';
import { FileText, Pin, X } from 'lucide-react';
import './NoteTabs.css';

export interface NoteTab {
  id: string;
  title: string;
  path?: string;
  preview: boolean;
}

interface NoteTabsProps {
  tabs: NoteTab[];
  activeId?: string | null;
  onSelect: (id: string) => void;
  onPin: (id: string) => void;
  onClose: (id: string) => void;
}

export default function NoteTabs({ tabs, activeId, onSelect, onPin, onClose }: NoteTabsProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll only the tab strip; scrollIntoView would also jump the document.
    const revealActive = () => {
      const button = activeId ? buttons.current.get(activeId) : null;
      const tab = button?.parentElement;
      const strip = stripRef.current;
      if (!tab || !strip) return;
      if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft;
      else if (tab.offsetLeft + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = tab.offsetLeft + tab.offsetWidth - strip.clientWidth;
    };
    revealActive();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(revealActive);
    if (stripRef.current) observer?.observe(stripRef.current);
    if (!observer) window.addEventListener('resize', revealActive);
    return () => { observer?.disconnect(); window.removeEventListener('resize', revealActive); };
  }, [activeId, tabs.length]);

  const focusAfterNavigation = (id: string) => requestAnimationFrame(() => {
    const requested = document.getElementById(`note-tab-${encodeURIComponent(id)}`);
    const selected = document.querySelector<HTMLButtonElement>('.nt-tab[aria-selected="true"]');
    (requested?.getAttribute('aria-selected') === 'true' ? requested : selected || requested)?.focus({ preventScroll: true });
  });

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      const next = tabs[nextIndex];
      if (next) {
        onSelect(next.id);
        focusAfterNavigation(next.id);
      }
    } else if (event.key === 'Delete' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w')) {
      event.preventDefault();
      const next = tabs[index + 1] || tabs[index - 1];
      onClose(tabs[index].id);
      if (next) focusAfterNavigation(next.id);
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      onPin(tabs[index].id);
    }
  };

  if (!tabs.length) return null;
  return <div className="nt-bar">
    <div ref={stripRef} className="nt-strip" role="tablist" aria-label="打开的笔记" aria-orientation="horizontal">
      {tabs.map((tab, index) => <div key={tab.id} className={`nt-item ${tab.id === activeId ? 'nt-active' : ''} ${tab.preview ? 'nt-preview' : ''}`} role="presentation" data-preview={tab.preview}>
        <button ref={button => { if (button) buttons.current.set(tab.id, button); else buttons.current.delete(tab.id); }} type="button" role="tab"
          id={`note-tab-${encodeURIComponent(tab.id)}`} aria-selected={tab.id === activeId} aria-label={tab.title} tabIndex={tab.id === activeId || (!activeId && index === 0) ? 0 : -1}
          className="nt-tab" title={`${tab.path || tab.title}${tab.preview ? '（预览，双击固定）' : ''}`}
          onClick={() => onSelect(tab.id)} onDoubleClick={() => onPin(tab.id)} onKeyDown={event => onKeyDown(event, index)}>
          <FileText size={14} aria-hidden="true"/><span className="nt-title">{tab.title}</span>
        </button>
        {tab.preview && <button type="button" className="nt-action nt-pin" aria-label={`固定预览文档 ${tab.title}`} title="固定预览文档（双击标签也可固定）" onClick={() => onPin(tab.id)}><Pin size={13} aria-hidden="true"/></button>}
        <button type="button" className="nt-action nt-close" aria-label={`关闭 ${tab.title}`} title="关闭笔记" onClick={() => onClose(tab.id)}><X size={14} aria-hidden="true"/></button>
      </div>)}
    </div>
  </div>;
}
