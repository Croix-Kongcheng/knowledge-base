import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Camera, LoaderCircle, RotateCcw, UserRoundPen, X } from 'lucide-react';
import { authApi, type SessionUser } from '../lib/api';
import { normalizeAvatarImage } from '../lib/avatarImage';
import './profile-settings.css';

type ProfileSettingsProps = {
  user: SessionUser;
  onClose: () => void;
  onUpdated: (user: SessionUser) => void;
};

export default function ProfileSettings({ user, onClose, onUpdated }: ProfileSettingsProps) {
  const [name, setName] = useState(user.name);
  const [busy, setBusy] = useState<'name' | 'avatar' | null>(null);
  const [error, setError] = useState('');
  const [nameStatus, setNameStatus] = useState('');
  // undefined keeps the saved avatar; null stages a return to the default.
  const [avatarDraft, setAvatarDraft] = useState<Blob | null>();
  const [avatarPreview, setAvatarPreview] = useState('');
  const [avatarError, setAvatarError] = useState('');
  const [avatarStatus, setAvatarStatus] = useState('');
  const [preparing, setPreparing] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const preparingRef = useRef(false);
  const imageGeneration = useRef(0);
  const imageAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const close = useRef(onClose);
  const saving = busy !== null;
  const hasAvatarDraft = avatarDraft !== undefined;
  const savedAvatar = user.avatarUrl?.startsWith('/api/avatars/') ? user.avatarUrl : '';
  const preview = avatarDraft === null ? '' : avatarDraft ? avatarPreview : savedAvatar;
  const parts = user.name.trim().split(/\s+/);
  const initials = parts.length > 1 ? parts.slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase() : Array.from(user.name).slice(-2).join('');

  const cancelImageWork = () => {
    imageGeneration.current += 1;imageAbort.current?.abort();imageAbort.current = null;
    preparingRef.current = false;setPreparing(false);
  };
  const requestClose = () => {
    if (pending.current) return;
    cancelImageWork();onClose();
  };
  close.current = requestClose;

  useEffect(() => {
    if (!avatarDraft) { setAvatarPreview('');return; }
    const url = URL.createObjectURL(avatarDraft);
    setAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarDraft]);

  // Session refreshes must not replace either draft while the user is editing.
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    input.current?.focus();input.current?.select();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault();close.current(); }
      if (event.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') || [])].filter(item => item.getClientRects().length > 0);
      const first = items[0], last = items[items.length - 1];
      if (!items.length) { event.preventDefault();dialog.current?.focus();return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault();last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault();first.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      mounted.current = false;imageGeneration.current += 1;imageAbort.current?.abort();
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keyboard);
      const trigger = document.querySelector<HTMLButtonElement>('[aria-label="账号菜单"]');
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else if (previous?.isConnected && previous.tabIndex >= 0) previous.focus({ preventScroll: true });
    };
  }, []);

  const chooseAvatar = async (file: File) => {
    if (pending.current) return;
    imageAbort.current?.abort();
    const controller = new AbortController();imageAbort.current = controller;
    const generation = ++imageGeneration.current;
    preparingRef.current = true;setPreparing(true);setAvatarError('');setAvatarStatus('');
    try {
      const normalized = await normalizeAvatarImage(file, { signal: controller.signal });
      if (mounted.current && generation === imageGeneration.current) setAvatarDraft(normalized);
    } catch (cause) {
      if (mounted.current && generation === imageGeneration.current && !controller.signal.aborted) setAvatarError(cause instanceof Error ? cause.message : '图片处理失败，请重新选择。');
    } finally {
      if (mounted.current && generation === imageGeneration.current) { preparingRef.current = false;setPreparing(false); }
    }
  };

  const changeAvatarDraft = (next: null | undefined) => {
    if (pending.current) return;
    cancelImageWork();setAvatarDraft(next);setAvatarError('');setAvatarStatus('');
  };

  const saveAvatar = async () => {
    if (pending.current || preparingRef.current || avatarDraft === undefined) return;
    const draft = avatarDraft;
    pending.current = true;setBusy('avatar');setAvatarError('');setAvatarStatus('');
    try {
      const updated = draft === null ? await authApi.removeAvatar() : await authApi.uploadAvatar(draft);
      if (!mounted.current) return;
      onUpdated(updated);setAvatarDraft(undefined);setAvatarStatus(draft === null ? '已恢复默认头像。' : '头像已保存。');
    } catch (cause) {
      if (mounted.current) setAvatarError(cause instanceof Error ? cause.message : '头像保存失败，请稍后重试。');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || preparingRef.current) return;
    const normalized = name.normalize('NFC').trim();
    if (!normalized) { setError('请输入显示名称。');input.current?.focus();return; }
    if (Array.from(normalized).length > 30) { setError('显示名称最多 30 个字符。');input.current?.focus();return; }
    if (/[\p{Cc}\p{Cf}]/u.test(normalized)) { setError('显示名称不能包含控制字符。');input.current?.focus();return; }
    if (normalized === user.name) { if (!hasAvatarDraft) requestClose();return; }
    pending.current = true;setBusy('name');setError('');setNameStatus('');
    try {
      const updated = await authApi.updateProfile({ name: normalized });
      if (!mounted.current) return;
      onUpdated(updated);setName(updated.name);
      if (hasAvatarDraft) setNameStatus('显示名称已保存。');
      else onClose();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '名称保存失败，请稍后重试。');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  return <div className="ps-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}>
    <section ref={dialog} className="ps-dialog" role="dialog" aria-modal="true" aria-labelledby="ps-title" aria-describedby="ps-description" aria-busy={saving || preparing} tabIndex={-1}>
      <header className="ps-header"><span className="ps-icon"><UserRoundPen size={20}/></span><h2 id="ps-title">个人资料</h2><button className="icon-button" type="button" aria-label="关闭个人资料" disabled={saving} onClick={requestClose}><X size={18}/></button></header>
      <p id="ps-description" className="ps-description">设置你在空间中显示的名字和头像。</p>
      <div className="ps-email"><span>当前账号</span><span>{user.email}</span></div>

      <section className="ps-avatar-section" aria-label="个人头像">
        <div className="ps-avatar-heading"><h3>头像</h3>{hasAvatarDraft && <span>尚未保存</span>}</div>
        <div className="ps-avatar-layout">
          <div className="ps-avatar-preview">{preview ? <img src={preview} alt="头像预览"/> : <span aria-label="默认头像">{initials}</span>}</div>
          <div className="ps-avatar-controls"><div className="ps-avatar-buttons"><button className="button secondary" type="button" disabled={saving} onClick={() => avatarInput.current?.click()}><Camera size={15}/>{savedAvatar || avatarDraft ? '更换头像' : '选择头像'}</button><button className="ps-link" type="button" disabled={saving || avatarDraft === null || !savedAvatar && !avatarDraft} onClick={() => changeAvatarDraft(null)}><RotateCcw size={13}/>恢复默认头像</button></div><p>选择不超过 20 MB 的图片，将自动居中裁剪。</p><p>头像和名称分别保存。</p></div>
        </div>
        <input ref={avatarInput} hidden type="file" accept="image/*" aria-label="选择头像图片" disabled={saving} onChange={event => { const file = event.target.files?.[0];event.target.value = '';if (file) void chooseAvatar(file); }}/>
        {preparing && <p className="ps-avatar-status" role="status"><LoaderCircle className="ps-spinner" size={14}/>正在处理图片…</p>}
        {avatarError && <p className="ps-error" role="alert">{avatarError}</p>}
        {avatarStatus && <p className="ps-success" role="status">{avatarStatus}</p>}
        <div className="ps-avatar-save"><button className="button secondary" type="button" disabled={saving || preparing || !hasAvatarDraft} onClick={() => void saveAvatar()}>{busy === 'avatar' && <LoaderCircle className="ps-spinner" size={15}/>} {busy === 'avatar' ? '正在保存头像…' : '保存头像'}</button>{hasAvatarDraft && <button className="ps-link" type="button" disabled={saving} onClick={() => changeAvatarDraft(undefined)}>撤销头像更改</button>}</div>
      </section>

      <form noValidate onSubmit={event => void submit(event)}>
        <label className="ps-label" htmlFor="ps-name">显示名称 / ID</label>
        <input ref={input} className="ps-input" id="ps-name" name="name" autoComplete="nickname" value={name} disabled={saving} maxLength={30} aria-invalid={Boolean(error)} aria-describedby={error ? 'ps-name-error ps-name-hint' : 'ps-name-hint'} onChange={event => { setName(event.target.value);setNameStatus('');if (error) setError(''); }}/>
        <div id="ps-name-hint" className="ps-hint"><span>最多 30 个字符</span><span>{Array.from(name).length} / 30</span></div>
        {error && <p id="ps-name-error" className="ps-error" role="alert">{error}</p>}
        {nameStatus && <p className="ps-success" role="status">{nameStatus}</p>}
        <footer className="ps-footer"><button className="button secondary" type="button" disabled={saving} onClick={requestClose}>取消</button><button className="button primary" type="submit" disabled={saving || preparing}>{busy === 'name' && <LoaderCircle className="ps-spinner" size={16}/>} {busy === 'name' ? '正在保存…' : '保存名称'}</button></footer>
      </form>
    </section>
  </div>;
}
