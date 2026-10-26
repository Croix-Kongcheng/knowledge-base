import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './avatar-viewer.css';

export default function AvatarViewer({ name, src, onClose }: {
  name: string;
  src: string;
  onClose: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') { event.preventDefault(); closeButton.current?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return createPortal(<div className="av-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="av-dialog" role="dialog" aria-modal="true" aria-labelledby="avatar-viewer-title">
      <header><h2 id="avatar-viewer-title">{name}的头像</h2><button ref={closeButton} type="button" className="icon-button" aria-label="关闭头像大图" onClick={onClose}><X size={20}/></button></header>
      <div className="av-image-area">
        {!failed && src.startsWith('/api/avatars/')
          ? <img src={src} alt={`${name}的头像大图`} onError={() => setFailed(true)}/>
          : <p role="alert">头像暂时无法显示，请关闭后刷新重试。</p>}
      </div>
    </section>
  </div>, document.body);
}
