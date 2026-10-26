import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Check, Eye, EyeOff, LoaderCircle, LockKeyhole, Mail, Sparkles, UserRound, X } from 'lucide-react';
import { administrator } from '../lib/workspace';
import { authApi, type SessionUser } from '../lib/api';

type AccountModalProps = {
  open: boolean;
  onClose: () => void;
  onRegister: (user: SessionUser) => void;
  setupToken?: string;
};

export default function AccountModal({ open, onClose, onRegister, setupToken }: AccountModalProps) {
  const [mode, setMode] = useState<'register' | 'signin'>('register');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const closeRef = useRef(onClose);
  const dialog = useRef<HTMLElement>(null);
  closeRef.current = onClose;
  const initializing = Boolean(setupToken);
  const registering = mode === 'register' && !initializing;
  const creatingPassword = registering || initializing;

  useEffect(() => {
    if (open && initializing) setEmail(administrator.email);
    setPassword('');
    setConfirm('');
    setError('');
    setShowPassword(false);
  }, [open, initializing]);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setConfirm('');
      setError('');
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!pending.current) closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]') || [])].filter(item => item.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;

  const requestClose = () => { if (!pending.current) onClose(); };

  const switchMode = (next: 'register' | 'signin') => {
    if (pending.current) return;
    setMode(next);
    setError('');
    setPassword('');
    setConfirm('');
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current) return;
    if (registering && !name.trim()) { setError('给自己起一个名字吧。'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('请输入有效的邮箱地址。'); return; }
    if (creatingPassword && password.length < 8) { setError('密码至少需要 8 个字符。'); return; }
    if (!creatingPassword && !password) { setError('请输入密码。'); return; }
    if (creatingPassword && password !== confirm) { setError('两次输入的密码不一致，请再确认一下。'); return; }
    const accountEmail = email.trim().toLowerCase();
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const nextUser = initializing
        ? await authApi.activateAdmin({ token: setupToken!, password })
        : registering
          ? await authApi.register({ name: name.trim(), email: accountEmail, password })
          : await authApi.login({ email: accountEmail, password });
      setPassword('');
      setConfirm('');
      onRegister(nextUser);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法连接账号服务，请稍后重试。');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="au-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}>
      <style>{`
        .au-backdrop{position:fixed;inset:0;z-index:1200;background:rgba(34,31,54,.34);backdrop-filter:blur(7px);display:flex;align-items:center;justify-content:center;padding:24px;font-family:inherit;color:#343447}
        .au-modal{width:820px;max-width:100%;display:grid;grid-template-columns:310px 1fr;background:#fff;border-radius:26px;overflow:hidden;box-shadow:0 24px 90px rgba(43,35,75,.2);position:relative;max-height:calc(100dvh - 48px);overflow-y:auto;animation:au-enter .2s ease-out}
        .au-art{background:linear-gradient(150deg,#f0ebff 0%,#f4f1ff 55%,#e9f4f5 100%);padding:38px 30px;display:flex;flex-direction:column;position:relative;overflow:hidden}
        .au-brand{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:750;letter-spacing:1px;position:relative;z-index:1}.au-brand-icon{width:36px;height:36px;border-radius:11px;background:#8670e5;display:grid;place-items:center;color:#fff;box-shadow:0 5px 12px #8670e52b}
        .au-art-copy{margin-top:62px;position:relative;z-index:1}.au-art-copy h3{font-size:15.5px;line-height:1.7;margin:0 0 14px;font-weight:700;letter-spacing:.2px}.au-art-copy p{font-size:14px;line-height:1.9;color:#818093;margin:0;max-width:220px}
        .au-orbit{position:relative;height:155px;margin-top:32px;display:grid;place-items:center}.au-orbit:before,.au-orbit:after{content:'';position:absolute;width:150px;height:150px;border:1px solid #a99ade38;border-radius:50%;transform:rotate(-24deg) scaleX(1.4)}.au-orbit:after{width:115px;height:115px;transform:rotate(30deg) scaleX(1.4)}.au-floating-book{width:80px;height:92px;background:linear-gradient(145deg,#ad9bf4,#8269dc);border-radius:14px;box-shadow:10px 13px 25px #8070ad2b;transform:rotate(-9deg);display:grid;place-items:center;color:white;position:relative;z-index:1;border:1px solid #ffffff6b}.au-floating-spark{position:absolute;right:23px;top:19px;color:#ad94e4}.au-art-foot{display:flex;gap:7px;align-items:center;color:#9590a7;font-size:12px;margin-top:auto;padding-top:30px;position:relative;z-index:1}
        .au-form-wrap{padding:40px 38px 29px}.au-close{position:absolute;right:16px;top:16px;border:0;background:transparent;color:#a09dac;width:30px;height:30px;display:grid;place-items:center;cursor:pointer;border-radius:8px}.au-close:hover{background:#f4f1fa;color:#6b5a9a}.au-tabs{display:flex;gap:25px;border-bottom:1px solid #eeedf3;margin:0 0 25px}.au-tab{background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:0 0 12px;cursor:pointer;font:inherit;font-size:14px;font-weight:600;color:#a3a0b0}.au-tab.active{color:#8670e5;border-bottom-color:#8670e5}.au-title{font-size:27px!important;font-weight:700;margin:0 0 7px;line-height:1.5}.au-subtitle{font-size:12px;color:#9292a1;margin:0 0 23px;line-height:1.8}.au-field{margin-bottom:16px}.au-field>label{font-size:14px;font-weight:500;display:block;margin-bottom:7px;color:#565367}.au-input-wrap{position:relative;display:flex;align-items:center}.au-input-icon{position:absolute;left:13px;color:#b0a9bf;pointer-events:none}.au-input{box-sizing:border-box;width:100%;height:43px;padding:0 13px 0 39px;border:1px solid #e8e5ef;background:#fff;border-radius:10px;outline:none;font:inherit;font-size:14px;color:#454052;transition:border-color .15s,box-shadow .15s}.au-input::placeholder{color:#b6b1c0}.au-input:focus{border-color:#ad9ce8;box-shadow:0 0 0 3px #8670e510}.au-password{padding-right:43px}.au-eye{position:absolute;right:9px;border:0;background:none;display:grid;place-items:center;color:#a59eb3;width:28px;height:30px;cursor:pointer}.au-error{font-size:12px;color:#d86875;line-height:1.6;background:#fff2f3;border-radius:8px;padding:9px 12px;margin:4px 0 14px}.au-submit{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;height:44px;border:0;border-radius:10px;background:#8670e5;color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 5px 13px #8670e522;transition:background .15s,transform .15s;margin-top:23px}.au-submit:hover{background:#7862d7;transform:translateY(-1px)}.au-footer{text-align:center;font-size:12px;color:#aaa5b5;margin:15px -10px 0;line-height:1.7}.au-signin-note{font-size:12px;color:#9590a5;line-height:1.8;padding:11px 13px;background:#f8f7fc;border-radius:9px;margin:2px 0 16px}.au-signin-note strong{color:#84749d;font-weight:500}
        .au-modal button:disabled{opacity:.6;cursor:wait}.au-fields{border:0;padding:0;margin:0;min-width:0}.au-modal input:disabled{opacity:.75;cursor:wait}.au-input[readonly]{background:#f8f7fc;color:#777080}.au-spinner{animation:au-spin 1s linear infinite}@keyframes au-spin{to{transform:rotate(360deg)}}
        @keyframes au-enter{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:translateY(0)}}@media(max-width:650px){.au-modal{display:block;width:440px}.au-art{display:none}.au-form-wrap{padding:35px 25px 25px}.au-backdrop{padding:16px}.au-modal{max-height:calc(100dvh - 32px)}}
      `}</style>
      <section ref={dialog} className="au-modal" role="dialog" aria-modal="true" aria-labelledby="au-heading" aria-busy={busy}>
        <aside className="au-art" aria-hidden="true">
          <div className="au-brand"><span className="au-brand-icon"><BookOpen size={21} strokeWidth={1.8} /></span>知屿</div>
          <div className="au-art-copy"><h3>让每一份知识，<br />都有自己的归处。</h3><p>收集灵感，连接知识。<br />和同伴一起，把想法变成成长。</p></div>
          <div className="au-orbit"><Sparkles className="au-floating-spark" size={21} /><div className="au-floating-book"><BookOpen size={37} strokeWidth={1.4} /></div></div>
          <div className="au-art-foot"><Check size={14} />你的个人知识空间，从这里开始</div>
        </aside>
        <div className="au-form-wrap">
          <button className="au-close" type="button" onClick={requestClose} disabled={busy} aria-label="关闭账号窗口"><X size={19} /></button>
          {!initializing && <div className="au-tabs" role="tablist" aria-label="账号操作">
            <button className={`au-tab ${mode === 'register' ? 'active' : ''}`} type="button" role="tab" aria-selected={mode === 'register'} disabled={busy} onClick={() => switchMode('register')}>注册账号</button>
            <button className={`au-tab ${mode === 'signin' ? 'active' : ''}`} type="button" role="tab" aria-selected={mode === 'signin'} disabled={busy} onClick={() => switchMode('signin')}>登录账号</button>
          </div>}
          <h2 className="au-title" id="au-heading">{initializing ? '设置管理员密码' : registering ? '欢迎来到知屿' : '很高兴，再次见到你'}</h2>
          <p className="au-subtitle">{initializing ? '完成账号设置，开始管理你的知识库。' : registering ? '建立你的知识花园，让积累发生。' : '继续记录，让每个好想法都被记住。'}</p>
          <form onSubmit={submit} noValidate>
            <fieldset className="au-fields" disabled={busy}>
            {registering && <div className="au-field"><label htmlFor="au-name">你的名字</label><div className="au-input-wrap"><UserRound size={16} className="au-input-icon" /><input className="au-input" id="au-name" autoComplete="nickname" autoFocus placeholder="怎么称呼你" value={name} onChange={event => setName(event.target.value)} maxLength={30} /></div></div>}
            <div className="au-field"><label htmlFor="au-email">邮箱地址</label><div className="au-input-wrap"><Mail size={16} className="au-input-icon" /><input className="au-input" id="au-email" type="email" autoComplete="email" placeholder="you@example.com" value={email} readOnly={initializing} onChange={event => setEmail(event.target.value)} autoFocus={!initializing && mode === 'signin'} /></div></div>
            <div className="au-field"><label htmlFor="au-password">密码</label><div className="au-input-wrap"><LockKeyhole size={16} className="au-input-icon" /><input className="au-input au-password" id="au-password" type={showPassword ? 'text' : 'password'} autoComplete={creatingPassword ? 'new-password' : 'current-password'} autoFocus={initializing} maxLength={128} placeholder={creatingPassword ? '至少 8 个字符' : '输入你的密码'} value={password} onChange={event => setPassword(event.target.value)} /><button className="au-eye" type="button" aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></div>
            {creatingPassword && <div className="au-field"><label htmlFor="au-confirm">确认密码</label><div className="au-input-wrap"><LockKeyhole size={16} className="au-input-icon" /><input className="au-input" id="au-confirm" type={showPassword ? 'text' : 'password'} autoComplete="new-password" maxLength={128} placeholder="再次输入密码" value={confirm} onChange={event => setConfirm(event.target.value)} /></div></div>}
            </fieldset>
            {initializing && <p className="au-signin-note">管理员账号：<strong>{administrator.name}</strong></p>}
            {error && <div className="au-error" role="alert">{error}</div>}
            <button className="au-submit" type="submit" disabled={busy}>{busy ? '正在验证…' : initializing ? '启用管理员账号' : registering ? '创建我的知识空间' : '进入我的知识空间'}{busy ? <LoaderCircle size={16} className="au-spinner"/> : <ArrowRight size={16}/>}</button>
          </form>
        </div>
      </section>
    </div>
  );
}
