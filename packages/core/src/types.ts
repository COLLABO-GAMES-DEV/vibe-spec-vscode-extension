import type { Document } from 'yaml';

export type Cell = string | boolean | null;
export interface Column {
  type: 'string' | 'text' | 'integer' | 'decimal' | 'boolean' | 'enum' | 'ref';
  label?: string;
  required?: boolean;
  nullable?: boolean;
  values?: string[];
  minimum?: string;
  maximum?: string;
  table?: string;
  on_delete?: 'restrict';
}
export interface TableSchema {
  primary_key: string;
  columns: Record<string, Column>;
  unique?: string[][];
}
export interface Table {
  schema: string;
  rows: Record<string, unknown>[];
}
export interface Diagnostic {
  code: string;
  file: string;
  path: string;
  message: string;
  severity?: 'warning';
  target?: string;
}
export interface YamlFile {
  file: string;
  source: string;
  document: Document.Parsed;
  data: unknown;
}
export interface Project {
  root: string;
  revision: string;
  sources: ReadonlyMap<string, string>;
  files: ReadonlyMap<string, YamlFile>;
  assets?: ReadonlyMap<string, Uint8Array>;
  /** Existing managed directories, relative to the planning root, using '/'. */
  directories?: readonly string[];
  diagnostics: readonly Diagnostic[];
}
export type EditOperation =
  | { op: 'create'; table: string; row: Record<string, Cell> }
  | { op: 'update'; table: string; key: string; values: Record<string, Cell> }
  | { op: 'delete'; table: string; key: string };
export interface Usage {
  file: string;
  path: string;
  line: number;
  text: string;
}
export interface Usages { references: Usage[]; candidates: Usage[] }
export interface WriteResult {
  project: Project;
  before: Project;
  planned: Project;
  changed: string[];
  diagnostics: Diagnostic[];
  candidates: Usage[];
}
export interface MutationOptions { dryRun?: boolean }
export interface CellAddress { key: string; column: string }
export interface HistoryInfo { canUndo: boolean; canRedo: boolean }
export type RenameKind = 'key' | 'table' | 'column' | 'schema' | 'document' | 'heading' | 'tag';
export class VibeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly diagnostics: readonly Diagnostic[] = [],
    public readonly written: readonly string[] = [],
  ) {
    super(message);
    this.name = 'VibeError';
  }
}
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const validName = (value: string): boolean => value.length > 0 && !value.includes('/');
