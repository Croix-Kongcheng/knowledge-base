import { useState, type CSSProperties } from 'react';
import './user-avatar.css';

type UserAvatarProps = {
  src?: string;
  name: string;
  fallback?: string;
  className?: string;
  style?: CSSProperties;
};

export default function UserAvatar({ src, name, fallback, className = '', style }: UserAvatarProps) {
  const [failed, setFailed] = useState<string>();
  const source = src?.startsWith('/api/avatars/') ? src : undefined;
  const initial = fallback || (name.includes(' ')
    ? name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase()
    : Array.from(name).slice(-1).join(''));
  return <span className={`avatar ${className}`} style={style}>
    {source && failed !== source
      ? <img src={source} alt={`${name}的头像`} decoding="async" onError={() => setFailed(source)} />
      : initial}
  </span>;
}
