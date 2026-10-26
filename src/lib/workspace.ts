export interface LocalUser {
  name: string;
  email: string;
}

export type WorkspaceRole = '空间管理员' | '协作成员';

export interface WorkspaceMember extends LocalUser {
  avatarUrl?: string;
  initial: string;
  role: WorkspaceRole;
  joined: string;
  color: string;
}

export const administrator: WorkspaceMember = {
  name: 'Project Admin',
  email: 'admin@example.com',
  initial: 'PA',
  role: '空间管理员',
  joined: '2026.01.01',
  color: '#eae3f8',
};

const formerDemoEmails = new Set([
  'linyu@example.com',
  'chenyi@example.com',
  'suhe@example.com',
  'zhouye@example.com',
]);

export function roleForEmail(email?: string | null): WorkspaceRole {
  return email?.trim().toLowerCase() === administrator.email ? '空间管理员' : '协作成员';
}

/** Canonicalize a local profile without signing an anonymous visitor in. */
export function normalizeCurrentUser(user: LocalUser | null): LocalUser | null {
  if (!user || typeof user.name !== 'string' || typeof user.email !== 'string') return null;
  const email = user.email.trim().toLowerCase();
  if (!email || formerDemoEmails.has(email)) return null;
  if (email === administrator.email) return { name: administrator.name, email: administrator.email };
  const name = user.name.trim();
  return name ? { name, email } : null;
}

export function getWorkspaceMembers(user: LocalUser | null): WorkspaceMember[] {
  const current = normalizeCurrentUser(user);
  if (!current || current.email === administrator.email) return [administrator];
  return [administrator, {
    ...current,
    initial: current.name.slice(-1),
    role: roleForEmail(current.email),
    joined: new Date().toLocaleDateString('zh-CN').replace(/\//g, '.'),
    color: '#eae3f8',
  }];
}
