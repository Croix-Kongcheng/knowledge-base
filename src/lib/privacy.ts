/** The owner has explicitly excluded this directory from this shared space. */
export const PRIVATE_FOLDER_LABEL = '02私有资料';

/**
 * Match directory segments, including Windows separators and common spacing.
 * Check the original path as well as any normalized import path: resolving `..`
 * must never accidentally turn a private selection into an eligible file.
 */
export function isExcludedPath(path: string): boolean {
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* Keep malformed paths literal. */ }
  return decoded.replace(/\\/g, '/').split('/').some((segment) => {
    const compact = segment.normalize('NFKC').replace(/[\s._\-—–·]+/gu, '');
    return compact === '02私有资料' || compact === '2私有资料';
  });
}
