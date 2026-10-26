import { VibeError } from './types.js';

/** Explicit namespace: no previously valid resource name was a single dot. */
export function pathParts(path: string): string[] {
  if (!path.startsWith('./')) return path.split('/');
  return path.slice(2).split('/').map(part => {
    if (/~(?![01])/.test(part)) throw new VibeError('PATH_INVALID', 'Invalid address escape; use ~0 for ~ and ~1 for /.');
    return part.replace(/~[01]/g, escape => escape === '~1' ? '/' : '~');
  });
}
export function pathFromParts(parts: readonly string[]): string {
  return parts.some(part => part.includes('/'))
    ? './' + parts.map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
    : parts.join('/');
}
export function appendPath(path: string, ...parts: string[]): string { return pathFromParts([...pathParts(path), ...parts]); }
export function pathContains(parent: string, child: string): boolean {
  const a = pathParts(parent), b = pathParts(child);
  return a.length <= b.length && a.every((part, index) => part === b[index]);
}
export function canonicalPath(path: string): string { return pathFromParts(pathParts(path)); }
