import type { Diagnostic, EditOperation, HistoryInfo, StructureOperation, StructurePreview, Table, TableSchema, Usages } from '@vibe-spec/core';

export interface Snapshot {
  type: 'snapshot';
  table: string;
  schema: TableSchema;
  rows: Table['rows'];
  revision: string;
  diagnostics: Diagnostic[];
  references: Record<string, string[]>;
  requestId?: string;
  history?: HistoryInfo;
  tables?: string[];
  schemaTables?: string[];
  columnOrder?: string[];
}
export type HostMessage = Snapshot
  | { type: 'error'; code: string; message: string; requestId?: string; usages?: { key: string; result: Usages } }
  | { type: 'focus'; key: string; column: string; row?: boolean }
  | { type: 'usages'; key: string; result: Usages }
  | { type: 'viewState'; table: string; widths: Record<string, number> }
  | { type: 'notice'; message: string }
  | { type: 'copied' }
  | { type: 'structurePreview'; preview: StructurePreview };
export type ClientMessage = { type: 'ready' }
  | { type: 'draftState'; active: boolean }
  | { type: 'apply'; requestId: string; revision: string; operations: EditOperation[] }
  | { type: 'rename'; requestId: string; revision: string; key: string; to: string }
  | { type: 'undo' | 'redo'; requestId: string; revision: string }
  | { type: 'follow'; key: string; column: string }
  | { type: 'whereUsed'; key: string }
  | { type: 'openUsage'; kind: 'references' | 'candidates'; index: number }
  | { type: 'copy'; text: string }
  | { type: 'widths'; widths: Record<string, number> }
  | { type: 'structurePreview'; operation: StructureOperation }
  | { type: 'structureEdit'; requestId: string; revision: string; operation: StructureOperation }
  | { type: 'columnRename'; requestId: string; revision: string; column: string; to: string };
export interface Host {
  send(message: ClientMessage): void;
  subscribe(listener: (message: HostMessage) => void): () => void;
}
