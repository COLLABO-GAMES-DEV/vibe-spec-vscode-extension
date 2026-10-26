import { pathParts, pathFromParts } from './paths.js';
import { resourceEntry, resourceFile } from './resources.js';
import { documentUsages } from './document-references.js';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic, Project, TableSchema, Usage, Usages } from './types.js';
import { readPath } from './project.js';
import { declaredReferences, schemaDiagnostics, tableContexts } from './validation.js';
import { hasPlanAddedRow, planUsages } from './plan-references.js';
import { VibeError } from './types.js';

function add(list: Usage[], file: string, location: string, source: string, offset: number) {
  const line = source.slice(0, offset).split('\n').length;
  const text = source.split('\n')[line - 1] ?? '';
  if (!list.some(item => item.file === file && item.path === location && item.line === line)) {
    list.push({ file, path: location, line, text });
  }
}

export async function textCandidates(project: Project, needle: string): Promise<Usage[]> {
  const candidates: Usage[] = [];
  const contexts = tableContexts(project);
  for (const [name, item] of contexts) {
    for (const [i, row] of item.table.rows.entries()) {
      for (const [field, value] of Object.entries(row)) {
        if (typeof value !== 'string') continue;
        const definition = item.schema.columns[field];
        const node = item.file.document.getIn(['rows', i, field], true) as { range?: number[] } | undefined;
        const location = pathFromParts([name, String(row[item.schema.primary_key]), field]);
        if (field !== item.schema.primary_key && definition?.type !== 'ref' && value.includes(needle)) {
          add(candidates, item.file.file, location, item.file.source, node?.range?.[0] ?? 0);
        }
      }
    }
  }
  // Plain documents and notes are candidates, never inferred structural links.
  async function scan(folder: string) {
    for (const entry of await readdir(join(project.root, folder), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const file = folder ? folder + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile() && /\.(md|txt)$/i.test(file)) {
        const source = await readFile(join(project.root, file), 'utf8');
        let offset = 0;
        for (const line of source.split('\n')) {
          if (line.includes(needle)) add(candidates, file, '', source, offset);
          offset += line.length + 1;
        }
      }
    }
  }
  await scan('');
  return candidates;
}

/** Resolve the targets from deletion diagnostics, including deletions caused by undo. */
export async function deletionUsages(project: Project, diagnostics: readonly Diagnostic[]) {
  const contexts = tableContexts(project), targets = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== 'DELETE_RESTRICTED') continue;
    if (diagnostic.target) { targets.add(diagnostic.target); continue; }
    const [table, key, column] = pathParts(diagnostic.path);
    const context = contexts.get(table!), definition = context?.schema.columns[column!];
    const row = context?.table.rows.find(row => row[context.schema.primary_key] === key);
    if (definition?.type === 'ref' && typeof row?.[column!] === 'string') targets.add(pathFromParts([definition.table!, row[column!] as string]));
  }
  const result: Usages = { references: [], candidates: [] };
  for (const target of targets) {
    const used = await whereUsed(project, target);
    result.references.push(...used.references); result.candidates.push(...used.candidates);
  }
  return { key: [...targets].join(', '), result };
}

export async function whereUsed(project: Project, path: string): Promise<Usages> {
  try { readPath(project, path); }
  catch (error) {
    const parts = pathParts(path);
    if (!(error instanceof VibeError) || error.code !== 'PATH_NOT_FOUND' || parts.length < 2 ||
        !hasPlanAddedRow(project, pathFromParts(parts.slice(0, 2)))) throw error;
    // Resolve table/column declarations even if the row exists only in an alternative.
    readPath(project, parts.length === 3 ? parts[0] + '/*/' + parts[2] : parts[0]!);
  }
  if (resourceFile(project, 'document', pathParts(path)[0]!) !== undefined) {
    const result = documentUsages(project, path), plans = planUsages(project, path);
    result.references.push(...plans.references);
    result.candidates = [...(await textCandidates(project, pathParts(path).at(-1)!)).filter(candidate =>
      resourceEntry(candidate.file)?.kind !== 'document' && !candidate.file.startsWith('plans/')), ...result.candidates, ...plans.candidates];
    return result;
  }
  const [table, key, column] = pathParts(path);
  const needle = column ?? key ?? table!;
  const references: Usage[] = [];
  const candidates = await textCandidates(project, needle);
  const contexts = tableContexts(project);
  if (column === undefined) {
    for (const reference of declaredReferences(project)) {
      if (reference.target !== table) continue;
      for (const [i, row] of reference.table.rows.entries()) {
        if (key !== undefined && row[reference.field] !== key) continue;
        const node = reference.file.document.getIn(['rows', i, reference.field], true) as { range?: number[] } | undefined;
        if (node) add(references, reference.file.file,
          pathFromParts([reference.name, String(row[reference.primaryKey] ?? ''), reference.field]),
          reference.file.source, node.range?.[0] ?? 0);
      }
    }
  }
  if (key === undefined) {
    for (const [filePath, file] of project.files) {
      if (!filePath.startsWith('schemas/') || schemaDiagnostics(file).length) continue;
      const schema = file.data as TableSchema;
      for (const [field, definition] of Object.entries(schema.columns)) {
        if (definition.type !== 'ref' || definition.table !== table) continue;
        const node = file.document.getIn(['columns', field, 'table'], true) as { range?: number[] };
        add(references, file.file, 'columns/' + field + '/table', file.source, node.range?.[0] ?? 0);
      }
    }
  } else if (key === '*' && column !== undefined) {
    const item = contexts.get(table!)!;
    const file = project.files.get(resourceFile(project, 'schema', item.table.schema)!)!;
    const paths: (string | number)[][] = [];
    if (item.schema.primary_key === column) paths.push(['primary_key']);
    for (const [i, fields] of (item.schema.unique ?? []).entries()) {
      for (const [j, field] of fields.entries()) if (field === column) paths.push(['unique', i, j]);
    }
    for (const location of paths) {
      const node = file.document.getIn(location, true) as { range?: number[] };
      add(references, file.file, location.join('/'), file.source, node.range?.[0] ?? 0);
    }
  }
  const plans = planUsages(project, path);
  const documents = documentUsages(project, path);
  return { references: [...references, ...plans.references, ...documents.references],
    candidates: [...candidates.filter(candidate => resourceEntry(candidate.file)?.kind !== 'document'), ...documents.candidates, ...plans.candidates] };
}
