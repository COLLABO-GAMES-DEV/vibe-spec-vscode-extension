import { pathFromParts } from './paths.js';
import { isRecord, VibeError } from './types.js';
import type { Diagnostic, EditOperation, Project } from './types.js';
import { tableContexts } from './validation.js';

// Incomplete numeric keystrokes are a GUI draft, distinct from completed invalid values.
// CLI edits still use applyEdits directly and retain the normal validation/reporting contract.
const unfinishedNumber = /^[+-]?(?:\.?|(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?)$/;

export function assertCompleteCellInputs(project: Project, operations: EditOperation[]): void {
  const tables = tableContexts(project);
  const diagnostics: Diagnostic[] = [];
  for (const operation of operations) {
    if (operation.op === 'delete') continue;
    const context = tables.get(operation.table);
    if (!context) continue;
    const values = operation.op === 'create' ? operation.row : operation.values;
    if (!isRecord(values)) continue;
    for (const [field, value] of Object.entries(values)) {
      const type = context.schema.columns[field]?.type;
      if (type !== 'integer' && type !== 'decimal' || typeof value !== 'string' || !unfinishedNumber.test(value)) continue;
      const key = operation.op === 'create' ? values[context.schema.primary_key] : operation.key;
      diagnostics.push({ code: 'INCOMPLETE_NUMBER', file: context.file.file,
        path: pathFromParts([operation.table, String(key), field]),
        message: 'Finish the numeric literal before committing; the draft is kept.' });
    }
  }
  if (diagnostics.length) throw new VibeError('INCOMPLETE_NUMBER',
    '숫자 입력이 아직 완성되지 않았습니다. 숫자를 완성하거나 Esc로 취소해 주세요.', diagnostics);
}
