import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

const WIDTH_KEY = 'zhiyu-sidebar-width-v1';
const COLLAPSED_KEY = 'zhiyu-sidebar-collapsed-v1';
const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 240;
const MAX_WIDTH = 520;

function readPreference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function useWorkspaceLayout() {
  const [viewport, setViewport] = useState(window.innerWidth);
  const [preferredWidth, setPreferredWidth] = useState(() => {
    const saved = Number(readPreference(WIDTH_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH;
  });
  const [collapsed, setCollapsed] = useState(() => readPreference(COLLAPSED_KEY) === 'true');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const isMobile = viewport <= 800;
  const maximumWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewport - 560));
  const width = Math.min(preferredWidth, maximumWidth);
  const visible = isMobile ? drawerOpen : !collapsed;

  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { setDrawerOpen(false); }, [isMobile]);
  useEffect(() => {
    try { localStorage.setItem(WIDTH_KEY, String(preferredWidth)); } catch { /* Keep this session usable. */ }
  }, [preferredWidth]);
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, String(collapsed)); } catch { /* Keep this session usable. */ }
  }, [collapsed]);
  useEffect(() => {
    document.body.classList.toggle('resizing-sidebar', resizing);
    return () => document.body.classList.remove('resizing-sidebar');
  }, [resizing]);

  const setWidth = (value: number) => setPreferredWidth(Math.min(maximumWidth, Math.max(MIN_WIDTH, Math.round(value))));
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return {
    isMobile, visible, collapsed, drawerOpen, resizing, width, maximumWidth,
    style: { '--sidebar-width': `${width}px` } as CSSProperties,
    toggle: () => isMobile ? setDrawerOpen(value => !value) : setCollapsed(value => !value),
    closeDrawer: () => setDrawerOpen(false),
    resizeProps: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (isMobile || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
        setResizing(true);
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId === event.pointerId) setWidth(drag.current.startWidth + event.clientX - drag.current.startX);
      },
      onPointerUp: endResize,
      onPointerCancel: endResize,
      onLostPointerCapture: () => { drag.current = null; setResizing(false); },
      onDoubleClick: () => setWidth(DEFAULT_WIDTH),
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 40 : 16;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        setWidth(event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maximumWidth : width + (event.key === 'ArrowRight' ? step : -step));
      },
    },
  };
}
