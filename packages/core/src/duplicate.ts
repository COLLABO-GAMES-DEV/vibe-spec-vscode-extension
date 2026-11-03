import { isScalar } from 'yaml';
import type { MutationOptions, Project, WriteResult } from './types.js';
import { VibeError } from './types.js';
import { mutateProject } from './project.js';
import { resourceEntries, resourceEntry, resourceFile, resourcePath } from './resources.js';
import { resourceNameError, resourceNameKey, suggestResourceName } from './names.js';
import { tableContexts } from './validation.js';

export type DuplicateKind = 'table' | 'document';

/** Table copies own their schema; neither references nor Markdown links are retargeted. */
export function duplicateNameError(project: Project, kind: DuplicateKind, name: string): string | undefined {
  const invalid = resourceNameError(name);
  const occupied = resourceEntries(project).filter(entry => kind === 'table' || entry.kind !== 'schema').map(entry => entry.name);
  if (invalid || occupied.some(other => resourceNameKey(other) === resourceNameKey(name))) {
    return (invalid ?? '이미 사용하는 표·문서 또는 스키마 이름입니다.') + ' 이름 제안: ' + suggestResourceName(name, occupied);
  }
  return undefined;
}

export async function duplicateResource(
  root: string, revision: string, kind: DuplicateKind, name: string, to: string, options: MutationOptions = {},
): Promise<WriteResult> {
  if (!['table', 'document'].includes(kind) || typeof name !== 'string' || typeof to !== 'string') {
    throw new VibeError('INVALID_ARGUMENT', 'Use duplicate table|document <name> --to <new name>.');
  }
  return mutateProject(root, revision, before => {
    const file = resourceFile(before, kind, name);
    if (!file) throw new VibeError('PATH_NOT_FOUND', 'Unknown resource: ' + name);
    const error = duplicateNameError(before, kind, to);
    if (error) throw new VibeError(resourceNameError(to) ? 'NAME_INVALID' : 'NAME_EXISTS', error);
    const destination = resourcePath(kind, to, resourceEntry(file)!.folder);
    const source = before.sources.get(file)!;
    if (kind === 'document') return new Map([[destination, source]]);
    const context = tableContexts(before).get(name);
    if (!context) throw new VibeError('INVALID_TABLE', 'Cannot duplicate a table with an unreadable schema: ' + name);
    const schemaFile = resourceFile(before, 'schema', context.table.schema)!;
    const schema = before.sources.get(schemaFile)!;
    const node = context.file.document.get('schema', true);
    if (!isScalar(node) || !node.range) throw new VibeError('INVALID_TABLE', 'Expected a schema name.');
    const copied = source.slice(0, node.range[0]) + JSON.stringify(to) + source.slice(node.range[1]);
    return new Map([
      [resourcePath('schema', to, resourceEntry(schemaFile)!.folder), schema],
      [destination, copied],
    ]);
  }, options);
}
