import type { Column, Usages } from './types.js';
export interface ColumnPosition { anchor: string; side: 'before' | 'after' }
export type StructureOperation =
  | { op: 'column-add'; table: string; column: string; definition: Column; position?: ColumnPosition }
  | { op: 'column-update'; table: string; column: string; changes: Partial<Column> }
  | { op: 'column-delete'; table: string; column: string }
  | { op: 'column-move'; table: string; column: string; position: ColumnPosition }
  | { op: 'table-create'; table: string; folder?: string; key: { code: string; label: string } }
  | { op: 'table-delete'; table: string };
export interface StructurePreview {
  operation: StructureOperation;
  revision: string;
  tables: string[];
  files: string[];
  usages: Usages;
  blocked?: string;
}
