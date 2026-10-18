import { isDeepStrictEqual } from 'node:util';
import type { GitChoice, GitConflict } from './git-types.js';
import { isRecord, validName } from './types.js';
import type { Table, TableSchema } from './types.js';
import { schemaDiagnostics } from './validation.js';
import { formatYaml, parseYaml } from './yaml.js';

type Row = Record<string, unknown>;
type RowConflict = Extract<GitConflict, { kind: 'row' }>;
const cell = (row: Row, field: string): unknown => Object.hasOwn(row, field) ? row[field] : undefined;
export interface TableMerge {
  conflicts: RowConflict[];
  source(choices: readonly GitChoice[]): string;
}

// Only unambiguous tables with the same Key declaration can use row merging.
// In particular, never turn duplicate Keys into a Map and silently drop a row.
export function mergeTable(
  file: string, table: string, sources: (string | null)[], schemaSources: (string | null)[],
): TableMerge | null {
  try {
    if (sources.length !== 3 || schemaSources.length !== 3 ||
        sources.some(source => source === null) || schemaSources.some(source => source === null)) return null;
    const schemas = schemaSources.map(source => parseYaml(source!, file));
    if (schemas.some(schema => schemaDiagnostics(schema).length > 0)) return null;
    const schema = schemas[0]!.data as TableSchema;
    if (schemas.some(candidate => (candidate.data as TableSchema).primary_key !== schema.primary_key)) return null;
    const tables = sources.map(source => parseYaml(source!, file).data);
    if (!tables.every((value): value is Table => isRecord(value) &&
        typeof value.schema === 'string' && validName(value.schema) && Array.isArray(value.rows) &&
        Object.keys(value).every(key => key === 'schema' || key === 'rows'))) return null;
    if (tables.some(value => value.schema !== tables[0]!.schema)) return null;
    const keyField = schema.primary_key;
    for (const value of tables) {
      const keys = new Set<string>();
      for (const row of value.rows) {
        if (!isRecord(row) || Object.values(row).some(cell =>
          cell !== null && typeof cell !== 'string' && typeof cell !== 'boolean')) return null;
        const key = row[keyField];
        if (typeof key !== 'string' || !validName(key) || key === '*' || keys.has(key)) return null;
        keys.add(key);
      }
    }
    const maps = tables.map(value => new Map(value.rows.map(row => [row[keyField] as string, row])));
    const [base, ours, theirs] = maps as [Map<string, Row>, Map<string, Row>, Map<string, Row>];
    const keys = [...new Set([...ours.keys(), ...theirs.keys(), ...base.keys()])];
    const conflicts: RowConflict[] = [];
    const rows = new Map<string, Row | null>();
    const conflictingFields = new Map<string, string[]>();
    for (const key of keys) {
      const b = base.get(key) ?? null;
      const o = ours.get(key) ?? null;
      const t = theirs.get(key) ?? null;
      if (isDeepStrictEqual(o, t)) rows.set(key, o);
      else if (isDeepStrictEqual(b, o)) rows.set(key, t);
      else if (isDeepStrictEqual(b, t)) rows.set(key, o);
      else {
        // A delete/modify or differing add/add selects a complete row.
        if (b !== null && o !== null && t !== null) {
          const fields = [...new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])];
          const merged: [string, unknown][] = [];
          const unresolved: string[] = [];
          for (const field of fields) {
            let value: unknown;
            if (isDeepStrictEqual(cell(o, field), cell(t, field))) value = cell(o, field);
            else if (isDeepStrictEqual(cell(b, field), cell(o, field))) value = cell(t, field);
            else if (isDeepStrictEqual(cell(b, field), cell(t, field))) value = cell(o, field);
            else { unresolved.push(field); value = cell(o, field); }
            // undefined represents an absent field, distinct from explicit null.
            if (value !== undefined) merged.push([field, value]);
          }
          rows.set(key, Object.fromEntries(merged));
          if (unresolved.length === 0) continue;
          conflictingFields.set(key, unresolved);
        }
        conflicts.push({ kind: 'row', file, table, key, base: b, ours: o, theirs: t });
      }
    }
    return {
      conflicts,
      source(choices) {
        const resolved = new Map(rows);
        for (const conflict of conflicts) {
          const choice = choices.find(choice => choice.file === file && choice.key === conflict.key);
          if (!choice) throw new Error('Missing row choice: ' + file + '/' + conflict.key);
          const selected = conflict[choice.choice];
          const fields = conflictingFields.get(conflict.key);
          if (fields && selected) {
            const row = { ...resolved.get(conflict.key)! };
            for (const field of fields) {
              if (Object.hasOwn(selected, field)) Object.defineProperty(row, field, {
                value: selected[field], enumerable: true, writable: true, configurable: true,
              });
              else delete row[field];
            }
            resolved.set(conflict.key, row);
          } else resolved.set(conflict.key, selected);
        }
        const data = { schema: tables[0]!.schema, rows: keys.flatMap(key => {
          const row = resolved.get(key);
          return row ? [row] : [];
        }) };
        return formatYaml(parseYaml(JSON.stringify(data), file), schema).source;
      },
    };
  } catch {
    // Invalid YAML/schema/shape is a file choice, never a lossy best effort.
    return null;
  }
}
