import { renameResource, applyEdits } from './editing.js';
import { assertCompleteCellInputs } from './input.js';
import { pathFromParts } from './paths.js';
import { applyStructureEdit } from './structure.js';
import type { ScreenHistory } from './history.js';
import type { StructureOperation } from './structure-types.js';
import type { EditOperation, Project, WriteResult } from './types.js';
import { isRecord, VibeError } from './types.js';

/** A write requested by one table screen. Hosts add their own request IDs around it. */
export type TableWrite =
  | { type: 'apply'; revision: string; operations: EditOperation[] }
  | { type: 'rename'; revision: string; key: string; to: string }
  | { type: 'undo' | 'redo'; revision: string }
  | { type: 'structureEdit'; revision: string; operation: StructureOperation }
  | { type: 'columnRename'; revision: string; column: string; to: string };

const text = (value: unknown): value is string => typeof value === 'string';

/** Reads an untrusted request body as a table write. Returns undefined for non-write messages. */
export function parseTableWrite(value: unknown): TableWrite | undefined {
  if (!isRecord(value) || !['apply', 'rename', 'undo', 'redo', 'structureEdit', 'columnRename'].includes(value.type as string)) return undefined;
  const { type, revision } = value;
  const invalid = () => new VibeError('INVALID_EDIT', 'Malformed ' + String(type) + ' request.');
  if (!text(revision)) throw invalid();
  switch (type) {
    case 'apply':
      if (!Array.isArray(value.operations) || !value.operations.every(isRecord)) throw invalid();
      return { type, revision, operations: value.operations as EditOperation[] };
    case 'rename':
      if (!text(value.key) || !text(value.to)) throw invalid();
      return { type, revision, key: value.key, to: value.to };
    case 'structureEdit':
      if (!isRecord(value.operation) || !text(value.operation.op) || !text(value.operation.table)) throw invalid();
      return { type, revision, operation: value.operation as StructureOperation };
    case 'columnRename':
      if (!text(value.column) || !text(value.to)) throw invalid();
      return { type, revision, column: value.column, to: value.to };
    default:
      return { type: type as 'undo' | 'redo', revision };
  }
}

/** Table screens may only change columns of the table they show. */
export function assertTableColumnOperation(table: string, operation: StructureOperation) {
  if (operation.table !== table || !operation.op.startsWith('column-')) {
    throw new VibeError('INVALID_EDIT', '현재 표의 열을 선택해 주세요.');
  }
}

/**
 * Applies one table-screen write against `project.root` and records it in that screen's history.
 * The VS Code host and the browser development host share this so both enforce the same rules.
 */
export async function applyTableWrite(project: Project, table: string, history: ScreenHistory, write: TableWrite): Promise<WriteResult> {
  const root = project.root;
  if (write.type === 'apply') {
    if (!Array.isArray(write.operations) || write.operations.some(op => op.table !== table)) {
      throw new VibeError('INVALID_EDIT', '현재 표의 칸만 편집할 수 있습니다.');
    }
    assertCompleteCellInputs(project, write.operations);
    const result = await applyEdits(root, write.revision, write.operations);
    history.recordCells(result, write.operations);
    return result;
  }
  if (write.type === 'rename') {
    const result = await renameResource(root, write.revision, 'key', pathFromParts([table, write.key]), write.to);
    history.recordRename(result, table, write.key, write.to);
    return result;
  }
  if (write.type === 'structureEdit') {
    assertTableColumnOperation(table, write.operation);
    const result = await applyStructureEdit(root, write.revision, write.operation);
    history.recordStructure(result);
    return result;
  }
  if (write.type === 'columnRename') {
    const result = await renameResource(root, write.revision, 'column', table + '/*/' + write.column, write.to);
    history.recordStructure(result);
    return result;
  }
  if (write.type === 'undo' || write.type === 'redo') return history[write.type](root, write.revision);
  throw new VibeError('INVALID_EDIT', 'Unknown table write.');
}
