import { useEffect, useRef, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';

export type ThemePreference = 'obsidian' | 'light' | 'system';
export type ResolvedTheme = 'obsidian' | 'light';

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    try { const saved = localStorage.getItem('zhiyu-theme-v1'); if (saved === 'light' || saved === 'system' || saved === 'obsidian') return saved; } catch { /* Use the default palette. */ }
    return 'obsidian';
  });
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved: ResolvedTheme = preference === 'system' ? (systemDark ? 'obsidian' : 'light') : preference;
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved === 'obsidian' ? 'dark' : 'light';
    try { localStorage.setItem('zhiyu-theme-v1', preference); } catch { /* Keep the selection for this session. */ }
  }, [preference, resolved]);
  return { preference, setPreference, resolved };
}

export default function ThemePicker({ value, onChange }: { value: ThemePreference; onChange: (theme: ThemePreference) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  return <div className="theme-picker popover-anchor" ref={root}>
    <button className="icon-button theme-trigger" aria-label="切换主题" aria-expanded={open} onClick={() => setOpen(!open)}>{value === 'light' ? <Sun size={19} /> : value === 'system' ? <Monitor size={19} /> : <Moon size={19} />}</button>
    {open && <div className="theme-menu top-popover" role="menu" aria-label="主题配色">
      <div className="theme-menu-heading">外观与配色<span>像在 Obsidian 中一样阅读</span></div>
      {([{ id: 'obsidian', name: 'Obsidian 深色', sub: '石墨灰 · 薰衣草紫', Icon: Moon }, { id: 'light', name: 'Obsidian 浅色', sub: '纯净白 · 低对比边框', Icon: Sun }, { id: 'system', name: '跟随系统', sub: '随设备外观自动切换', Icon: Monitor }] as const).map(({ id, name, sub, Icon }) => <button key={id} role="menuitemradio" aria-checked={value === id} className={value === id ? 'selected' : ''} onClick={() => { onChange(id); setOpen(false); }}><span className={`theme-swatch theme-swatch-${id}`}><Icon size={17} /></span><span><strong>{name}</strong><small>{sub}</small></span>{value === id && <Check size={16} />}</button>)}
      <p>主题会自动保存在当前浏览器</p>
    </div>}
  </div>;
}
