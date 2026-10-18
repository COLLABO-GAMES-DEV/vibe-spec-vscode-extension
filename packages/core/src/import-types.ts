import type { Cell, Diagnostic, TableSchema } from './types.js';

export interface ImportIssue {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  sheet?: string;
  cell?: string;
}
export interface ImportCell {
  sourceType?: 'number' | 'text' | 'boolean' | 'date' | 'error' | 'blank';
  /** Exact integer candidate from an XLSX numeric literal; raw remains untouched. */
  normalizedInteger?: string;
  raw?: Cell;
  /** Calculated display candidate, never a recovered original numeric literal. */
  display?: string;
  displaySafe?: boolean;
  formula?: string;
  unsupported?: string;
}
export interface ImportSheet {
  name: string;
  columns: string[];
  rowCount: number;
  cells: Record<string, ImportCell>;
  header_row: number;
  start_column: string;
  data_start_row: number;
  inferredTypes?: Record<string, 'integer' | 'text'>;
}
export interface ImportInspection {
  file: string;
  sourceHash: string;
  format: 'csv' | 'tsv' | 'xlsx';
  sheets: ImportSheet[];
  issues: ImportIssue[];
}
export interface ImportMapping {
  table: string;
  folder?: string;
  schema: string;
  definition?: TableSchema;
  sheet: string;
  header_row: number;
  data_start_row: number;
  columns: Record<string, string>;
  numeric: 'stored' | 'display';
  representations?: Record<string, 'stored' | 'display'>;
  exclude_rows?: number[];
}
export interface ImportNormalization { cell: string; column: string; raw: string; value: string }
export interface ImportPlan {
  file: string;
  sourceHash: string;
  revision: string;
  mapping: ImportMapping;
  files: string[];
  normalizations?: ImportNormalization[];
  provenanceFile?: string;
  rows: { sourceRow: number; values: Record<string, Cell> }[];
  issues: ImportIssue[];
  diagnostics: Diagnostic[];
  canApply: boolean;
}
