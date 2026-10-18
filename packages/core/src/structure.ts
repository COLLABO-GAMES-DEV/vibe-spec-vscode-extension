import { resourceEntries, resourceEntry, resourceFile, resourcePath } from './resources.js';
import { Ajv } from 'ajv';
import { isMap, isScalar, isSeq } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import type { Column, MutationOptions, Project, TableSchema, Usage, WriteResult, YamlFile } from './types.js';
import { isRecord, VibeError } from './types.js';
import type { ColumnPosition, StructureOperation, StructurePreview } from './structure-types.js';
import { compareResourceNames, resourceNameError, resourceNameKey, suggestResourceName, tableNameError, validColumnCode } from './names.js';
import { applyEdits } from './editing.js';
import { mutateProject } from './project.js';
import { schemaDiagnostics, tableContexts } from './validation.js';
import { whereUsed } from './usage.js';
import { formatYaml, parseYaml } from './yaml.js';

const name = { type: 'string', minLength: 1, pattern: '^[^/]+$' };
const position = { type: 'object', required: ['anchor', 'side'], additionalProperties: false,
  properties: { anchor: name, side: { enum: ['before', 'after'] } } };
const structureOps = ['column-add', 'column-update', 'column-delete', 'column-move', 'table-create', 'table-delete'];
const checkOperation = new Ajv({ allErrors: true, ownProperties: true }).compile<StructureOperation>({
  oneOf: [
    ['column-add', { column: name, definition: { type: 'object' }, position }, ['column', 'definition']],
    ['column-update', { column: name, changes: { type: 'object' } }, ['column', 'changes']],
    ['column-delete', { column: name }, ['column']],
    ['column-move', { column: name, position }, ['column', 'position']],
    ['table-create', { folder: { type: 'string' }, key: { type: 'object', required: ['code', 'label'], additionalProperties: false,
      properties: { code: name, label: { type: 'string' } } } }, ['key']],
    ['table-delete', {}, []],
  ].map(([op, properties, required]) => ({
    type: 'object', required: ['op', 'table', ...(required as string[])], additionalProperties: false,
    properties: { op: { const: op }, table: op === 'table-create' ? { type: 'string' } : name, ...(properties as object) },
  })),
});

function sharedTables(project: Project, schema: string): YamlFile[] {
  return [...project.files.values()].filter(file => file.file.startsWith('tables/') &&
    isRecord(file.data) && file.data.schema === schema);
}

function checkedSchema(file: YamlFile, data: TableSchema): void {
  const diagnostics = schemaDiagnostics({ ...file, data });
  if (diagnostics.length) throw new VibeError('INVALID_SCHEMA', 'The column definition would make the schema invalid.', diagnostics);
}

function moveColumn(document: ReturnType<YamlFile['document']['clone']>, column: string, position: ColumnPosition): void {
  const columns = document.get('columns', true);
  if (!isMap(columns)) throw new VibeError('INVALID_SCHEMA', 'Expected a columns mapping.');
  const index = (code: string) => columns.items.findIndex(pair => isScalar(pair.key) && pair.key.value === code);
  if (index(position.anchor) < 0) throw new VibeError('COLUMN_UNKNOWN', 'Unknown position anchor: ' + position.anchor);
  if (column === position.anchor) return;
  const [pair] = columns.items.splice(index(column), 1);
  columns.items.splice(index(position.anchor) + (position.side === 'after' ? 1 : 0), 0, pair!);
}

function schemaUsage(file: YamlFile, column: string): Usage {
  const node = file.document.getIn(['columns', column, 'table'], true) as { range?: number[] } | undefined;
  const line = file.source.slice(0, node?.range?.[0] ?? 0).split('\n').length;
  return { file: file.file, path: 'columns/' + column + '/table', line, text: file.source.split('\n')[line - 1] ?? '' };
}

/** Preview and apply share the same plan; only mutateProject performs writes. */
async function prepare(project: Project, operation: StructureOperation) {
  const preview: StructurePreview = { operation, revision: project.revision, tables: [], files: [],
    usages: { references: [], candidates: [] } };
  const changes = new Map<string, string | null>();
  let failure: VibeError | undefined;
  try {
    if (!checkOperation(operation)) throw new VibeError('INVALID_EDIT', 'Expected a valid column or table structure operation.');
    if (operation.op === 'table-create') {
      const tableNames = resourceEntries(project).filter(entry => entry.kind !== 'schema').map(entry => entry.name);
      const error = tableNameError(operation.table, tableNames);
      if (error) throw new VibeError(resourceNameError(operation.table) ? 'NAME_INVALID' : 'NAME_EXISTS', error);
      if (!validColumnCode(operation.key.code)) throw new VibeError('INVALID_COLUMN_CODE', 'New column codes must contain only lowercase English letters, digits and _.');
      const tablePath = resourcePath('table', operation.table, operation.folder);
      const schemaNames = resourceEntries(project, 'schema').map(entry => entry.name);
      const occupied = new Set(schemaNames.map(resourceNameKey));
      let schemaName = operation.table;
      for (let suffix = 2; occupied.has(resourceNameKey(schemaName)); suffix++) schemaName = operation.table + '_' + suffix;
      const schemaError = resourceNameError(schemaName);
      if (schemaError) throw new VibeError('NAME_INVALID', schemaError + ' 이름 제안: ' + suggestResourceName(schemaName, schemaNames));
      const schemaPath = resourcePath('schema', schemaName);
      const schema: TableSchema = { primary_key: operation.key.code, columns: {
        [operation.key.code]: { type: 'string', label: operation.key.label },
      } };
      changes.set(schemaPath, formatYaml(parseYaml(JSON.stringify(schema), schemaPath)).source);
      changes.set(tablePath, formatYaml(parseYaml(JSON.stringify({ schema: schemaName, rows: [] }), tablePath), schema).source);
      preview.tables = [operation.table];
      preview.files = [...changes.keys()].sort();
      return { preview, changes, failure };
    }

    const target = tableContexts(project).get(operation.table);
    if (!target) throw new VibeError('PATH_NOT_FOUND', 'Unknown table or invalid schema: ' + operation.table);
    const schemaFile = project.files.get(resourceFile(project, 'schema', target.table.schema)!)!;
    const shared = sharedTables(project, target.table.schema);
    preview.tables = shared.map(file => resourceEntry(file.file)!.name).sort(compareResourceNames);
    preview.files = [schemaFile.file];

    if (operation.op === 'table-delete') {
      preview.tables = [operation.table];
      preview.files = [target.file.file, ...(shared.length === 1 ? [schemaFile.file] : [])].sort();
      preview.usages = await whereUsed(project, operation.table);
      const blockers: string[] = [];
      // Inspect declarations even when another part of the source table/schema is invalid.
      for (const file of project.files.values()) {
        if (!file.file.startsWith('tables/') || file.file === target.file.file || !isRecord(file.data)) continue;
        const sourceSchema = project.files.get(resourceFile(project, 'schema', String(file.data.schema))!);
        if (!sourceSchema || !isRecord(sourceSchema.data) || !isRecord(sourceSchema.data.columns)) continue;
        for (const [column, definition] of Object.entries(sourceSchema.data.columns)) {
          if (!isRecord(definition) || definition.type !== 'ref' || definition.table !== operation.table) continue;
          blockers.push(resourceEntry(file.file)!.name + '/*/' + column);
          const usage = schemaUsage(sourceSchema, column);
          if (!preview.usages.references.some(item => item.file === usage.file && item.path === usage.path)) {
            preview.usages.references.push(usage);
          }
        }
      }
      if (blockers.length) throw new VibeError('DELETE_RESTRICTED', 'Other tables declare references to this table: ' + blockers.join(', '));
      for (const file of preview.files) changes.set(file, null);
    } else {
      const { column } = operation;
      const exists = Object.hasOwn(target.schema.columns, column);
      if (operation.op === 'column-add') {
        if (!validColumnCode(column)) throw new VibeError('INVALID_COLUMN_CODE', 'New column codes must contain only lowercase English letters, digits and _.');
        if (exists) throw new VibeError('NAME_EXISTS', 'Column already exists: ' + column);
      } else {
        if (!exists) throw new VibeError('COLUMN_UNKNOWN', 'Unknown column: ' + column);
        preview.usages = await whereUsed(project, operation.table + '/*/' + column);
      }
      const edited = { ...schemaFile, document: schemaFile.document.clone() };
      if (operation.op === 'column-add') {
        checkedSchema(schemaFile, { ...target.schema, columns: { ...target.schema.columns, [column]: operation.definition } });
        edited.document.setIn(['columns', column], edited.document.createNode(operation.definition));
        if (operation.position) moveColumn(edited.document, column, operation.position);
      } else if (operation.op === 'column-update') {
        const definition: Column = { ...target.schema.columns[column]!, ...operation.changes };
        if (operation.changes.type !== undefined && operation.changes.type !== target.schema.columns[column]!.type) {
          const obsolete: (keyof Column)[] = [
            ...(definition.type !== 'enum' ? ['values' as const] : []),
            ...(definition.type !== 'ref' ? ['table' as const, 'on_delete' as const] : []),
            ...(!['integer', 'decimal'].includes(definition.type) ? ['minimum' as const, 'maximum' as const] : []),
          ];
          for (const field of obsolete) if (!Object.hasOwn(operation.changes, field)) delete definition[field];
        }
        checkedSchema(schemaFile, { ...target.schema, columns: { ...target.schema.columns, [column]: definition } });
        if (!isDeepStrictEqual(definition, target.schema.columns[column])) {
          for (const field of Object.keys(target.schema.columns[column]!)) {
            if (!Object.hasOwn(definition, field)) edited.document.deleteIn(['columns', column, field]);
          }
          for (const [field, value] of Object.entries(definition)) edited.document.setIn(['columns', column, field], value);
        }
      } else if (operation.op === 'column-move') {
        moveColumn(edited.document, column, operation.position);
      } else {
        if (target.schema.primary_key === column) throw new VibeError('KEY_COLUMN_REQUIRED', 'The Key column cannot be deleted.');
        edited.document.deleteIn(['columns', column]);
        const unique = edited.document.get('unique', true);
        if (isSeq(unique)) unique.items = unique.items.filter((_node, index) => !target.schema.unique![index]!.includes(column));
        for (const file of shared) {
          const doc = file.document.clone();
          const rows = doc.get('rows', true);
          let removed = false;
          if (isSeq(rows)) for (const row of rows.items) {
            if (isMap(row) && row.has(column)) { row.delete(column); removed = true; }
          }
          if (removed) changes.set(file.file, doc.toString({ lineWidth: 0, doubleQuotedAsJSON: true }));
        }
      }
      // Avoid formatting an unchanged operation, including a move already at its requested position.
      const columns = edited.document.get('columns', true);
      const originalColumns = schemaFile.document.get('columns', true);
      const sameOrder = isMap(columns) && isMap(originalColumns) && isDeepStrictEqual(
        originalColumns.items.map(pair => isScalar(pair.key) ? pair.key.value : undefined),
        columns.items.map(pair => isScalar(pair.key) ? pair.key.value : undefined));
      if (!sameOrder || !isDeepStrictEqual(edited.document.toJS(), schemaFile.data)) {
        const updated = parseYaml(edited.document.toString({ lineWidth: 0, doubleQuotedAsJSON: true }), schemaFile.file);
        checkedSchema(updated, updated.data as TableSchema);
        changes.set(schemaFile.file, updated.source);
      }
      preview.files = [...changes.keys()].sort();
    }
  } catch (error) {
    if (!(error instanceof VibeError)) throw error;
    failure = error;
    preview.blocked = error.message;
  }
  return { preview, changes, failure };
}

export async function inspectStructure(project: Project, operation: StructureOperation): Promise<StructurePreview> {
  return (await prepare(project, operation)).preview;
}

export async function applyStructureEdit(root: string, expectedRevision: string, operation: StructureOperation, options: MutationOptions = {}): Promise<WriteResult> {
  let candidates: Usage[] = [];
  const result = await mutateProject(root, expectedRevision, async project => {
    const plan = await prepare(project, operation);
    if (plan.failure) throw plan.failure;
    candidates = plan.preview.usages.candidates;
    return plan.changes;
  }, options);
  return { ...result, candidates };
}

export async function editProject(root: string, expectedRevision: string, input: unknown, options: MutationOptions = {}): Promise<WriteResult> {
  if (Array.isArray(input)) throw new VibeError('INVALID_EDIT', 'edit takes one operation; use apply for a row batch.');
  if (isRecord(input) && typeof input.op === 'string' && structureOps.includes(input.op)) {
    return applyStructureEdit(root, expectedRevision, input as unknown as StructureOperation, options);
  }
  // applyEdits owns validation for the single row operation too.
  return applyEdits(root, expectedRevision, [input] as Parameters<typeof applyEdits>[2], options);
}
