import { pathFromParts } from './paths.js';
import { resourceEntry } from './resources.js';
import { isDeepStrictEqual } from 'node:util';
import { isMap, isScalar, isSeq } from 'yaml';
import type { Cell, EditOperation, HistoryInfo, Project, WriteResult, YamlFile } from './types.js';
import { isRecord, VibeError } from './types.js';
import { loadProject, mutateProject, projectWithChanges } from './project.js';
import { declaredReferences, tableContexts } from './validation.js';
import { prepareEdits, insertCell, renameResource } from './editing.js';
import { formatYaml, parseYaml, updateCell } from './yaml.js';

interface State { present: boolean; value: Cell }
interface Change { table: string; key: string; column: string; before: State; after: State }
interface RowState { schema: string; primaryKey: string; row: Record<string, unknown> | undefined }
interface RowChange { table: string; key: string; before: RowState; after: RowState }
interface FileChange { file: string; before: string; after: string }
type Entry = { kind: 'cells'; changes: Change[] }
  | { kind: 'rows'; changes: RowChange[]; orders: { table: string; before: string[]; after: string[] }[] }
  | { kind: 'structure'; changes: FileChange[] }
  | { kind: 'rename'; table: string; from: string; to: string; beforeRefs: string[]; afterRefs: string[] };

function rowState(project: Project, table: string, key: string): RowState {
  const item = tableContexts(project).get(table);
  if (!item) throw new VibeError('HISTORY_CONFLICT', 'The edited table or its schema changed: ' + table);
  const rows = item.table.rows.filter(row => row[item.schema.primary_key] === key);
  if (rows.length > 1) throw new VibeError('HISTORY_CONFLICT', 'The edited row Key is ambiguous: ' + table + '/' + key);
  return { schema: item.table.schema, primaryKey: item.schema.primary_key, row: rows[0] ? { ...rows[0] } : undefined };
}
function context(project: Project, table: string, key: string, column: string) {
  const item = tableContexts(project).get(table);
  const rows = item?.table.rows.flatMap((row, index) => row[item.schema.primary_key] === key ? [{ row, index }] : []) ?? [];
  if (!item || rows.length !== 1 || !Object.hasOwn(item.schema.columns, column)) {
    throw new VibeError('HISTORY_CONFLICT', 'The edited cell was removed or renamed: ' + table + '/' + key + '/' + column);
  }
  return { ...item, ...rows[0]! };
}
function state(project: Project, table: string, key: string, column: string): State {
  const { row } = context(project, table, key, column);
  return { present: Object.hasOwn(row, column), value: (row[column] ?? null) as Cell };
}
const equal = (a: State, b: State) => a.present === b.present && (!a.present || Object.is(a.value, b.value));
function references(project: Project, table: string, key: string): string[] {
  return declaredReferences(project).filter(ref => ref.target === table).flatMap(ref =>
    ref.table.rows.filter(row => row[ref.field] === key).map(row =>
      JSON.stringify([ref.name, row[ref.primaryKey], ref.field]))).sort();
}
function removeCell(file: YamlFile, index: number, column: string): YamlFile {
  const row = file.document.getIn(['rows', index], true);
  const node = file.document.getIn(['rows', index, column], true);
  const key = isMap(row) ? row.items.find(pair => isScalar(pair.key) && pair.key.value === column)?.key : undefined;
  if (!isMap(row) || row.flow || !isScalar(key) || !key.range || !isScalar(node) || !node.range) {
    throw new VibeError('HISTORY_CONFLICT', 'The added cell layout changed; refusing to remove surrounding content.');
  }
  const start = file.source.lastIndexOf('\n', key.range[0] - 1) + 1;
  const prefix = file.source.slice(start, key.range[0]);
  const suffix = file.source.slice(node.range[1], node.range[2]);
  if (!/^\s*$/.test(prefix) || suffix.trim()) {
    throw new VibeError('HISTORY_CONFLICT', 'The added cell has new surrounding content; refusing to remove it.');
  }
  return parseYaml(file.source.slice(0, start) + file.source.slice(node.range[2]), file.file);
}

function guardRemovedColumns(current: Project, changes: ReadonlyMap<string, string>): void {
  const planned = projectWithChanges(current, changes);
  for (const path of changes.keys()) {
    if (!path.startsWith('schemas/')) continue;
    const before = current.files.get(path)?.data, after = planned.files.get(path)?.data;
    if (!isRecord(before) || !isRecord(before.columns) || !isRecord(after) || !isRecord(after.columns)) {
      throw new VibeError('HISTORY_CONFLICT', 'The edited schema cannot be safely restored: ' + path);
    }
    const columns = after.columns;
    const removed = Object.keys(before.columns).filter(column => !Object.hasOwn(columns, column));
    if (!removed.length) continue;
    const schema = resourceEntry(path)!.name;
    for (const [tablePath, file] of current.files) {
      if (!tablePath.startsWith('tables/') || changes.has(tablePath) || !isRecord(file.data) || file.data.schema !== schema) continue;
      if (Array.isArray(file.data.rows) && file.data.rows.some(row => isRecord(row) && removed.some(column => Object.hasOwn(row, column)))) {
        throw new VibeError('HISTORY_CONFLICT', 'External rows use a column that undo/redo would remove: ' + tablePath);
      }
    }
  }
}

/** One editor's in-memory history. File-watch snapshots never enter these stacks. */
export class ScreenHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  info(): HistoryInfo { return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 }; }

  recordCells(result: WriteResult, operations: EditOperation[]) {
    if (operations.some(op => op.op !== 'update')) {
      const changes = new Map<string, RowChange>();
      const tables = tableContexts(result.before);
      for (const op of operations) {
        const key = op.op === 'create' ? op.row[tables.get(op.table)!.schema.primary_key] as string : op.key;
        const before = rowState(result.before, op.table, key);
        const after = rowState(result.planned, op.table, key);
        if (!isDeepStrictEqual(before, after)) changes.set(JSON.stringify([op.table, key]), { table: op.table, key, before, after });
      }
      if (changes.size) {
        const order = (project: Project, table: string) => {
          const item = tableContexts(project).get(table)!;
          return item.table.rows.map(row => row[item.schema.primary_key]).filter((key): key is string => typeof key === 'string');
        };
        const orders = [...new Set(operations.map(op => op.table))].map(table => ({ table,
          before: order(result.before, table), after: order(result.planned, table) }));
        this.undoStack.push({ kind: 'rows', changes: [...changes.values()], orders }); this.redoStack = [];
      }
      return;
    }
    const changes = new Map<string, Change>();
    for (const op of operations) {
      if (op.op !== 'update') continue;
      for (const column of Object.keys(op.values)) {
        const before = state(result.before, op.table, op.key, column);
        const after = state(result.planned, op.table, op.key, column);
        if (!equal(before, after)) changes.set(JSON.stringify([op.table, op.key, column]),
          { table: op.table, key: op.key, column, before, after });
      }
    }
    if (changes.size) { this.undoStack.push({ kind: 'cells', changes: [...changes.values()] }); this.redoStack = []; }
  }
  recordRename(result: WriteResult, table: string, from: string, to: string) {
    if (from === to || !result.changed.length) return;
    this.undoStack.push({ kind: 'rename', table, from, to,
      beforeRefs: references(result.before, table, from), afterRefs: references(result.planned, table, to) });
    this.redoStack = [];
  }
  recordStructure(result: WriteResult) {
    // Column edits and column renames replace existing files. Table lifecycle history is not supported.
    if (!result.changed.length || result.changed.some(file => !result.before.sources.has(file) || !result.planned.sources.has(file))) return;
    const changes = result.changed.map(file => ({ file, before: result.before.sources.get(file)!, after: result.planned.sources.get(file)! }));
    this.undoStack.push({ kind: 'structure', changes });
    this.redoStack = [];
  }

  undo(root: string, expectedRevision: string): Promise<WriteResult> { return this.move(root, expectedRevision, false); }
  redo(root: string, expectedRevision: string): Promise<WriteResult> { return this.move(root, expectedRevision, true); }
  private async move(root: string, expectedRevision: string, redo: boolean): Promise<WriteResult> {
    const stack = redo ? this.redoStack : this.undoStack;
    const entry = stack.at(-1);
    if (!entry) throw new VibeError('HISTORY_EMPTY', 'There is no edit to ' + (redo ? 'redo.' : 'undo.'));
    let result: WriteResult;
    if (entry.kind === 'structure') {
      result = await mutateProject(root, expectedRevision, current => {
        const changes = new Map<string, string>();
        for (const change of entry.changes) {
          if (current.sources.get(change.file) !== (redo ? change.before : change.after)) {
            throw new VibeError('HISTORY_CONFLICT', 'This file changed outside this editor: ' + change.file);
          }
          changes.set(change.file, redo ? change.after : change.before);
        }
        guardRemovedColumns(current, changes);
        return changes;
      });
    } else if (entry.kind === 'rows') {
      result = await mutateProject(root, expectedRevision, current => {
        const operations: EditOperation[] = [];
        const restored = new Map<string, Set<string>>();
        for (const change of entry.changes) {
          const expected = redo ? change.before : change.after;
          const desired = redo ? change.after : change.before;
          if (!isDeepStrictEqual(rowState(current, change.table, change.key), expected)) {
            throw new VibeError('HISTORY_CONFLICT', 'This row changed outside this editor: ' + change.table + '/' + change.key);
          }
          if (expected.row) operations.push({ op: 'delete', table: change.table, key: change.key });
          if (desired.row) {
            operations.push({ op: 'create', table: change.table, row: desired.row as Record<string, Cell> });
            if (!restored.has(change.table)) restored.set(change.table, new Set());
            restored.get(change.table)!.add(change.key);
          }
        }
        const changes = prepareEdits(current, operations);
        const planned = projectWithChanges(current, changes);
        for (const saved of entry.orders) {
          const keys = restored.get(saved.table);
          if (!keys?.size) continue;
          const item = tableContexts(planned).get(saved.table)!;
          const document = item.file.document.clone(), rows = document.get('rows', true);
          if (!isSeq(rows)) throw new VibeError('HISTORY_CONFLICT', 'The row layout changed.');
          const desired = redo ? saved.after : saved.before;
          const indexOf = (key: string) => rows.items.findIndex(node => isMap(node) && node.get(item.schema.primary_key) === key);
          // Only restored rows move. External rows and surviving rows keep their order.
          for (let index = desired.length - 1; index >= 0; index--) {
            const key = desired[index]!;
            if (!keys.has(key)) continue;
            const currentIndex = indexOf(key);
            if (currentIndex < 0) continue;
            const [node] = rows.items.splice(currentIndex, 1);
            const successor = desired.slice(index + 1).find(candidate => indexOf(candidate) >= 0);
            rows.items.splice(successor === undefined ? rows.items.length : indexOf(successor), 0, node!);
          }
          changes.set(item.file.file, formatYaml(parseYaml(document.toString({ lineWidth: 0 }), item.file.file), item.schema).source);
        }
        return changes;
      });
    } else if (entry.kind === 'rename') {
      const current = await loadProject(root);
      if (current.revision !== expectedRevision) throw new VibeError('STALE_REVISION', 'Files changed; read again before undo/redo.');
      const from = redo ? entry.from : entry.to, to = redo ? entry.to : entry.from;
      const expected = redo ? entry.beforeRefs : entry.afterRefs;
      if (JSON.stringify(references(current, entry.table, from)) !== JSON.stringify(expected)) {
        throw new VibeError('HISTORY_CONFLICT', 'References changed outside this editor; the Key cannot be safely renamed back.');
      }
      result = await renameResource(root, expectedRevision, 'key', pathFromParts([entry.table, from]), to);
    } else {
      result = await mutateProject(root, expectedRevision, current => {
        for (const change of entry.changes) {
          if (!equal(state(current, change.table, change.key, change.column), redo ? change.before : change.after)) {
            throw new VibeError('HISTORY_CONFLICT', 'This cell changed outside this editor: ' + change.table + '/' + change.key + '/' + change.column);
          }
        }
        const files = new Map<string, YamlFile>();
        for (const change of entry.changes) {
          const item = context(current, change.table, change.key, change.column);
          const file = files.get(item.file.file) ?? item.file;
          const desired = redo ? change.after : change.before;
          const exists = file.document.hasIn(['rows', item.index, change.column]);
          const updated = desired.present
            ? exists ? updateCell(file, item.schema, change.key, change.column, desired.value)
              : insertCell(file, item.schema, item.index, change.column, desired.value)
            : removeCell(file, item.index, change.column);
          files.set(file.file, updated);
        }
        return new Map([...files].map(([path, file]) => [path, file.source]));
      });
    }
    stack.pop();
    (redo ? this.undoStack : this.redoStack).push(entry);
    return result;
  }
}
