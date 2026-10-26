import type { Project } from './types.js';
import { VibeError } from './types.js';
import { pathParts, pathFromParts } from './paths.js';
import { resourceNameError, resourceNameKey, suggestResourceName } from './names.js';

type FolderProject = Pick<Project, 'sources' | 'directories'>;
export function folderNameError(name: string): string | undefined {
  return resourceNameError(name.replaceAll('/', '_'));
}
export function physicalFolders(project: FolderProject): string[] {
  const result = new Set<string>();
  const add = (file: string) => {
    const parts = file.split('/');
    if (!['tables', 'documents'].includes(parts[0]!) || parts[0] === 'documents' && parts[1] === 'assets') return;
    for (let i = 2; i <= parts.length; i++) result.add(parts.slice(1, i).join('/'));
  };
  for (const folder of project.directories ?? []) add(folder);
  for (const file of project.sources.keys()) add(file.slice(0, file.lastIndexOf('/')));
  return [...result].filter(Boolean);
}
function storedName(project: FolderProject, folder: string): string {
  const names = ['tables', 'documents'].flatMap(root => {
    const source = project.sources.get(root + '/' + folder + '/.gitkeep');
    if (!source?.trim().startsWith('{')) return [];
    let data;
    try { data = JSON.parse(source); } catch { return []; } // Old arbitrary .gitkeep contents remain opaque.
    if (data?.vibe_folder !== 1) return [];
    if (typeof data.name !== 'string' || folderNameError(data.name)) throw new VibeError('FOLDER_NAME_INVALID', 'Invalid domain name in ' + root + '/' + folder + '/.gitkeep');
    return [data.name as string];
  });
  if (new Set(names).size > 1) throw new VibeError('FOLDER_NAME_COLLISION', 'Domain markers disagree: ' + folder);
  return names[0] ?? folder.split('/').at(-1)!;
}
export function folderAddress(project: FolderProject, physical: string): string {
  if (!physical) return '';
  return pathFromParts(physical.split('/').map((_, i, parts) => storedName(project, parts.slice(0, i + 1).join('/'))));
}
export function folderStorage(project: FolderProject, address: string): string {
  if (!address) return '';
  const folders = physicalFolders(project);
  let physical = '';
  for (const name of pathParts(address)) {
    const error = folderNameError(name);
    if (error) throw new VibeError('FOLDER_NAME_INVALID', error);
    const children = folders.filter(folder => folder.split('/').slice(0, -1).join('/') === physical);
    const matches = children.filter(folder => resourceNameKey(storedName(project, folder)) === resourceNameKey(name));
    if (matches.length > 1 || matches.length === 1 && storedName(project, matches[0]!) !== name) {
      throw new VibeError('NAME_EXISTS', 'A domain with the same name already exists (case-insensitive): ' + name + ' 이름 제안: ' + suggestResourceName(matches.length ? storedName(project, matches[0]!) : name, children.map(folder => storedName(project, folder))));
    }
    if (matches.length) { physical = matches[0]!; continue; }
    const encoded = name.includes('/') ? name.replaceAll('~', '~0').replaceAll('/', '~1') : name;
    let candidate = encoded, suffix = 2;
    const occupied = new Set(children.map(folder => resourceNameKey(folder.split('/').at(-1)!)));
    while (occupied.has(resourceNameKey(candidate))) candidate = encoded + '~' + suffix++;
    const pathError = resourceNameError(candidate);
    if (pathError) throw new VibeError('FOLDER_NAME_INVALID', pathError);
    physical = physical ? physical + '/' + candidate : candidate;
  }
  return physical;
}
/** Metadata only for names whose directory spelling differs. Existing empty markers remain empty. */
export function folderMarkers(address: string, storage: string): Map<string, string> {
  const changes = new Map<string, string>(), names = pathParts(address), parts = storage.split('/');
  for (let i = 0; i < names.length; i++) {
    const folder = parts.slice(0, i + 1).join('/');
    for (const root of ['tables', 'documents']) changes.set(root + '/' + folder + '/.gitkeep',
      names[i] === parts[i] ? '' : JSON.stringify({ vibe_folder: 1, name: names[i] }) + '\n');
  }
  return changes;
}
export function newFolderMarkers(project: FolderProject, address: string): Map<string, string> {
  if (!address) return new Map();
  return new Map([...folderMarkers(address, folderStorage(project, address))].filter(([file, value]) => value !== '' && !project.sources.has(file)));
}
