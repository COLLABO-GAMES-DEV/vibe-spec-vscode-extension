import { pathParts, pathFromParts, canonicalPath } from './paths.js';
import { resourceEntries, resourceEntry, resourceFile, resourcePath } from './resources.js';
import { renameDocument } from './documents.js';
import { renameDocumentLinks } from './document-references.js';
import { Ajv } from 'ajv';
import { isMap, isScalar, isSeq } from 'yaml';
import type { Cell, EditOperation, MutationOptions, Project, RenameKind, TableSchema, WriteResult, YamlFile } from './types.js';
import { isRecord, validName, VibeError } from './types.js';
import { formatYaml, parseYaml, updateCell } from './yaml.js';
import { mutateProject, projectWithChanges } from './project.js';
import { declaredReferences, deletionDiagnostics, tableContexts } from './validation.js';
import { textCandidates, whereUsed } from './usage.js';
import { resourceNameError, resourceNameKey, suggestResourceName } from './names.js';
import { hasPlanAddedRow, renamePlanReferences } from './plan-references.js';
import { readVariant } from './plans.js';

const cells = { type: 'object', additionalProperties: { type: ['string', 'boolean', 'null'] } };
const checkOperations = new Ajv({ allErrors: true, allowUnionTypes: true }).compile<EditOperation[]>({
  type: 'array', minItems: 1,
  items: { oneOf: [
    { type: 'object', required: ['op', 'table', 'row'], additionalProperties: false,
      properties: { op: { const: 'create' }, table: { type: 'string' }, row: cells } },
    { type: 'object', required: ['op', 'table', 'key', 'values'], additionalProperties: false,
      properties: { op: { const: 'update' }, table: { type: 'string' }, key: { type: 'string' }, values: cells } },
    { type: 'object', required: ['op', 'table', 'key'], additionalProperties: false,
      properties: { op: { const: 'delete' }, table: { type: 'string' }, key: { type: 'string' } } },
  ] },
});

function context(project: Project, name: string) {
  if (!validName(name)) throw new VibeError('PATH_INVALID', 'Invalid table name.');
  const found = tableContexts(project).get(name);
  if (!found) throw new VibeError('PATH_NOT_FOUND', 'Unknown table or invalid schema: ' + name);
  return found;
}
function keyName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value === '*') {
    throw new VibeError('INVALID_KEY', 'Key must be a nonempty string without reserved *.');
  }
}
function rowIndex(project: Project, table: string, key: string): number {
  const { table: data, schema } = context(project, table);
  const found = data.rows.flatMap((row, i) => row[schema.primary_key] === key ? [i] : []);
  if (found.length !== 1) throw new VibeError('PATH_NOT_FOUND', 'Row Key is missing or ambiguous: ' + table + '/' + key);
  return found[0]!;
}

// Existing scalar edits use the parser's original ranges. Structural edits use its AST.
function scalar(file: YamlFile, path: (string | number)[], value: Cell): YamlFile {
  const node = file.document.getIn(path, true);
  if (!isScalar(node) || !node.range) throw new VibeError('INVALID_CELL', 'Expected a scalar at ' + path.join('/'));
  if (Object.is(node.value, value)) return file;
  return parseYaml(file.source.slice(0, node.range[0]) + JSON.stringify(value) + file.source.slice(node.range[1]), file.file);
}
function renameField(file: YamlFile, path: (string | number)[], from: string, to: string): YamlFile {
  const map = file.document.getIn(path, true);
  if (!isMap(map)) throw new VibeError('INVALID_CELL', 'Expected a mapping.');
  if (map.has(to)) throw new VibeError('NAME_EXISTS', 'Column already exists: ' + to);
  const key = map.items.find(pair => isScalar(pair.key) && pair.key.value === from)?.key;
  if (!isScalar(key) || !key.range) return file;
  return parseYaml(file.source.slice(0, key.range[0]) + JSON.stringify(to) + file.source.slice(key.range[1]), file.file);
}
function structural(file: YamlFile, schema: TableSchema, change: (doc: ReturnType<YamlFile['document']['clone']>) => void): YamlFile {
  const doc = file.document.clone();
  change(doc);
  return formatYaml(parseYaml(doc.toString({ lineWidth: 0 }), file.file), schema);
}
export function insertCell(file: YamlFile, schema: TableSchema, index: number, column: string, value: Cell): YamlFile {
  const row = file.document.getIn(['rows', index], true);
  if (!isMap(row) || row.flow || !row.range) {
    return structural(file, schema, doc => { doc.setIn(['rows', index, column], value); });
  }
  const eol = file.source.includes('\r\n') ? '\r\n' : '\n';
  const end = row.range[2];
  const indent = row.range[0] - file.source.lastIndexOf('\n', row.range[0] - 1) - 1;
  const name = /^[A-Za-z_][\w-]*$/.test(column) ? column : JSON.stringify(column);
  const prefix = file.source.slice(0, end);
  const line = ' '.repeat(indent) + name + ': ' + JSON.stringify(value);
  return parseYaml(prefix + (prefix.endsWith('\n') ? '' : eol) + line +
    (end === file.source.length && !file.source.endsWith('\n') ? '' : eol) + file.source.slice(end), file.file);
}

export function prepareEdits(before: Project, operations: EditOperation[]): Map<string, string> {
  if (!checkOperations(operations)) {
    throw new VibeError('INVALID_EDIT', 'Expected row create/update/delete operations with string, boolean or null values.');
  }
    let planned = before;
    const changes = new Map<string, string>();
    const deleted: { table: string; key: string; row: Record<string, unknown> }[] = [];
    for (const operation of operations) {
      const { file, table, schema } = context(planned, operation.table);
      let edited = file;
      if (operation.op === 'create') {
        const key = operation.row[schema.primary_key];
        keyName(key);
        if (table.rows.some(row => row[schema.primary_key] === key)) throw new VibeError('NAME_EXISTS', 'Key already exists: ' + key);
        for (const name of Object.keys(operation.row)) {
          if (!Object.hasOwn(schema.columns, name)) throw new VibeError('COLUMN_UNKNOWN', 'Unknown column: ' + name);
        }
        edited = structural(file, schema, doc => {
          const rows = doc.get('rows', true);
          if (!isSeq(rows)) throw new VibeError('INVALID_TABLE', 'Expected rows sequence.');
          rows.add(doc.createNode(operation.row));
        });
      } else {
        keyName(operation.key);
        const index = rowIndex(planned, operation.table, operation.key);
        if (operation.op === 'delete') {
          deleted.push({ table: operation.table, key: operation.key, row: table.rows[index]! });
          edited = structural(file, schema, doc => { doc.deleteIn(['rows', index]); });
        } else {
          for (const [column, value] of Object.entries(operation.values)) {
            if (column === schema.primary_key) throw new VibeError('RENAME_REQUIRED', 'Use rename to change a Key.');
            if (!Object.hasOwn(schema.columns, column)) throw new VibeError('COLUMN_UNKNOWN', 'Unknown column: ' + column);
            if (edited.document.hasIn(['rows', index, column])) edited = updateCell(edited, schema, operation.key, column, value);
            else edited = insertCell(edited, schema, index, column, value);
          }
        }
      }
      changes.set(file.file, edited.source);
      planned = projectWithChanges({ ...planned, files: new Map(planned.files).set(file.file, edited) },
        new Map([[file.file, edited.source]]));
    }
    // Check surviving references in the final batch, using the shared deletion guard.
    for (const removed of deleted) {
      const { file, table, schema } = context(planned, removed.table);
      if (table.rows.some(row => row[schema.primary_key] === removed.key)) continue;
      const probe = structural(file, schema, doc => {
        const rows = doc.get('rows', true);
        if (isSeq(rows)) rows.add(doc.createNode(removed.row));
      });
      const restored = projectWithChanges(planned, new Map([[file.file, probe.source]]));
      const guard = deletionDiagnostics(restored, removed.table, removed.key);
      // The composed reader strips plans, so its own row operations do not recurse
      // into this pass. Archives and invalid/uncomposable alternatives are not
      // live states; their diagnostics remain visible through normal validation.
      for (const path of restored.sources.keys()) {
        const match = /^plans\/([^/]+)\/(?!_plan\.yaml$)([^/]+)\.yaml$/.exec(path);
        if (!match) continue;
        const [, plan, variant] = match;
        try {
          const view = readVariant(restored, plan!, variant!);
          const context = tableContexts(view).get(removed.table);
          if (!context?.table.rows.some(row => row[context.schema.primary_key] === removed.key)) continue;
          guard.push(...deletionDiagnostics(view, removed.table, removed.key).map(item => ({
            ...item, target: pathFromParts([removed.table, removed.key]), message: plan + '/' + variant + ': ' + item.message,
          })));
        } catch (error) { if (!(error instanceof VibeError)) throw error; }
      }
      if (guard.length) throw new VibeError('DELETE_RESTRICTED', 'Declared references prevent deletion.', guard);
    }
    return changes;
}

export async function applyEdits(root: string, expectedRevision: string, operations: EditOperation[], options: MutationOptions = {}): Promise<WriteResult> {
  return mutateProject(root, expectedRevision, before => prepareEdits(before, operations), options);
}

function renamedResourcePath(project: Project, directory: 'tables' | 'schemas', from: string, to: string): string {
  const kind = directory === 'tables' ? 'table' : 'schema';
  const file = resourceFile(project, kind, from);
  if (!file) throw new VibeError('PATH_NOT_FOUND', 'Unknown resource: ' + from);
  const names = resourceEntries(project).filter(entry =>
    kind === 'schema' ? entry.kind === 'schema' : entry.kind !== 'schema').map(entry => entry.name);
  if (names.some(other => other !== from && resourceNameKey(other) === resourceNameKey(to))) {
    throw new VibeError('NAME_EXISTS', '프로젝트에 이미 같은 이름이 있습니다. 대소문자만 다른 이름도 중복입니다. 이름 제안: ' + suggestResourceName(to, names));
  }
  if (resourceNameKey(to) === resourceNameKey(from)) {
    throw new VibeError('CASE_ONLY_RENAME', '대소문자 또는 Unicode 정규화만 다른 이름으로 바로 바꿀 수 없습니다. ' +
      '다른 이름으로 변경하고 저장한 뒤 원하는 이름으로 변경해 주세요. 중간 이름 제안: ' + suggestResourceName(to, names));
  }
  return resourcePath(kind, to, resourceEntry(file)!.folder);
}

export async function renameResource(
  root: string, expectedRevision: string, kind: RenameKind, path: string, to: string, options: MutationOptions = {},
): Promise<WriteResult> {
  path = canonicalPath(path);
  if (kind === 'document' || kind === 'heading' || kind === 'tag') return renameDocument(root, expectedRevision, kind, path, to, options);
  if (!['table', 'schema', 'key', 'column'].includes(kind) || typeof to !== 'string') throw new VibeError('INVALID_ARGUMENT', 'Invalid rename kind or new name.');
  if (kind === 'table' || kind === 'schema') {
    const error = resourceNameError(to);
    if (error) throw new VibeError('NAME_INVALID', error + ' 이름 제안: ' + suggestResourceName(to));
  } else if (kind === 'key' ? !to.length || to === '*' : !validName(to)) throw new VibeError('INVALID_ARGUMENT', 'Invalid new name.');
  let candidates: WriteResult['candidates'] = [];
  const result = await mutateProject(root, expectedRevision, async before => {
    if (kind === 'schema') {
      if (!validName(path)) throw new VibeError('PATH_INVALID', 'Rename expects a schema name.');
      const filePath = resourceFile(before, 'schema', path);
      const source = filePath === undefined ? undefined : before.sources.get(filePath);
      if (filePath === undefined || source === undefined) throw new VibeError('PATH_NOT_FOUND', 'Unknown schema: ' + path);
      const changes = new Map<string, string | null>();
      if (to === path) return changes;
      const newPath = renamedResourcePath(before, 'schemas', path, to);
      candidates = await textCandidates(before, path);
      for (const [file, table] of before.files) {
        if (file.startsWith('tables/') && isRecord(table.data) && table.data.schema === path) {
          changes.set(file, scalar(table, ['schema'], to).source);
        }
      }
      changes.set(newPath, source);
      changes.set(filePath, null);
      return changes;
    }
    const [name, key, column, extra] = pathParts(path);
    const target = context(before, name!);
    if (extra !== undefined || (kind === 'table' && key !== undefined) ||
        (kind === 'key' && (key === undefined || column !== undefined)) ||
        (kind === 'column' && (key !== '*' || column === undefined))) {
      throw new VibeError('PATH_INVALID', 'Rename expects a table, table/key or table/*/column path.');
    }
    candidates = (await whereUsed(before, path)).candidates;
    const changes = new Map<string, string | null>();
    const currentFile = (file: YamlFile) => {
      const source = changes.get(file.file);
      return typeof source === 'string' ? parseYaml(source, file.file) : file;
    };
    if (kind === 'key') {
      keyName(to);
      if (to === key) return changes;
      if (target.table.rows.some(row => row[target.schema.primary_key] === to) || hasPlanAddedRow(before, pathFromParts([name!, to]))) {
        throw new VibeError('NAME_EXISTS', 'Key already exists in the baseline or an alternative: ' + to);
      }
      if (target.table.rows.some(row => row[target.schema.primary_key] === key)) {
        const index = rowIndex(before, name!, key!);
        const edited = scalar(target.file, ['rows', index, target.schema.primary_key], to);
        changes.set(edited.file, edited.source);
      } else if (!hasPlanAddedRow(before, pathFromParts([name!, key!]))) throw new VibeError('PATH_NOT_FOUND', 'Unknown row: ' + path);
      for (const reference of declaredReferences(before)) {
        if (reference.target !== name) continue;
        for (const [i, row] of reference.table.rows.entries()) {
          if (row[reference.field] !== key) continue;
          const file = currentFile(reference.file);
          changes.set(file.file, scalar(file, ['rows', i, reference.field], to).source);
        }
      }
      if (changes.has(target.file.file)) changes.set(target.file.file, formatYaml(currentFile(target.file), target.schema).source);
    } else if (kind === 'table') {
      if (to === name) return changes;
      const newPath = renamedResourcePath(before, 'tables', name!, to);
      for (const [filePath, file] of before.files) {
        if (!filePath.startsWith('schemas/') || !isRecord(file.data) || !isRecord(file.data.columns)) continue;
        for (const [field, definition] of Object.entries(file.data.columns)) {
          if (isRecord(definition) && definition.type === 'ref' && definition.table === name) {
            changes.set(filePath, scalar(currentFile(file), ['columns', field, 'table'], to).source);
          }
        }
      }
      changes.set(newPath, target.file.source);
      changes.set(target.file.file, null);
    } else {
      if (!Object.hasOwn(target.schema.columns, column!)) throw new VibeError('PATH_NOT_FOUND', 'Unknown column: ' + column);
      if (to === column) return changes;
      if (Object.hasOwn(target.schema.columns, to)) throw new VibeError('NAME_EXISTS', 'Column already exists: ' + to);
      const schemaFile = before.files.get(resourceFile(before, 'schema', target.table.schema)!)!;
      let edited = renameField(schemaFile, ['columns'], column!, to);
      if (target.schema.primary_key === column) edited = scalar(edited, ['primary_key'], to);
      for (const [i, fields] of (target.schema.unique ?? []).entries()) {
        for (const [j, field] of fields.entries()) if (field === column) edited = scalar(edited, ['unique', i, j], to);
      }
      changes.set(edited.file, edited.source);
      for (const [, item] of tableContexts(before)) {
        if (item.table.schema !== target.table.schema) continue;
        let file = item.file;
        for (const [i, row] of item.table.rows.entries()) {
          if (Object.hasOwn(row, column!)) file = renameField(file, ['rows', i], column!, to);
        }
        changes.set(file.file, file.source);
      }
    }
    for (const [file, source] of renameDocumentLinks(before, kind, path, to)) changes.set(file, source);
    for (const [file, source] of renamePlanReferences(before, kind, path, to)) changes.set(file, source);
    return changes;
  }, options);
  return { ...result, candidates };
}
