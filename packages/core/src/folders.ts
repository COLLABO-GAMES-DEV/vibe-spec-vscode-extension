import { folderStorage, folderMarkers, physicalFolders } from './folder-names.js';
import { pathParts, pathFromParts } from './paths.js';
import { lstat, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { FolderOperation } from './folder-types.js';
import type { MutationOptions, Project, WriteResult } from './types.js';
import { VibeError } from './types.js';
import { mutateProject } from './project.js';
import { folderError, listFolders, resourceEntry, resourceFile, resourcePath } from './resources.js';
import { resourceNameError, resourceNameKey, suggestResourceName } from './names.js';

const roots = ['tables', 'documents'] as const;
function validFolder(folder: string, rootAllowed = false): void {
  const error = folderError(folder) ?? (!rootAllowed && !folder ? 'Choose a domain folder.' : undefined);
  if (error) throw new VibeError('NAME_INVALID', error);
}
function ancestors(folder: string): string[] {
  return folder ? folder.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')) : [];
}
function requireFolder(project: Project, folder: string): void {
  if (folder && !physicalFolders(project).includes(folder)) throw new VibeError('FOLDER_NOT_FOUND', 'Unknown domain folder: ' + folder);
}

// Check both physical roots, including entries not included in the project snapshot.
// Never silently merge folders whose spelling only differs by case or Unicode form.
async function checkDestination(project: Project, folder: string, vacant = false): Promise<void> {
  for (const root of roots) {
    let parent: string = root;
    for (const part of folder.split('/').filter(Boolean)) {
      let entries;
      try {
        const info = await lstat(join(project.root, parent));
        if (!info.isDirectory() || info.isSymbolicLink()) throw new VibeError('FILE_UNSUPPORTED', 'Expected a regular directory: ' + parent);
        entries = await readdir(join(project.root, parent), { withFileTypes: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
      const matches = entries.filter(entry => resourceNameKey(entry.name) === resourceNameKey(part));
      const path = parent + '/' + part;
      if (matches.some(entry => entry.name !== part) || vacant && path === root + '/' + folder && matches.length) {
        throw new VibeError('NAME_EXISTS', 'The destination is occupied: ' + path);
      }
      if (matches.some(entry => !entry.isDirectory() || entry.isSymbolicLink())) {
        throw new VibeError('FILE_UNSUPPORTED', 'Expected a regular directory: ' + path);
      }
      parent = path;
    }
  }
}

function preserveFolders(project: Project, changes: Map<string, string | null>, folders: readonly string[]): void {
  for (const folder of new Set(folders.flatMap(ancestors))) for (const root of roots) {
    const file = root + '/' + folder + '/.gitkeep';
    if (!changes.has(file)) changes.set(file, project.sources.get(file) ?? '');
  }
}

/** Logical domains span tables/ and documents/. Sources are copied verbatim. */
export async function applyFolderEdit(
  root: string, expectedRevision: string, operation: FolderOperation, options: MutationOptions = {},
): Promise<WriteResult> {
  if (!operation || !['folder-create', 'folder-rename', 'folder-move', 'folder-delete', 'resource-move'].includes(operation.op)) {
    throw new VibeError('OPERATION_INVALID', 'Unknown folder operation.');
  }
  const requested = operation;
  const cleanupDirectories: string[] = [];
  return mutateProject(root, expectedRevision, async project => {
    let operation = requested;
    let markerAddress: string | undefined;
    if (requested.op === 'resource-move') {
      validFolder(requested.folder, true);
      markerAddress = requested.folder;
      operation = { ...requested, folder: folderStorage(project, requested.folder) };
    } else {
      validFolder(requested.path);
      const path = folderStorage(project, requested.path);
      if (requested.op === 'folder-create') { markerAddress = requested.path; operation = { ...requested, path }; }
      else if (requested.op === 'folder-rename') {
        markerAddress = pathFromParts([...pathParts(requested.path).slice(0, -1), requested.name]);
        validFolder(markerAddress);
        operation = { ...requested, path, name: posix.basename(folderStorage(project, markerAddress)) };
      } else if (requested.op === 'folder-move') {
        validFolder(requested.folder, true);
        markerAddress = pathFromParts([...(requested.folder ? pathParts(requested.folder) : []), pathParts(requested.path).at(-1)!]);
        // Existing move logic preserves the physical basename; choose the destination spelling explicitly below.
        operation = { ...requested, path, folder: folderStorage(project, requested.folder) };
      } else operation = { ...requested, path };
    }
    const changes = new Map<string, string | null>();
    const markers = (storage: string, replaceLeaf = false) => {
      if (!markerAddress) return;
      for (const [file, value] of folderMarkers(markerAddress, storage)) {
        if (replaceLeaf && file === 'tables/' + storage + '/.gitkeep' || replaceLeaf && file === 'documents/' + storage + '/.gitkeep' || !project.sources.has(file)) changes.set(file, value);
      }
    };
    if (operation.op === 'resource-move') {
      if (operation.kind !== 'table' && operation.kind !== 'document') throw new VibeError('OPERATION_INVALID', 'Only tables and documents can move between domains.');
      validFolder(operation.folder, true);
      requireFolder(project, operation.folder);
      await checkDestination(project, operation.folder);
      const source = resourceFile(project, operation.kind, operation.name);
      if (!source) throw new VibeError('PATH_NOT_FOUND', 'Unknown or ambiguous resource: ' + operation.name);
      const destination = resourcePath(operation.kind, operation.name, operation.folder);
      if (source === destination) return changes;
      const parent = posix.dirname(destination);
      let entries: string[] = [];
      try { entries = await readdir(join(root, parent)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (entries.some(name => resourceNameKey(name) === resourceNameKey(posix.basename(destination)))) {
        throw new VibeError('NAME_EXISTS', 'The destination is occupied: ' + destination);
      }
      changes.set(destination, project.sources.get(source)!);
      changes.set(source, null);
      preserveFolders(project, changes, [resourceEntry(source)!.folder, operation.folder]);
      markers(operation.folder);
      return changes;
    }

    validFolder(operation.path);
    if (operation.op === 'folder-create') {
      await checkDestination(project, operation.path, true);
      preserveFolders(project, changes, [operation.path]);
      markers(operation.path);
      return changes;
    }
    requireFolder(project, operation.path);
    await checkDestination(project, operation.path);
    let destination: string | undefined;
    if (operation.op === 'folder-rename') {
      const error = resourceNameError(operation.name);
      if (error) throw new VibeError('NAME_INVALID', error + ' 이름 제안: ' + suggestResourceName(operation.name));
      const parent = posix.dirname(operation.path);
      destination = (parent === '.' ? '' : parent + '/') + operation.name;
    } else if (operation.op === 'folder-move') {
      validFolder(operation.folder, true);
      requireFolder(project, operation.folder);
      destination = folderStorage(project, markerAddress!);
    }
    if (destination !== undefined) {
      validFolder(destination);
      if (destination === operation.path) return changes;
      if (resourceNameKey(destination) === resourceNameKey(operation.path)) {
        throw new VibeError('NAME_EXISTS', 'Case-only or Unicode-equivalent renames require an intermediate name. 이름 제안: ' +
          suggestResourceName(posix.basename(operation.path), listFolders(project).map(folder => posix.basename(folder))));
      }
      if (resourceNameKey(destination).startsWith(resourceNameKey(operation.path) + '/')) {
        throw new VibeError('FOLDER_SELF', 'A folder cannot move into its own subtree.');
      }
      await checkDestination(project, destination, true);
    }

    const movedFolders = new Set<string>();
    const scan = async (path: string, target?: string): Promise<void> => {
      let entries;
      try {
        const info = await lstat(join(root, path));
        if (!info.isDirectory() || info.isSymbolicLink()) throw new VibeError('FILE_UNSUPPORTED', 'Expected a regular directory: ' + path);
        entries = await readdir(join(root, path), { withFileTypes: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      cleanupDirectories.push(path);
      if (target) movedFolders.add(target.slice(target.indexOf('/') + 1));
      for (const entry of entries) {
        const file = path + '/' + entry.name;
        if (target === undefined && (entry.name !== '.gitkeep' || !entry.isFile())) {
          throw new VibeError('FOLDER_NOT_EMPTY', 'The domain contains a file or subfolder: ' + file);
        }
        if (entry.isDirectory()) {
          validFolder(file.slice(file.indexOf('/') + 1));
          await checkDestination(project, file.slice(file.indexOf('/') + 1));
          await scan(file, target + '/' + entry.name);
        } else if (entry.isFile() && (entry.name === '.gitkeep' || resourceEntry(file)) && project.sources.has(file)) {
          if (target) changes.set(target + '/' + entry.name, project.sources.get(file)!);
          changes.set(file, null);
        } else throw new VibeError('FILE_UNSUPPORTED', 'Cannot move an unmanaged file or symbolic link: ' + file);
      }
    };
    for (const side of roots) await scan(side + '/' + operation.path, destination === undefined ? undefined : side + '/' + destination);
    const parent = posix.dirname(operation.path);
    preserveFolders(project, changes, [...movedFolders, ...(parent === '.' ? [] : [parent])]);
    if (destination) markers(destination, true);
    return changes;
  }, { ...options, cleanupDirectories });
}
