import { newFolderMarkers } from './folder-names.js';
import { pathParts, pathFromParts } from './paths.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isSeq, stringify } from 'yaml';
import type { Cell, Project, Table, TableSchema } from './types.js';
import { isRecord, validName, VibeError } from './types.js';
import type { ImportInspection, ImportIssue, ImportMapping, ImportPlan } from './import-types.js';
import { mutateProject, projectWithChanges } from './project.js';
import { formatYaml, parseYaml } from './yaml.js';
import { schemaDiagnostics, validateProject } from './validation.js';
import { resourceNameError, resourceNameKey, suggestResourceName } from './names.js';
import { folderError, listFolders, resourceEntries, resourceFile, resourcePath } from './resources.js';

// Spreadsheet parsers are only needed during import, not for each CLI cell edit.
export async function inspectImport(file: string): Promise<ImportInspection> {
  return (await import('./import-reader.js')).inspectImport(file);
}

function mappingShape(value: unknown): asserts value is ImportMapping {
  if (!isRecord(value) || typeof value.table !== 'string'
    || typeof value.schema !== 'string' || typeof value.sheet !== 'string'
    || value.folder !== undefined && typeof value.folder !== 'string'
    || !Number.isSafeInteger(value.header_row) || (value.header_row as number) < 1
    || !Number.isSafeInteger(value.data_start_row) || (value.data_start_row as number) <= (value.header_row as number)
    || !isRecord(value.columns) || !Object.keys(value.columns).length
    || Object.entries(value.columns).some(([source, target]) => !/^[A-Z]+$/.test(source) || typeof target !== 'string' || !validName(target))
    || !['stored', 'display'].includes(String(value.numeric))
    || value.exclude_rows !== undefined && (!Array.isArray(value.exclude_rows) || value.exclude_rows.some(row => !Number.isSafeInteger(row) || row < 1))
    || value.representations !== undefined && (!isRecord(value.representations) || Object.entries(value.representations)
      .some(([address, mode]) => !/^[A-Z]+[1-9]\d*$/.test(address) || !['stored', 'display'].includes(String(mode))))) {
    throw new VibeError('IMPORT_MAPPING', 'Choose a table, schema, sheet, header/data rows, source columns, and numeric representation.');
  }
  for (const name of [value.table, value.schema]) {
    const error = resourceNameError(name);
    if (error) throw new VibeError('IMPORT_MAPPING', error + ' 이름 제안: ' + suggestResourceName(name));
  }
  const error = folderError(value.folder ?? '');
  if (error) throw new VibeError('IMPORT_MAPPING', error);
}
function prepare(project: Project, inspection: ImportInspection, mapping: ImportMapping) {
  mappingShape(mapping);
  const sheet = inspection.sheets.find(sheet => sheet.name === mapping.sheet);
  if (!sheet) throw new VibeError('IMPORT_SHEET', 'Choose a sheet from import inspect.');
  const issues: ImportIssue[] = inspection.issues.filter(issue => !issue.sheet || issue.sheet === sheet.name).map(issue => ({ ...issue }));
  const error = (code: string, message: string, cell?: string) => issues.push({
    code, severity: 'error', message, sheet: sheet.name, ...(cell ? { cell } : {}),
  });
  const warn = (code: string, message: string, cell?: string) => issues.push({
    code, severity: 'warning', message, sheet: sheet.name, ...(cell ? { cell } : {}),
  });
  const schemaPath = resourceFile(project, 'schema', mapping.schema) ?? resourcePath('schema', mapping.schema);
  const changes = new Map<string, string>();
  let tablePath = 'tables/' + mapping.table + '.yaml';
  try {
    tablePath = resourcePath('table', mapping.table, mapping.folder, project);
    for (const [file, source] of newFolderMarkers(project, mapping.folder ?? '')) changes.set(file, source);
  } catch (cause) {
    if (!(cause instanceof VibeError)) throw cause;
    error('IMPORT_NAME_EXISTS', cause.message);
  }
  for (const [kind, name, path] of [['schema', mapping.schema, schemaPath], ['table', mapping.table, tablePath]] as const) {
    const entries = resourceEntries(project).filter(entry => kind === 'schema' ? entry.kind === kind : entry.kind !== 'schema');
    if (entries.some(entry => entry.file !== path && resourceNameKey(entry.name) === resourceNameKey(name))) {
      error('IMPORT_NAME_EXISTS', '프로젝트에서 대소문자 또는 Unicode 정규화만 다른 이름은 중복입니다. 이름 제안: ' + suggestResourceName(name, entries.map(entry => entry.name)));
    }
  }
  const folders = listFolders(project);
  const parts = pathParts(mapping.folder ?? '');
  for (let i = 1; i <= parts.length; i++) {
    const folder = pathFromParts(parts.slice(0, i));
    if (folders.some(other => other !== folder && resourceNameKey(other) === resourceNameKey(folder))) {
      error('IMPORT_NAME_EXISTS', 'The destination folder has a different case or Unicode spelling: ' + folder);
    }
  }
  const rows: ImportPlan['rows'] = [];
  const normalizations: NonNullable<ImportPlan['normalizations']> = [];
  const schemaFile = project.files.get(schemaPath);
  if (project.sources.has(schemaPath) && !schemaFile) error('IMPORT_SCHEMA', 'The existing schema cannot be parsed; repair it before importing.');
  let schema: TableSchema | undefined;
  if (schemaFile) {
    const diagnostics = schemaDiagnostics(schemaFile);
    if (diagnostics.length) error('IMPORT_SCHEMA', 'The selected existing schema is invalid. ' + diagnostics.map(item => item.message).join(' '));
    else {
      schema = schemaFile.data as TableSchema;
      if (mapping.definition !== undefined && !isDeepStrictEqual(schema, mapping.definition)) {
        error('IMPORT_SCHEMA_EXISTS', 'Import does not overwrite an existing schema. Choose its definition or a new schema name.');
      }
    }
  } else if (mapping.definition) {
    const file = formatYaml(parseYaml(stringify(mapping.definition), schemaPath));
    const diagnostics = schemaDiagnostics({ ...file, data: mapping.definition });
    if (diagnostics.length) error('IMPORT_SCHEMA', 'The new schema definition is invalid. ' + diagnostics.map(item => item.message).join(' '));
    else { schema = mapping.definition; changes.set(schemaPath, file.source); }
  } else error('IMPORT_SCHEMA', 'Supply a new schema definition or choose an existing schema.');
  const mapped = Object.entries(mapping.columns);
  if (new Set(mapped.map(([, target]) => target)).size !== mapped.length) error('IMPORT_COLUMN_DUPLICATE', 'Map each target column at most once.');
  for (const [source, target] of mapped) {
    if (!sheet.columns.includes(source)) error('IMPORT_COLUMN', 'Source column is outside the sheet: ' + source);
    if (schema && !Object.hasOwn(schema.columns, target)) error('IMPORT_COLUMN', 'Target column is not declared: ' + target);
  }
  if (schema && !mapped.some(([, target]) => target === schema.primary_key)) error('IMPORT_KEY', 'Map exactly one source column to the schema Key.');
  const headers = new Map<string, string>();
  for (const source of sheet.columns) {
    const header = sheet.cells[source + mapping.header_row]?.raw;
    if (header == null || header === '') continue;
    const value = String(header);
    if (headers.has(value)) warn('DUPLICATE_HEADER', 'Duplicate header: ' + value, source + mapping.header_row);
    else headers.set(value, source);
  }
  const excludedColumns = sheet.columns.filter(column => !Object.hasOwn(mapping.columns, column)
    && Object.entries(sheet.cells).some(([address, cell]) => address.replace(/\d+$/, '') === column && cell.raw != null && cell.raw !== ''));
  if (excludedColumns.length) warn('EXCLUDED_COLUMNS', 'Unmapped columns are excluded: ' + excludedColumns.join(', '));
  if (mapping.exclude_rows?.length) warn('EXCLUDED_ROWS', 'Explicitly excluded source rows: ' + mapping.exclude_rows.join(', '));
  const tableFile = project.files.get(tablePath);
  if (project.sources.has(tablePath) && !tableFile) error('IMPORT_TABLE', 'The existing table cannot be parsed; repair it before importing.');
  const existing = tableFile?.data as Table | undefined;
  if (existing && (existing.schema !== mapping.schema || !Array.isArray(existing.rows))) {
    error('IMPORT_TABLE', 'The target table must have the selected schema and a readable rows sequence.');
  }
  if (schema) {
    const keys = new Set((Array.isArray(existing?.rows) ? existing.rows : []).map(row => row[schema!.primary_key]));
    for (let row = mapping.data_start_row; row <= sheet.rowCount; row++) {
      if (mapping.exclude_rows?.includes(row)) continue;
      if (!mapped.some(([column]) => {
        const cell = sheet.cells[column + row];
        return cell?.unsupported || cell?.raw != null && cell.raw !== '';
      })) continue;
      const values: Record<string, Cell> = Object.create(null) as Record<string, Cell>;
      for (const [source, target] of mapped) {
        const address = source + row, cell = sheet.cells[address], definition = schema.columns[target];
        if (!definition) continue;
        if (cell?.unsupported) { error('IMPORT_UNSUPPORTED_CELL', cell.unsupported, address); continue; }
        let value: Cell = cell?.normalizedInteger ?? cell?.raw ?? '';
        if (cell?.normalizedInteger !== undefined && typeof cell.raw === 'string' && cell.raw !== cell.normalizedInteger) {
          normalizations.push({ cell: address, column: target, raw: cell.raw, value: cell.normalizedInteger });
        }
        const mode = mapping.representations?.[address] ?? mapping.numeric;
        if (cell?.normalizedInteger === undefined && mode === 'display' && cell?.displaySafe === false) {
          error('IMPORT_DISPLAY_UNSAFE', 'A safe calculated display is unavailable. Choose stored text.', address); continue;
        }
        if (cell?.normalizedInteger === undefined && mode === 'display' && cell?.display !== undefined && cell.display !== String(value)) {
          if (!cell.displaySafe) { error('IMPORT_DISPLAY_UNSAFE', 'The calculated display cannot preserve this value. Choose stored text.', address); continue; }
          value = cell.display;
          warn('DISPLAY_SELECTED', 'Using the calculated display candidate rather than stored text.', address);
        }
        if (definition.type === 'boolean' && typeof value === 'string' && /^(true|false)$/i.test(value)) {
          value = value.toLowerCase() === 'true'; warn('BOOLEAN_SELECTED', 'Converted source text using the declared boolean type.', address);
        } else if (definition.type !== 'boolean' && typeof value === 'boolean') {
          value = String(value); warn('TEXT_SELECTED', 'Converted a source boolean to text using the declared column type.', address);
        }
        values[target] = value;
      }
      const key = values[schema.primary_key], keyColumn = mapped.find(([, target]) => target === schema.primary_key)?.[0] ?? '';
      if (typeof key !== 'string' || !key.length || key === '*') error('IMPORT_KEY', 'A nonempty Key without reserved * is required.', keyColumn + row);
      else if (keys.has(key)) error('IMPORT_KEY_DUPLICATE', 'Key already exists in the target or source: ' + key, keyColumn + row);
      else keys.add(key);
      rows.push({ sourceRow: row, values });
    }
    if (!issues.some(issue => issue.severity === 'error')) {
      const file = tableFile ?? parseYaml(stringify({ schema: mapping.schema, rows: [] }), tablePath);
      const doc = file.document.clone(), target = doc.get('rows', true);
      if (!isSeq(target)) error('IMPORT_TABLE', 'The target rows must be a sequence.');
      else {
        for (const row of rows) target.add(doc.createNode(row.values));
        changes.set(tablePath, formatYaml(parseYaml(doc.toString({ lineWidth: 0 }), tablePath), schema).source);
      }
    }
  }
  let provenanceFile: string | undefined;
  if (normalizations.length && changes.has(tablePath)) {
    const record = {
      version: 1, file: inspection.file, sourceHash: inspection.sourceHash, format: inspection.format,
      sheet: sheet.name, table: mapping.table, mapping, beforeRevision: project.revision,
      normalizations: [...normalizations].sort((a, b) => a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0),
    };
    const source = JSON.stringify(record, (_key, value: unknown) => isRecord(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value, 2) + '\n';
    provenanceFile = 'imports/' + createHash('sha256').update(source).digest('hex') + '.json';
    changes.set(provenanceFile, source);
  }
  const diagnostics = validateProject(projectWithChanges(project, issues.some(issue => issue.severity === 'error') ? new Map() : changes));
  const plan: ImportPlan = { file: inspection.file, sourceHash: inspection.sourceHash, revision: project.revision, mapping,
    files: [...new Set([...changes.keys(), tablePath])], rows, issues, diagnostics,
    ...(normalizations.length ? { normalizations } : {}), ...(provenanceFile ? { provenanceFile } : {}),
    canApply: !issues.some(issue => issue.severity === 'error') };
  return { plan, changes };
}
export function planImport(project: Project, inspection: ImportInspection, mapping: ImportMapping): ImportPlan {
  return prepare(project, inspection, mapping).plan;
}
export async function applyImport(root: string, expectedRevision: string, plan: ImportPlan) {
  if (!isRecord(plan) || typeof plan.file !== 'string' || typeof plan.sourceHash !== 'string' || plan.revision !== expectedRevision) {
    throw new VibeError('IMPORT_PLAN', 'Use a preview plan and its expected revision.');
  }
  return mutateProject(root, expectedRevision, async project => {
    const inspection = await inspectImport(plan.file);
    if (inspection.sourceHash !== plan.sourceHash) throw new VibeError('IMPORT_SOURCE_CHANGED', 'The source file changed after preview; inspect and plan again.');
    const fresh = prepare(project, inspection, plan.mapping);
    if (!fresh.plan.canApply) throw new VibeError('IMPORT_BLOCKED', fresh.plan.issues.filter(issue => issue.severity === 'error')
      .map(issue => [issue.cell, issue.message].filter(Boolean).join(': ')).join('\n'));
    return fresh.changes;
  });
}
