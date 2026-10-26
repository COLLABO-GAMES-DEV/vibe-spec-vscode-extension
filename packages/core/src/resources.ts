import { folderAddress, folderStorage, folderNameError, physicalFolders } from './folder-names.js';
import { pathParts } from './paths.js';
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
    if (!entry || kind && entry.kind !== kind) return [];
    // The loader reports malformed folder markers; keep unrelated resources readable.
    try { return [{ ...entry, folder: entry.kind === 'schema' ? entry.folder : folderAddress(project, entry.folder) }]; }
    catch (error) { if (!(error instanceof VibeError)) throw error; return [entry]; }
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
  let parts: string[];
  try { parts = pathParts(folder); } catch { return '잘못된 폴더 주소 이스케이프입니다.'; }
  for (const part of parts) {
    const error = folderNameError(part);
    if (error) return error + ' 이름 제안: ' + suggestResourceName(part);
  }
  if (resourceNameKey(parts[0]!) === 'assets') return '최상위 assets는 이미지 저장소 예약 이름입니다. 이름 제안: assets_domain';
}
export function resourcePath(kind: ResourceKind, name: string, folder = '', project?: Project): string {
  const error = resourceNameError(name) ?? folderError(folder);
  if (error) throw new VibeError('NAME_INVALID', error);
  if (project) folder = folderStorage(project, folder);
  return roots[kind] + '/' + (folder ? folder + '/' : '') + name + (kind === 'document' ? '.md' : '.yaml');
}
export function listFolders(project: Project): string[] {
  return physicalFolders(project).map(folder => {
    try { return folderAddress(project, folder); }
    catch (error) { if (!(error instanceof VibeError)) throw error; return folder; }
  }).sort((a, b) => compareResourceNames(pathParts(a).join(' / '), pathParts(b).join(' / ')) || compareResourceNames(a, b));
}
