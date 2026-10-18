import type { StructurePreview, TableSummary } from '@vibe-spec/core';
export type { TableSummary } from '@vibe-spec/core';
export type TablesMode = 'create' | 'rename' | 'delete' | 'list';
export type TablesClientMessage = { type: 'ready' | 'tablesRefresh' }
  | { type: 'tableSelect'; table: string; mode: TablesMode }
  | { type: 'tableCreate'; revision: string; table: string; key: { code: string; label: string } }
  | { type: 'tableRename'; revision: string; table: string; to: string }
  | { type: 'tablePreviewDelete'; table: string }
  | { type: 'tableDelete'; revision: string; table: string; confirmed: true }
  | { type: 'tableOpen'; table: string };
export type TablesHostMessage = {
  type: 'tablesState'; revision: string; tables: TableSummary[]; mode: TablesMode; selected?: string;
  preview?: StructurePreview; notice?: string;
} | { type: 'error'; code: string; message: string };
export interface TablesHost {
  send(message: TablesClientMessage): void;
  subscribe(listener: (message: TablesHostMessage) => void): () => void;
}
