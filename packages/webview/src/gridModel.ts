import type { CellAddress, TableSchema } from '@vibe-spec/core';

export interface Selection { anchor: CellAddress; focus: CellAddress }
export const sameCell = (a: CellAddress | undefined, b: CellAddress | undefined): boolean =>
  Boolean(a && b && a.key === b.key && a.column === b.column);
export const shortcut = (event: { metaKey: boolean; ctrlKey: boolean }): boolean => event.metaKey || event.ctrlKey;
export function tableColumns(schema: TableSchema, order: readonly string[] = Object.keys(schema.columns)) {
  return [schema.primary_key, ...order.filter(code => code !== schema.primary_key && Object.hasOwn(schema.columns, code))]
    .map(code => [code, schema.columns[code]!] as const);
}
export function selectionBounds(
  selection: Selection | undefined, rowIndex: ReadonlyMap<string, number>, columns: readonly string[],
): { top: number; bottom: number; left: number; right: number } | undefined {
  if (!selection) return;
  const start = rowIndex.get(selection.anchor.key), end = rowIndex.get(selection.focus.key);
  const a = columns.indexOf(selection.anchor.column), b = columns.indexOf(selection.focus.column);
  if (start === undefined || end === undefined || a < 0 || b < 0) return;
  return { top: Math.min(start, end), bottom: Math.max(start, end), left: Math.min(a, b), right: Math.max(a, b) };
}
