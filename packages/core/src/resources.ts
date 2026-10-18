import { posix } from 'node:path';
import type { Project } from './types.js';
import { VibeError } from './types.js';
import { compareResourceNames, resourceNameError, resourceNameKey, suggestResourceName } from './names.js';

export type ResourceKind = 'table' | 'schema' | 'document';
export interface ResourceEntry { kind: ResourceKind; name: string; file: string; folder: string }
const roots = { table: 'tables', schema: 'schemas', document: 'documents' } as const;
export function resourceEntry(file: string): ResourceEntry | undefined {
  const match = /^(tables|schemas|documents)\/(.+)\.(yaml|md)$/.exec(file);
  if (!match || (match[1] === 'documents' ? match[3] !== 'md' || match[2]!.startsWith('assets/') : match[3] !== 'yaml')) return;
  const kind = match[1] === 'tables' ? 'table' : match[1] === 'schemas' ? 'schema' : 'document';
  const folder = posix.dirname(match[2]!);
  return { kind, name: posix.basename(match[2]!), file, folder: folder === '.' ? '' : folder };
}
export function resourceEntries(project: Project, kind?: ResourceKind): ResourceEntry[] {
  return [...project.sources.keys()].flatMap(file => {
    const entry = resourceEntry(file);
    return entry && (!kind || entry.kind === kind) ? [entry] : [];
  });
}
/** Exact public names, but refuse ambiguous filesystem identities. */
export function resourceFile(project: Project, kind: ResourceKind, name: string): string | undefined {
  const matches = resourceEntries(project).filter(entry => (kind === 'schema' ? entry.kind === 'schema' : entry.kind !== 'schema')
    && resourceNameKey(entry.name) === resourceNameKey(name));
  return matches.length === 1 && matches[0]!.kind === kind && matches[0]!.name === name ? matches[0]!.file : undefined;
}
export function folderError(folder: string): string | undefined {
  if (typeof folder !== 'string') return '폴더 경로는 문자열이어야 합니다.';
  if (folder === '') return;
  for (const part of folder.split('/')) {
    const error = resourceNameError(part);
    if (error) return error + ' 이름 제안: ' + suggestResourceName(part);
  }
  if (resourceNameKey(folder.split('/')[0]!) === 'assets') return '최상위 assets는 이미지 저장소 예약 이름입니다. 이름 제안: assets_domain';
}
export function resourcePath(kind: ResourceKind, name: string, folder = ''): string {
  const error = resourceNameError(name) ?? folderError(folder);
  if (error) throw new VibeError('NAME_INVALID', error);
  return roots[kind] + '/' + (folder ? folder + '/' : '') + name + (kind === 'document' ? '.md' : '.yaml');
}
export function listFolders(project: Project): string[] {
  const folders = new Set<string>();
  const add = (folder: string) => {
    const parts = folder.split('/');
    for (let i = 1; i <= parts.length; i++) if (parts.slice(0, i).join('/')) folders.add(parts.slice(0, i).join('/'));
  };
  for (const path of project.directories ?? []) {
    if (/^(tables|documents)\//.test(path) && !/^documents\/assets(?:\/|$)/.test(path)) add(path.slice(path.indexOf('/') + 1));
  }
  for (const entry of resourceEntries(project)) if (entry.kind !== 'schema') add(entry.folder);
  for (const file of project.sources.keys()) if (/^(tables|documents)\/.+\/\.gitkeep$/.test(file)) add(file.slice(file.indexOf('/') + 1, -9));
  return [...folders].sort(compareResourceNames);
}
