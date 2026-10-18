import type { Diagnostic, ImportInspection, ImportMapping, ImportPlan, TableSchema } from '@vibe-spec/core';
export type ImportClientMessage = { type: 'ready' } | { type: 'importPick' }
  | { type: 'importPlan'; mapping: ImportMapping }
  | { type: 'importApply'; revision: string };
export type ImportHostMessage = {
  type: 'importState'; revision: string; schemas: Record<string, TableSchema>;
  inspection?: ImportInspection; plan?: ImportPlan; applied?: boolean; changed?: string[]; diagnostics?: Diagnostic[];
} | { type: 'error'; code: string; message: string };
export interface ImportHost {
  send(message: ImportClientMessage): void;
  subscribe(listener: (message: ImportHostMessage) => void): () => void;
}
