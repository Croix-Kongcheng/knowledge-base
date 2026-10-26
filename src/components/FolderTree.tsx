import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, ChevronsDownUp, Crosshair, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, LoaderCircle, PencilLine, Search, Trash2, X } from 'lucide-react';
import type { ImportedNote } from '../lib/importer';
import { buildFolderTree, comparePaths, getFolderPath, getNotePath, type FolderNode } from '../lib/library';

interface FolderTreeProps {
  notes: ImportedNote[];
  selectedPath: string;
  onSelect: (path: string) => void;
  onOpenNote?: (id: string) => void;
  onPinNote?: (id: string) => void;
  activeNoteId?: string;
  /** File explorer mode: opening folders preserves the current document. */
  browseOnly?: boolean;
  showToolbar?: boolean;
  canMoveNote?: (note: ImportedNote) => boolean;
  onMoveNote?: (id: string, folder: string) => Promise<void>;
  extraFolders?: { path: string; ownerId: string }[];
  canCreate?: boolean;
  canRenameFolder?: (path: string) => boolean;
  canDeleteFolder?: (path: string) => boolean;
  canRenameNote?: (note: ImportedNote) => boolean;
  canDeleteNote?: (note: ImportedNote) => boolean;
  onCreateNote?: (folder: string, name: string) => Promise<void>;
  onCreateFolder?: (parent: string, name: string) => Promise<void>;
  onRenameFolder?: (path: string, name: string) => Promise<void>;
  onDeleteFolder?: (path: string) => void;
  onRenameNote?: (id: string, name: string) => Promise<void>;
  onDeleteNote?: (id: string) => void;
}

const NOTE_DRAG_TYPE = 'application/x-zhiyu-note';
const sameFolder = (left: string, right: string) => left.normalize('NFC').toLocaleLowerCase() === right.normalize('NFC').toLocaleLowerCase();
type ContextTarget = { kind: 'root' } | { kind: 'folder'; path: string } | { kind: 'note'; id: string };
type TreeMenu = { target: ContextTarget; x: number; y: number; origin: HTMLElement };
type TreeEdit = {
  kind: 'create-note' | 'create-folder' | 'rename-note' | 'rename-folder';
  parent: string;
  id?: string;
  path?: string;
  value: string;
  error: string;
  token: number;
  origin: HTMLElement;
};
const contextShortcut = (event: KeyboardEvent<HTMLElement>) => event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
const renamedPath = (path: string, previous: string, next: string) => {
  const parts = path.split('/');
  const prefix = previous.split('/');
  return parts.length >= prefix.length && prefix.every((part, index) => sameFolder(parts[index], part))
    ? [...next.split('/'), ...parts.slice(prefix.length)].join('/') : path;
};

export default function FolderTree({ notes, selectedPath, onSelect, onOpenNote, onPinNote, activeNoteId, browseOnly = false, showToolbar = false, canMoveNote, onMoveNote, extraFolders, canCreate = false, canRenameFolder, canDeleteFolder, canRenameNote, canDeleteNote, onCreateNote, onCreateFolder, onRenameFolder, onDeleteFolder, onRenameNote, onDeleteNote }: FolderTreeProps) {
  const folders = useMemo(() => buildFolderTree(notes, extraFolders?.map(folder => folder.path)), [notes, extraFolders]);
  const rootNotes = useMemo(() => notes.filter(note => !getFolderPath(note)).sort((a, b) => comparePaths(a.title, b.title)), [notes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const treeRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const noteButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastAutoReveal = useRef<string>();
  const activeNote = useMemo(() => notes.find(note => note.id === activeNoteId), [notes, activeNoteId]);
  const [draggedNoteId, setDraggedNoteId] = useState<string | null>(null);
  const [dropPath, setDropPath] = useState<string | null>(null);
  const [pendingMoveId, setPendingMoveId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const draggedNote = notes.find(note => note.id === draggedNoteId);
  const dragRef = useRef<{ id: string; token: string } | null>(null);
  const pendingRef = useRef<string | null>(null);
  const hoverRef = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const scrollSpeed = useRef({ x: 0, y: 0 });
  const suppressClickUntil = useRef(0);
  const mounted = useRef(true);
  const folderButtons = useRef(new Map<string, HTMLButtonElement>());
  const [menu, setMenu] = useState<TreeMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [edit, setEdit] = useState<TreeEdit | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const editBusyRef = useRef(false);
  const editSequence = useRef(0);
  const editInput = useRef<HTMLInputElement>(null);
  const hasActions = Boolean(onCreateNote || onCreateFolder || onRenameFolder || onDeleteFolder || onRenameNote || onDeleteNote);

  const stopHover = () => {
    if (hoverRef.current) clearTimeout(hoverRef.current.timer);
    hoverRef.current = null;
  };

  const stopScrolling = () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    scrollSpeed.current = { x: 0, y: 0 };
  };

  const finishDrag = () => {
    dragRef.current = null;
    stopHover();
    stopScrolling();
    setDraggedNoteId(null);
    setDropPath(null);
    suppressClickUntil.current = Date.now() + 350;
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopHover();
      stopScrolling();
    };
  }, []);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current;
    const box = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - box.height - 8))}px`;
    (element.querySelector<HTMLButtonElement>('button:not(:disabled)') || element).focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) setMenu(null); };
    const resize = () => setMenu(null);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [menu]);

  useLayoutEffect(() => {
    if (!edit || !editInput.current) return;
    editInput.current.focus({ preventScroll: true });
    editInput.current.select();
    editInput.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [edit?.token]);

  useEffect(() => {
    if (!draggedNoteId) return;
    const onEscape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') finishDrag(); };
    const onWindowDragEnd = () => finishDrag();
    window.addEventListener('keydown', onEscape);
    window.addEventListener('dragend', onWindowDragEnd);
    return () => {
      window.removeEventListener('keydown', onEscape);
      window.removeEventListener('dragend', onWindowDragEnd);
    };
  }, [draggedNoteId]);

  const movable = (note: ImportedNote) => Boolean(onMoveNote && canMoveNote?.(note) && !pendingRef.current && !edit);

  const internalDrag = (event: DragEvent<HTMLElement>) => Boolean(dragRef.current && !pendingRef.current && Array.from(event.dataTransfer.types).includes(NOTE_DRAG_TYPE));

  const validDestination = (event: DragEvent<HTMLElement>, path: string) => {
    if (!internalDrag(event)) return false;
    const note = notes.find(item => item.id === dragRef.current?.id);
    return Boolean(note && movable(note) && !sameFolder(getFolderPath(note), path));
  };

  const startDrag = (event: DragEvent<HTMLButtonElement>, note: ImportedNote) => {
    if (!movable(note)) { event.preventDefault(); return; }
    setMenu(null);
    const drag = { id: note.id, token: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` };
    dragRef.current = drag;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(NOTE_DRAG_TYPE, JSON.stringify(drag));
    setDraggedNoteId(note.id);
    setAnnouncement(`正在拖动 ${note.title}，放到目标文件夹即可移动。`);
    suppressClickUntil.current = Date.now() + 350;
  };

  const dragOverDestination = (event: DragEvent<HTMLButtonElement>, path: string, isOpen = true) => {
    if (!validDestination(event, path)) {
      if (internalDrag(event)) event.dataTransfer.dropEffect = 'none';
      stopHover();
      setDropPath(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropPath(path);
    if (!isOpen && hoverRef.current?.path !== path) {
      stopHover();
      hoverRef.current = { path, timer: setTimeout(() => {
        if (dragRef.current) setFolderOpen(path, true);
        hoverRef.current = null;
      }, 600) };
    } else if (isOpen) stopHover();
  };

  const leaveDestination = (event: DragEvent<HTMLButtonElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    stopHover();
    setDropPath(null);
  };

  const dropNote = async (event: DragEvent<HTMLButtonElement>, path: string) => {
    if (!validDestination(event, path)) return;
    event.preventDefault();
    event.stopPropagation();
    const drag = dragRef.current;
    let payload: { id?: string; token?: string };
    try { payload = JSON.parse(event.dataTransfer.getData(NOTE_DRAG_TYPE)); } catch { finishDrag(); return; }
    if (!drag || payload.id !== drag.id || payload.token !== drag.token) { finishDrag(); return; }
    const note = notes.find(item => item.id === drag.id);
    if (!note || !onMoveNote) { finishDrag(); return; }
    finishDrag();
    pendingRef.current = note.id;
    setPendingMoveId(note.id);
    setAnnouncement(`正在移动 ${note.title}。`);
    try {
      await onMoveNote(note.id, path);
      if (mounted.current) {
        openAncestors(path);
        setAnnouncement(`${note.title} 已移到 ${path || '知识库根目录'}。`);
        requestAnimationFrame(() => {
          if (mounted.current) noteButtons.current.get(note.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
      }
    } catch {
      // The caller owns API errors and toasts; keep the source tree unchanged.
      if (mounted.current) setAnnouncement(`${note.title} 移动未完成，文档位置未改变。`);
    } finally {
      pendingRef.current = null;
      if (mounted.current) setPendingMoveId(null);
    }
  };

  const autoScroll = (event: DragEvent<HTMLDivElement>) => {
    if (!internalDrag(event) || !scrollRef.current) return;
    const area = scrollRef.current.getBoundingClientRect();
    const speed = (value: number, start: number, end: number) => value < start + 36 ? -Math.ceil(Math.min(1, (start + 36 - value) / 36) * 13) : value > end - 36 ? Math.ceil(Math.min(1, (value - end + 36) / 36) * 13) : 0;
    scrollSpeed.current = { x: speed(event.clientX, area.left, area.right), y: speed(event.clientY, area.top, area.bottom) };
    if (!scrollSpeed.current.x && !scrollSpeed.current.y) { stopScrolling(); return; }
    if (scrollFrame.current !== null) return;
    const tick = () => {
      if (!dragRef.current || !scrollRef.current) { stopScrolling(); return; }
      scrollRef.current.scrollBy(scrollSpeed.current.x, scrollSpeed.current.y);
      scrollFrame.current = requestAnimationFrame(tick);
    };
    scrollFrame.current = requestAnimationFrame(tick);
  };

  const openAncestors = (path: string) => {
    const parts = path.split('/').filter(Boolean);
    const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    setExpanded(previous => new Set([...previous, ...ancestors]));
    setCollapsed(previous => new Set([...previous].filter(item => !ancestors.includes(item))));
  };

  useEffect(() => {
    // Polling, edits and folder refreshes must not reopen a folder the user closed.
    const key = browseOnly ? activeNoteId || '' : `${activeNoteId || ''}:${selectedPath}`;
    if (lastAutoReveal.current === key || (activeNoteId && !activeNote)) return;
    lastAutoReveal.current = key;
    openAncestors(activeNote ? getFolderPath(activeNote) : selectedPath);
  }, [activeNote, activeNoteId, browseOnly, selectedPath]);

  const allPaths = useMemo(() => {
    const result: string[] = [];
    const visit = (items: FolderNode[]) => items.forEach(folder => { result.push(folder.path); visit(folder.children); });
    visit(folders);
    return result;
  }, [folders]);

  const term = query.trim().normalize('NFC').toLocaleLowerCase();
  const matches = (value: string) => value.normalize('NFC').toLocaleLowerCase().includes(term);
  const filterFolder = (folder: FolderNode): FolderNode | null => {
    if (!term || matches(folder.path)) return folder;
    const children = folder.children.map(filterFolder).filter((item): item is FolderNode => item !== null);
    const matchingNotes = folder.notes.filter(note => matches(note.title));
    return children.length || matchingNotes.length ? { ...folder, children, notes: matchingNotes } : null;
  };
  const visibleFolders = folders.map(filterFolder).filter((item): item is FolderNode => item !== null);
  const visibleRootNotes = rootNotes.filter(note => !term || matches(note.title));

  const setFolderOpen = (path: string, open: boolean) => {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (open) next.delete(path); else next.add(path);
      return next;
    });
    if (open) setExpanded(previous => new Set([...previous, path]));
  };

  const openMenu = (target: ContextTarget, origin: HTMLElement, x?: number, y?: number) => {
    if (!hasActions || dragRef.current) return;
    const box = origin.getBoundingClientRect();
    setMenu({ target, origin, x: x ?? box.left + 20, y: y ?? box.bottom });
  };

  const contextMenu = (event: MouseEvent<HTMLElement>, target: ContextTarget) => {
    if (!hasActions) return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(target, event.currentTarget, event.clientX, event.clientY);
  };

  const keyboardMenu = (event: KeyboardEvent<HTMLElement>, target: ContextTarget) => {
    if (!hasActions || !contextShortcut(event)) return false;
    event.preventDefault();
    event.stopPropagation();
    openMenu(target, event.currentTarget);
    return true;
  };

  const restoreFocus = (origin: HTMLElement) => {
    requestAnimationFrame(() => {
      if (mounted.current) (origin.isConnected ? origin : scrollRef.current)?.focus({ preventScroll: true });
    });
  };

  const beginEdit = (kind: TreeEdit['kind'], targetMenu: TreeMenu) => {
    if (editBusyRef.current || pendingRef.current) return;
    const target = targetMenu.target;
    const note = target.kind === 'note' ? notes.find(value => value.id === target.id) : undefined;
    const path = target.kind === 'folder' ? target.path : undefined;
    const parent = note ? getFolderPath(note) : kind === 'rename-folder' ? path?.split('/').slice(0, -1).join('/') || '' : path || '';
    const value = kind === 'rename-note' && note ? getNotePath(note).split('/').pop()!.replace(/\.(?:md|markdown)$/i, '') : kind === 'rename-folder' ? path?.split('/').pop() || '' : '';
    setMenu(null);
    setQuery('');
    openAncestors(kind === 'rename-folder' ? parent : path || parent);
    setEdit({ kind, parent, id: note?.id, path, value, error: '', token: ++editSequence.current, origin: targetMenu.origin });
  };

  const cancelEdit = () => {
    if (!edit || editBusyRef.current) return;
    const previous = edit;
    setEdit(null);
    requestAnimationFrame(() => {
      const target = previous.kind === 'rename-note' ? noteButtons.current.get(previous.id!) : previous.kind === 'rename-folder' ? folderButtons.current.get(previous.path!) : previous.origin;
      if (mounted.current) (target?.isConnected ? target : scrollRef.current)?.focus({ preventScroll: true });
    });
  };

  const saveEdit = async () => {
    if (!edit || editBusyRef.current || pendingRef.current) return;
    const operation = edit;
    const documentName = operation.kind.endsWith('note');
    const normalizedName = operation.value.normalize('NFC').trim();
    const name = documentName ? normalizedName.replace(/\.(?:md|markdown)$/i, '') : normalizedName;
    const maximumLength = documentName ? 252 : 255;
    if (!name || name === '.' || name === '..' || Array.from(name).length > maximumLength || /[\\/<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) || /[. ]$/.test(name)) {
      setEdit(previous => previous && { ...previous, error: !name ? '请输入名称。' : Array.from(name).length > maximumLength ? `名称最多包含 ${maximumLength} 个字符。` : '名称不能为 . 或 ..，不能以句点结尾或包含无效文件名字符。' });
      return;
    }
    const note = notes.find(value => value.id === operation.id);
    const allowed = operation.kind === 'create-note' ? canCreate && onCreateNote : operation.kind === 'create-folder' ? canCreate && onCreateFolder : operation.kind === 'rename-note' ? note && canRenameNote?.(note) && onRenameNote : operation.path && canRenameFolder?.(operation.path) && onRenameFolder;
    if (!allowed) { setEdit(previous => previous && { ...previous, error: '你没有执行此操作的权限。' }); return; }
    editBusyRef.current = true;
    setEditBusy(true);
    setEdit(previous => previous && { ...previous, error: '' });
    try {
      if (operation.kind === 'create-note') await onCreateNote!(operation.parent, name);
      else if (operation.kind === 'create-folder') await onCreateFolder!(operation.parent, name);
      else if (operation.kind === 'rename-note') await onRenameNote!(operation.id!, name);
      else await onRenameFolder!(operation.path!, name);
      if (!mounted.current) return;
      const destination = [operation.parent, name].filter(Boolean).join('/');
      if (operation.kind === 'rename-folder') {
        setExpanded(previous => new Set([...previous].map(path => renamedPath(path, operation.path!, destination))));
        setCollapsed(previous => new Set([...previous].map(path => renamedPath(path, operation.path!, destination))));
      } else if (operation.kind === 'create-folder') openAncestors(operation.parent);
      setEdit(null);
      setAnnouncement(operation.kind.startsWith('create') ? `${name} 已创建。` : `${name} 已重命名。`);
      if (operation.kind !== 'create-note') requestAnimationFrame(() => {
        if (!mounted.current) return;
        const target = operation.kind === 'rename-note' ? noteButtons.current.get(operation.id!) : folderButtons.current.get(destination);
        target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        target?.focus({ preventScroll: true });
      });
    } catch (cause) {
      if (mounted.current) {
        setEdit(previous => previous?.token === operation.token ? { ...previous, error: cause instanceof Error ? cause.message : '操作未完成，请重试。' } : previous);
        requestAnimationFrame(() => editInput.current?.focus({ preventScroll: true }));
      }
    } finally {
      editBusyRef.current = false;
      if (mounted.current) setEditBusy(false);
    }
  };

  const inlineRow = (operation: TreeEdit, level: number) => {
    const isFolder = operation.kind.endsWith('folder');
    const label = isFolder ? '文件夹名称' : '笔记名称';
    return <form className="ft-inline" style={{ paddingLeft: 27 + level * 12 }} aria-busy={editBusy} onSubmit={event => { event.preventDefault(); void saveEdit(); }}>
      <div className="ft-inline-row">{isFolder ? <Folder size={14} aria-hidden="true"/> : <FileText size={14} aria-hidden="true"/>}<input ref={editInput} aria-label={label} aria-invalid={Boolean(operation.error)} aria-describedby={operation.error ? `ft-name-error-${operation.token}` : undefined} title="按 Enter 确认，Esc 取消" placeholder={label} disabled={editBusy} value={operation.value} onChange={event => setEdit(previous => previous && { ...previous, value: event.target.value, error: '' })} onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); }
        else if (event.key === 'Enter') { event.preventDefault(); void saveEdit(); }
      }}/>{editBusy && <LoaderCircle size={13} className="ft-moving-icon" aria-label="正在保存名称"/>}</div>
      {operation.error && <p id={`ft-name-error-${operation.token}`} className="ft-inline-error" role="alert">{operation.error}</p>}
    </form>;
  };

  const focusRow = (event: KeyboardEvent<HTMLButtonElement>, folder?: FolderNode, isOpen = false) => {
    const button = event.currentTarget;
    const rows = [...(treeRef.current?.querySelectorAll<HTMLButtonElement>('.ft-row') || [])];
    const index = rows.indexOf(button);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1);
      rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
    } else if (event.key === 'ArrowRight' && folder) {
      event.preventDefault();
      if (!isOpen) setFolderOpen(folder.path, true);
      else rows[index + 1]?.focus();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (folder && isOpen) setFolderOpen(folder.path, false);
      else {
        const parentPath = folder ? folder.path.split('/').slice(0, -1).join('/') : button.dataset.parent;
        rows.find(row => row.dataset.folder === parentPath)?.focus();
      }
    }
  };

  const locateActiveNote = () => {
    if (!activeNote) return;
    setQuery('');
    openAncestors(getFolderPath(activeNote));
    requestAnimationFrame(() => {
      const button = noteButtons.current.get(activeNote.id);
      button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      button?.focus({ preventScroll: true });
    });
  };

  const fileRow = (note: ImportedNote, level: number) => (
    <div key={note.id} role="treeitem" aria-level={level + 1} aria-selected={activeNoteId === note.id}>
      {edit?.kind === 'rename-note' && edit.id === note.id ? inlineRow(edit, level) : <button ref={button => { if (button) noteButtons.current.set(note.id, button); else noteButtons.current.delete(note.id); }} type="button"
        className={`ft-row ft-file ${activeNoteId === note.id ? 'ft-active' : ''} ${draggedNoteId === note.id ? 'ft-drag-source' : ''} ${pendingMoveId === note.id ? 'ft-moving' : ''}`} style={{ paddingLeft: 27 + level * 12 }} title={note.path || note.title} aria-label={note.title}
        draggable={movable(note)} aria-busy={pendingMoveId === note.id || undefined} data-note-id={note.id}
        aria-haspopup={hasActions ? 'menu' : undefined} onContextMenu={event => contextMenu(event, { kind: 'note', id: note.id })}
        onDragStart={event => startDrag(event, note)} onDragEnd={finishDrag}
        data-parent={getFolderPath(note)} onKeyDown={event => {
          if (keyboardMenu(event, { kind: 'note', id: note.id })) return;
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && onPinNote) {
            event.preventDefault();
            event.stopPropagation();
            if (!editBusyRef.current && !dragRef.current && Date.now() >= suppressClickUntil.current && pendingMoveId !== note.id) onPinNote(note.id);
          } else focusRow(event);
        }} onDoubleClick={event => {
          event.stopPropagation();
          if (!editBusyRef.current && !dragRef.current && Date.now() >= suppressClickUntil.current && pendingMoveId !== note.id) onPinNote?.(note.id);
        }} onClick={() => {
          if (editBusyRef.current || dragRef.current || Date.now() < suppressClickUntil.current || pendingMoveId === note.id) return;
          onOpenNote?.(note.id);
        }}>
        {pendingMoveId === note.id ? <LoaderCircle className="ft-moving-icon" size={14} aria-hidden="true"/> : <FileText size={14} aria-hidden="true"/>}<span>{note.title}</span>
      </button>}
    </div>
  );

  const renderFolder = (folder: FolderNode, level: number) => {
    const isOpen = !collapsed.has(folder.path) && (Boolean(term) || level === 0 || expanded.has(folder.path));
    const isActive = !browseOnly && selectedPath === folder.path;
    return (
      <div key={folder.path} role="treeitem" aria-level={level + 1} aria-expanded={isOpen} aria-selected={isActive}>
        {edit?.kind === 'rename-folder' && edit.path === folder.path ? inlineRow(edit, level) : <button ref={button => { if (button) folderButtons.current.set(folder.path, button); else folderButtons.current.delete(folder.path); }} type="button" className={`ft-row ft-folder ${isActive ? 'ft-active' : ''} ${dropPath === folder.path ? 'ft-drop-target' : ''}`} style={{ paddingLeft: 5 + level * 12 }}
          onDragOver={event => dragOverDestination(event, folder.path, isOpen)} onDragLeave={leaveDestination} onDrop={event => { void dropNote(event, folder.path); }}
          aria-haspopup={hasActions ? 'menu' : undefined} onContextMenu={event => contextMenu(event, { kind: 'folder', path: folder.path })}
          data-folder={folder.path} title={folder.path} aria-label={folder.path} aria-expanded={isOpen} onKeyDown={event => { if (!keyboardMenu(event, { kind: 'folder', path: folder.path })) focusRow(event, folder, isOpen); }} onClick={() => {
            if (editBusyRef.current || dragRef.current || Date.now() < suppressClickUntil.current) return;
            setFolderOpen(folder.path, !isOpen);
            if (!browseOnly) onSelect(folder.path);
          }}>
          <span className="ft-expander" aria-hidden="true">{isOpen ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</span>
          {isOpen ? <FolderOpen size={15} aria-hidden="true"/> : <Folder size={15} aria-hidden="true"/>}
          <span className="ft-folder-name">{folder.name}</span><small>{folder.count.toLocaleString('zh-CN')}</small>
        </button>}
        {isOpen && <div role="group">{edit?.kind.startsWith('create') && edit.parent === folder.path && inlineRow(edit, level + 1)}{folder.children.map(child => renderFolder(child, level + 1))}{folder.notes.map(note => fileRow(note, level + 1))}</div>}
      </div>
    );
  };

  const menuTarget = menu?.target;
  const menuNote = menuTarget?.kind === 'note' ? notes.find(note => note.id === menuTarget.id) : undefined;
  const menuBusy = editBusy || Boolean(pendingMoveId);
  const menuItems = menu ? menu.target.kind === 'note' ? [
    { label: '重命名', Icon: PencilLine, disabled: menuBusy || !menuNote || !canRenameNote?.(menuNote) || !onRenameNote, hint: '你没有重命名这篇笔记的权限。', run: () => beginEdit('rename-note', menu) },
    { label: '删除笔记', Icon: Trash2, disabled: menuBusy || !menuNote || !canDeleteNote?.(menuNote) || !onDeleteNote, hint: '仅作者可以删除这篇笔记。', run: () => { setMenu(null); if (menuNote) onDeleteNote?.(menuNote.id); } },
  ] : [
    { label: '新建笔记', Icon: FilePlus2, disabled: menuBusy || !canCreate || !onCreateNote, hint: !canCreate ? '登录后可新建笔记。' : '暂时无法新建笔记。', run: () => beginEdit('create-note', menu) },
    { label: '新建文件夹', Icon: FolderPlus, disabled: menuBusy || !canCreate || !onCreateFolder, hint: !canCreate ? '登录后可新建文件夹。' : '暂时无法新建文件夹。', run: () => beginEdit('create-folder', menu) },
    ...(menu.target.kind === 'folder' ? [
      { label: '重命名', Icon: PencilLine, disabled: menuBusy || !canRenameFolder?.(menu.target.path) || !onRenameFolder, hint: '你没有重命名这个文件夹的权限。', run: () => beginEdit('rename-folder', menu) },
      { label: '删除文件夹', Icon: Trash2, disabled: menuBusy || !canDeleteFolder?.(menu.target.path) || !onDeleteFolder, hint: '文件夹内含有无权删除的笔记或文件夹。', run: () => { setMenu(null); if (menu.target.kind === 'folder') onDeleteFolder?.(menu.target.path); } },
    ] : []),
  ] : [];

  return <div className={`ft-browser ${draggedNoteId ? 'ft-drag-active' : ''}`} aria-busy={Boolean(pendingMoveId) || editBusy}>
    <style>{`
      .ft-browser{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;color:var(--text-secondary,#77757f);font-size:14px}
      .ft-browser button,.ft-browser input{font:inherit;color:inherit}
      .ft-browser button{background:none;border:0;cursor:pointer;text-align:left}
      .ft-controls{display:flex;align-items:center;gap:3px;flex-shrink:0;padding:3px 1px 9px;min-width:0}
      .ft-search{display:flex;align-items:center;gap:5px;min-width:0;flex:1;height:30px;border:1px solid var(--border,#e9e7ef);border-radius:6px;padding:0 7px;background:var(--surface-secondary,#f4f3f7)}
      .ft-search>svg{flex-shrink:0;color:var(--text-muted,#9995a6)}
      .ft-search input{min-width:0;width:100%;outline:0;border:0;background:transparent;font-size:12px}
      .ft-search input::placeholder{color:var(--text-muted,#9995a6)}
      .ft-browser .ft-tool{display:grid;place-items:center;flex-shrink:0;width:28px;height:28px;padding:0;border-radius:5px;color:var(--text-muted,#9995a6)}
      .ft-browser .ft-clear{width:18px;height:22px}
      .ft-tool:hover:not(:disabled){background:var(--surface-secondary,#f4f3f7);color:var(--text-primary,#34323b)}
      .ft-tool:disabled{opacity:.35;cursor:default}
      .ft-tree-scroll{overflow:auto;min-height:0;min-width:0;flex:1;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--border,#dcd9e3) transparent}
      .ft-tree{font-size:14px;padding:3px 0 8px;min-width:100%;width:max-content}
      .ft-tree .ft-row{display:flex;align-items:center;gap:7px;width:100%;min-width:max-content;white-space:nowrap;box-sizing:border-box;border-radius:6px;padding-right:10px;font-size:14px;line-height:19px}
      .ft-tree .ft-folder{min-height:32px;margin:1px 0;font-weight:500}
      .ft-folder:hover,.ft-file:hover{background:var(--surface-secondary,#f4f3f7);color:var(--text-primary,#34323b)}
      .ft-expander{width:15px;height:28px;padding:0;display:grid;place-items:center;flex-shrink:0;margin-right:-3px}
      .ft-folder-name{white-space:nowrap;flex:1}
      .ft-folder>svg,.ft-file>svg{flex-shrink:0;color:var(--text-muted,#9995a6)}
      .ft-folder>small{font-size:12px;font-weight:400;margin-left:auto;padding-left:8px;color:var(--text-muted,#9995a6);font-variant-numeric:tabular-nums}
      .ft-tree .ft-file{min-height:31px;padding-top:6px;padding-bottom:6px}
      .ft-tree .ft-file>span{white-space:nowrap}
      .ft-file[draggable=true]{cursor:grab}
      .ft-file[draggable=true]:active{cursor:grabbing}
      .ft-tree .ft-drag-source{opacity:.45}
      .ft-tree .ft-moving{opacity:.6;cursor:progress}
      .ft-moving-icon{animation:ft-spin 1s linear infinite}
      @keyframes ft-spin{to{transform:rotate(360deg)}}
      @media(prefers-reduced-motion:reduce){.ft-moving-icon{animation:none}}
      .ft-browser .ft-drop-target{color:var(--text-primary,#34323b);background:color-mix(in srgb,var(--accent,#9274e8) 24%,var(--surface,#fff));outline:2px solid var(--accent,#9274e8);outline-offset:-2px}
      .ft-browser .ft-root-drop{position:absolute;top:0;left:1px;right:1px;z-index:3;display:flex;align-items:center;gap:8px;min-height:38px;margin:0;padding:8px 10px;border:1px dashed var(--accent,#9274e8);border-radius:6px;background:var(--surface,#fff);font-size:12px;line-height:18px;color:var(--text-secondary,#77757f)}
      .ft-root-drop>svg{flex-shrink:0}
      .ft-root-drop:disabled{opacity:.45;cursor:not-allowed}
      .ft-moving-status{display:flex;align-items:center;gap:7px;flex-shrink:0;padding:6px 8px 9px;font-size:12px;color:var(--text-muted,#9995a6)}
      .ft-announcement{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
      .ft-tree .ft-active{color:var(--accent,#9274e8);background:color-mix(in srgb,var(--accent,#9274e8) 12%,transparent);font-weight:600}
      .ft-tree .ft-active svg{color:var(--accent,#9274e8)}
      .ft-browser button:focus-visible,.ft-search:focus-within{outline:2px solid var(--accent,#9274e8);outline-offset:-2px;border-radius:5px}
      .ft-tree .ft-empty{font-size:12px;line-height:1.8;padding:8px 14px;color:var(--text-muted,#9995a6);white-space:normal;max-width:240px}
      .ft-inline{margin:2px 0;padding:2px 8px 2px 0;box-sizing:border-box;min-width:max-content;max-width:360px}
      .ft-inline-row{display:flex;align-items:center;gap:7px;min-height:30px}
      .ft-inline-row>svg{flex-shrink:0;color:var(--text-muted,#9995a6)}
      .ft-inline-row input{box-sizing:border-box;width:180px;min-width:120px;padding:4px 7px;border:1px solid var(--accent,#9274e8);border-radius:4px;background:var(--surface,#fff);color:var(--text-primary,#34323b);font:inherit;line-height:20px;outline:1px solid var(--accent,#9274e8);outline-offset:0}
      .ft-inline-row input:disabled{opacity:.65;cursor:progress}
      .ft-inline-error{margin:6px 0 5px 21px;max-width:250px;white-space:normal;overflow-wrap:anywhere;font-size:12px;line-height:1.6;color:var(--danger,#d45c67)}
      .ft-context-menu{position:fixed;z-index:500;width:208px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;box-sizing:border-box;padding:5px;background:var(--surface,#fff);border:1px solid var(--border,#e9e7ee);border-radius:9px;box-shadow:0 12px 38px #0003;color:var(--text-primary,#34323b);font-family:inherit;font-size:14px;outline:none}
      .ft-context-heading{padding:5px 8px 7px;border-bottom:1px solid var(--border,#e9e7ee);margin-bottom:4px;color:var(--text-muted,#9995a6);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ft-context-menu button{display:flex;align-items:center;gap:9px;width:100%;min-height:33px;padding:6px 8px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;line-height:20px;text-align:left;cursor:pointer}
      .ft-context-menu button>svg{flex-shrink:0;color:var(--text-secondary,#77757f)}
      .ft-context-menu button:hover:not(:disabled),.ft-context-menu button:focus-visible{outline:none;background:color-mix(in srgb,var(--accent,#9274e8) 16%,transparent)}
      .ft-context-menu button:disabled{opacity:.4;cursor:not-allowed}
      .ft-context-menu .ft-context-danger:not(:disabled),.ft-context-menu .ft-context-danger:not(:disabled)>svg{color:var(--danger,#d45c67)}
      .ft-context-hint{margin:5px 0 0;padding:7px 8px 4px;border-top:1px solid var(--border,#e9e7ee);font-size:12px;line-height:1.6;color:var(--text-muted,#9995a6)}
    `}</style>
    {showToolbar && <div className="ft-controls">
      <label className="ft-search"><Search size={13} aria-hidden="true"/><input aria-label="搜索文档目录" placeholder="查找文件或文件夹" value={query} onChange={event => { setQuery(event.target.value); setCollapsed(new Set()); }}/>
        {query && <button type="button" className="ft-tool ft-clear" aria-label="清除目录搜索" onClick={() => setQuery('')}><X size={12}/></button>}
      </label>
      <button type="button" className="ft-tool" aria-label="收起全部文件夹" title="收起全部文件夹" onClick={() => { setCollapsed(new Set(allPaths)); setExpanded(new Set()); }}><ChevronsDownUp size={15}/></button>
      <button type="button" className="ft-tool" aria-label="定位当前文档" title="定位当前文档" disabled={!activeNote} onClick={locateActiveNote}><Crosshair size={15}/></button>
    </div>}
    {draggedNoteId && <button type="button" className={`ft-root-drop ${dropPath === '' ? 'ft-drop-target' : ''}`} aria-label="移到知识库根目录"
      disabled={!draggedNote || !getFolderPath(draggedNote)}
      onDragOver={event => dragOverDestination(event, '')} onDragLeave={leaveDestination} onDrop={event => { void dropNote(event, ''); }}>
      <Folder size={15} aria-hidden="true"/>移到知识库根目录
    </button>}
    {pendingMoveId && <div className="ft-moving-status"><LoaderCircle size={13} className="ft-moving-icon" aria-hidden="true"/>正在移动文档…</div>}
    <span className="ft-announcement" aria-live="polite" role="status">{announcement}</span>
    <div ref={scrollRef} className="ft-tree-scroll" tabIndex={hasActions ? 0 : undefined} onContextMenu={event => {
      if (event.target instanceof Element && event.target.closest('button,input,textarea,form')) return;
      contextMenu(event, { kind: 'root' });
    }} onKeyDown={event => { if (event.target === event.currentTarget) keyboardMenu(event, { kind: 'root' }); }} onDragOver={autoScroll} onDragLeave={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) stopScrolling();
    }}><div ref={treeRef} className="ft-tree" role="tree" aria-label="知识库文件夹">
      {edit?.kind.startsWith('create') && !edit.parent && inlineRow(edit, 0)}
      {visibleFolders.map(folder => renderFolder(folder, 0))}{visibleRootNotes.map(note => fileRow(note, 0))}
      {!notes.length && !folders.length && !edit && <p className="ft-empty">{hasActions ? '右键此处新建笔记或文件夹，也可以导入已有知识库。' : '导入知识库后，在这里浏览原有文件夹。'}</p>}
      {(notes.length > 0 || folders.length > 0) && !visibleFolders.length && !visibleRootNotes.length && <p className="ft-empty">没有匹配的文件或文件夹。</p>}
    </div></div>
    {menu && createPortal(<div ref={menuRef} className="ft-context-menu" role="menu" aria-label={menu.target.kind === 'note' ? '笔记操作' : menu.target.kind === 'folder' ? '文件夹操作' : '文档目录操作'} tabIndex={-1} style={{ left: menu.x, top: menu.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); setMenu(null); restoreFocus(menu.origin); return; }
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}><div className="ft-context-heading" title={menu.target.kind === 'folder' ? menu.target.path : menuNote ? getNotePath(menuNote) : '知识库根目录'}>{menuNote?.title || (menu.target.kind === 'folder' ? menu.target.path.split('/').pop() : '知识库根目录')}</div>
      {menuItems.map(({ label, Icon, disabled, hint, run }) => <button key={label} type="button" role="menuitem" disabled={disabled} title={disabled ? hint : undefined} className={label.startsWith('删除') ? 'ft-context-danger' : undefined} onClick={run}><Icon size={15} aria-hidden="true"/>{label}</button>)}
      {menu.target.kind !== 'note' && !canCreate && <p className="ft-context-hint">登录后可新建笔记和文件夹。</p>}
    </div>, document.body)}
  </div>;
}
