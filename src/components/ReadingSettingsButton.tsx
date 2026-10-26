import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, Settings2, X } from 'lucide-react';
import { LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, PAGE_MARGIN_SLIDER_MAX, PARAGRAPH_SPACING_MAX, useReadingPreferences } from '../lib/useReadingPreferences';
import './reading-settings.css';

function SpacingControl({ id, label, value, min, max, step, unit, onChange }: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const [input, setInput] = useState(String(value));
  useEffect(() => setInput(String(value)), [value]);
  const finishInput = () => {
    const number = input.trim() ? Number(input) : NaN;
    const next = Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : value;
    onChange(next);
    setInput(String(next));
  };
  return <div className="reading-settings-field">
    <label htmlFor={id}>{label}</label>
    <div className="reading-settings-number"><input id={`${id}-number`} type="number" aria-label={`${label}数值`} min={min} max={max} step={step} value={input} onChange={event => {
      const next = event.target.value;
      setInput(next);
      const number = next.trim() ? Number(next) : NaN;
      if (Number.isFinite(number) && number >= min && number <= max) onChange(number);
    }} onBlur={finishInput} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}/><span>{unit}</span></div>
    <input id={id} type="range" aria-label={label} min={min} max={max} step={step} value={value} aria-valuetext={`${value} ${unit}`} onChange={event => onChange(Number(event.target.value))}/>
    <div className="reading-settings-scale"><span>{min} {unit}</span><span>{max} {unit}</span></div>
  </div>;
}

export default function ReadingSettingsButton({ className = 'icon-button' }: { className?: string }) {
  const { preferences, setPreferences, resetPreferences } = useReadingPreferences();
  const [marginInput, setMarginInput] = useState(String(preferences.pageMargin));
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ top: 68, right: 16 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();

  useEffect(() => { setMarginInput(String(preferences.pageMargin)); }, [preferences.pageMargin, open]);

  const changeMarginInput = (value: string) => {
    setMarginInput(value);
    if (value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0) setPreferences({ pageMargin: Number(value) });
  };

  const finishMarginInput = () => {
    // A temporarily empty or invalid input must not replace the saved value.
    setMarginInput(String(preferences.pageMargin));
  };

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(306, window.innerWidth - 24);
      const height = panel.current?.getBoundingClientRect().height || 310;
      setPosition({ width, left: Math.min(Math.max(12, rect.right - width), window.innerWidth - width - 12), top: Math.max(12, Math.min(rect.bottom + 9, window.innerHeight - height - 12)) });
    };
    updatePosition();
    panel.current?.querySelector<HTMLInputElement>('input')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return <>
    <button ref={trigger} type="button" className={`${className} reading-settings-trigger`} aria-label="阅读设置" title="阅读设置" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(value => !value)}><Settings2 size={18}/></button>
    {open && createPortal(<section ref={panel} id={panelId} className="reading-settings-panel" role="dialog" aria-label="阅读设置" style={position}>
      <header><strong>阅读设置</strong><button type="button" aria-label="关闭阅读设置" onClick={() => close(true)}><X size={16}/></button></header>
      <div className="reading-settings-fields">
        <div className="reading-settings-field"><label htmlFor={`${panelId}-font`}>正文大小</label><output htmlFor={`${panelId}-font`}>{preferences.fontSize} px</output><input id={`${panelId}-font`} type="range" aria-label="正文大小" min="12" max="24" step="1" value={preferences.fontSize} onChange={event => setPreferences({ fontSize: Number(event.target.value) })}/><div className="reading-settings-scale"><span>12 px</span><span>24 px</span></div></div>
        <SpacingControl id={`${panelId}-line-height`} label="行间距" value={preferences.lineHeight} min={LINE_HEIGHT_MIN} max={LINE_HEIGHT_MAX} step={0.05} unit="倍" onChange={lineHeight => setPreferences({ lineHeight })}/>
        <SpacingControl id={`${panelId}-paragraph-spacing`} label="段间距" value={preferences.paragraphSpacing} min={0} max={PARAGRAPH_SPACING_MAX} step={1} unit="px" onChange={paragraphSpacing => setPreferences({ paragraphSpacing })}/>
        <div className="reading-settings-field"><label htmlFor={`${panelId}-margin`}>左右页边距</label><div className="reading-settings-number"><input id={`${panelId}-margin-number`} type="number" aria-label="左右页边距数值" aria-describedby={`${panelId}-margin-hint`} min="0" step="1" inputMode="numeric" value={marginInput} onChange={event => changeMarginInput(event.target.value)} onBlur={finishMarginInput} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}/><span>px</span></div><input id={`${panelId}-margin`} type="range" aria-label="左右页边距" min="0" max={PAGE_MARGIN_SLIDER_MAX} step="4" value={Math.min(preferences.pageMargin, PAGE_MARGIN_SLIDER_MAX)} aria-valuetext={preferences.pageMargin > PAGE_MARGIN_SLIDER_MAX ? `${preferences.pageMargin} px，可通过数值框调整` : `${preferences.pageMargin} px`} onChange={event => setPreferences({ pageMargin: Number(event.target.value) })}/><div className="reading-settings-scale"><span>0 px</span><span>{PAGE_MARGIN_SLIDER_MAX} px</span></div><p className="reading-settings-margin-hint" id={`${panelId}-margin-hint`}>可直接输入更大数值。</p></div>
        <p>阅读与编辑同步生效，自动保存到当前浏览器。空间不足时会收紧边距，保留可读区域。</p>
      </div>
      <footer><button type="button" onClick={resetPreferences}><RotateCcw size={14}/>恢复默认</button></footer>
    </section>, document.body)}
  </>;
}
