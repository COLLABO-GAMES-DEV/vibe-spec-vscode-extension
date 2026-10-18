import { resourceEntries, resourceEntry, resourceFile } from './resources.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { isMap, isScalar } from 'yaml';
import type { Diagnostic, Project, Table, TableSchema } from './types.js';
import { isRecord, validName, VibeError } from './types.js';
import { loadProject, readPath } from './project.js';
import { validateProject } from './validation.js';
import { tableContexts } from './validation.js';
import { replaceFile } from './file-replacement.js';
import { compareResourceNames } from './names.js';

export interface TableSummary { name: string; schema: string; keyCode: string; keyLabel: string; rows: number; errors: number }
export function tableSummaries(project: Project): TableSummary[] {
  const contexts = tableContexts(project);
  return listTables(project).map(item => {
    const context = contexts.get(item.name), key = context?.schema.primary_key ?? '';
    return { ...item, schema: context?.table.schema ?? '', keyCode: key,
      keyLabel: context?.schema.columns[key]?.label ?? key, rows: context?.table.rows.length ?? 0 };
  });
}

export interface TableView {
  table: string;
  schema: TableSchema;
  rows: Table['rows'];
  revision: string;
  diagnostics: Diagnostic[];
  references: Record<string, string[]>;
  tables: string[];
  schemaTables: string[];
  columnOrder: string[];
}
export function getTableView(project: Project, name: string): TableView {
  const { schema, table } = readPath(project, name) as { schema: TableSchema; table: Table };
  const references: Record<string, string[]> = {};
  for (const [field, column] of Object.entries(schema.columns)) {
    if (column.type !== 'ref') continue;
    try {
      const target = readPath(project, column.table!) as { schema: TableSchema; table: Table };
      references[field] = target.table.rows.map(row => row[target.schema.primary_key]).filter((key): key is string => typeof key === 'string');
    } catch { references[field] = []; } // The common validator reports the broken declaration.
  }
  return {
    table: name, schema, rows: table.rows, revision: project.revision, references,
    tables: resourceEntries(project, 'table').map(entry => entry.name).sort(compareResourceNames),
    schemaTables: [...project.files].filter(([path, file]) => path.startsWith('tables/') && isRecord(file.data) && file.data.schema === table.schema)
      .map(([path]) => resourceEntry(path)!.name).sort(compareResourceNames),
    columnOrder: (() => {
      const columns = project.files.get(resourceFile(project, 'schema', table.schema) ?? '')?.document.get('columns', true);
      return isMap(columns) ? columns.items.flatMap(pair => isScalar(pair.key) ? [String(pair.key.value)] : []) : Object.keys(schema.columns);
    })(),
    diagnostics: validateProject(project).filter(item =>
      item.file === resourceFile(project, 'table', name) || item.file === resourceFile(project, 'schema', table.schema)),
  };
}

export function resolveReference(project: Project, tableName: string, key: string, column: string) {
  const { schema } = readPath(project, tableName) as { schema: TableSchema };
  const definition = schema.columns[column];
  if (definition?.type !== 'ref' || !definition.table) throw new VibeError('REFERENCE_REQUIRED', 'This column is not a reference.');
  const row = readPath(project, tableName + '/' + key) as Record<string, unknown>;
  const value = row[column];
  if (typeof value !== 'string' || !validName(value) || value === '*') throw new VibeError('REF_MISSING', 'The cell does not contain a target Key.');
  readPath(project, definition.table + '/' + value);
  const target = readPath(project, definition.table) as { schema: TableSchema };
  return { table: definition.table, key: value, column: target.schema.primary_key };
}

export function listTables(project: Project): { name: string; errors: number }[] {
  const diagnostics = validateProject(project);
  return resourceEntries(project, 'table').map(({file, name}) => {
    const data = project.files.get(file)?.data;
    const schema = isRecord(data) ? data.schema : undefined;
    return { name, errors: diagnostics.filter(d => d.severity !== 'warning' &&
      (d.file === file || typeof schema === 'string' && d.file === resourceFile(project, 'schema', schema))).length };
  }).sort((a, b) => compareResourceNames(a.name, b.name));
}

export async function selectPlanningRoot(workspaceRoot: string, planningRoot: string): Promise<Project> {
  const project = await loadProject(planningRoot);
  await mkdir(workspaceRoot, { recursive: true });
  const destination = join(workspaceRoot, '.vibe-spec.json');
  let previous: unknown = {};
  let previousSource: string | undefined;
  try {
    previousSource = await readFile(destination, 'utf8');
    previous = JSON.parse(previousSource.replace(/^\uFEFF/, ''));
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const data = {
    ...(isRecord(previous) ? previous : {}),
    planning_root: relative(resolve(workspaceRoot), project.root).replaceAll('\\', '/') || '.',
  };
  const temporary = destination + '.vibe-tmp';
  await writeFile(temporary, JSON.stringify(data) + '\n', { flag: 'wx' });
  try {
    await replaceFile(temporary, destination, async () => {
      let current: string | undefined;
      try { current = await readFile(destination, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (current !== previousSource) throw new VibeError('STALE_REVISION', 'Workspace configuration changed; select the planning folder again.');
    });
  }
  finally { await rm(temporary, { force: true }); }
  return project;
}
