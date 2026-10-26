import type { ImportedNote } from './importer';

export interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  count: number;
  notes: ImportedNote[];
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export const comparePaths = (a: string, b: string) => collator.compare(a, b);

export function getNotePath(note: ImportedNote): string {
  return (note.path || `${note.category || '未分类'}/${note.title.replace(/[\\/]/g, '／')}.md`)
    .replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/');
}

export function getFolderPath(note: ImportedNote): string {
  const path = getNotePath(note);
  const end = path.lastIndexOf('/');
  return end < 0 ? '' : path.slice(0, end);
}

export function getCategories(notes: ImportedNote[]): string[] {
  return [...new Set(notes.map(note => getFolderPath(note).split('/')[0] || '未分类'))].sort(comparePaths);
}

export function getFolderPaths(notes: ImportedNote[], extraFolderPaths: string[] = []): string[] {
  const paths = new Set<string>();
  for (const folderPath of [...notes.map(getFolderPath), ...extraFolderPaths]) {
    const segments = folderPath.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
    segments.forEach((_, index) => paths.add(segments.slice(0, index + 1).join('/')));
  }
  return [...paths].sort(comparePaths);
}

/** Directory names and hierarchy come from the vault; no suggested taxonomy is imposed. */
export function buildFolderTree(notes: ImportedNote[], extraFolderPaths: string[] = []): FolderNode[] {
  const roots: FolderNode[] = [];
  const byPath = new Map<string, FolderNode>();
  const addPath = (folderPath: string, note?: ImportedNote) => {
    const segments = folderPath.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
    let siblings = roots;
    for (let index = 0; index < segments.length; index += 1) {
      const path = segments.slice(0, index + 1).join('/');
      const key = path.normalize('NFC').toLocaleLowerCase();
      let folder = byPath.get(key);
      if (!folder) {
        folder = { name: segments[index], path, children: [], count: 0, notes: [] };
        byPath.set(key, folder);
        siblings.push(folder);
      }
      if (note) folder.count += 1;
      if (note && index === segments.length - 1) folder.notes.push(note);
      siblings = folder.children;
    }
  };
  for (const note of notes) addPath(getFolderPath(note), note);
  for (const path of extraFolderPaths) addPath(path);
  const sort = (folders: FolderNode[]) => {
    folders.sort((a, b) => comparePaths(a.name, b.name));
    folders.forEach(folder => {
      folder.notes.sort((a, b) => comparePaths(a.title, b.title));
      sort(folder.children);
    });
  };
  sort(roots);
  return roots;
}
