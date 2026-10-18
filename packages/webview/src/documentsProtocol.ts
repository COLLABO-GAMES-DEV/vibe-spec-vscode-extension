import type { DocumentOperation, DocumentSnapshotBlock, DocumentSummary, DocumentView, Usages } from '@vibe-spec/core';
export type DocumentsClientMessage =
  | { type: 'ready' }
  | { type: 'documentsRefresh' }
  | { type: 'documentOpen'; name: string; path?: string }
  | { type: 'documentCreate'; name: string; revision: string }
  | { type: 'documentEdit'; name: string; revision: string; operations: DocumentOperation[] }
  | { type: 'documentDraft'; dirty: boolean }
  | { type: 'documentSaveRequest'; reason?: string }
  | { type: 'documentSnapshot'; requestId: string; name: string; revision: string; dirty: boolean; blocks: DocumentSnapshotBlock[] }
  | { type: 'documentSnapshotError'; requestId: string; message: string }
  | { type: 'documentDelete'; name: string; revision: string; confirmed: boolean }
  | { type: 'documentRename'; kind: 'document' | 'heading' | 'tag'; path: string; to: string; revision: string }
  | { type: 'documentImage'; name: string; data: string; revision: string }
  | { type: 'documentNavigate'; path: string }
  | { type: 'documentUsage'; path: string };
export type DocumentsState = { type: 'documentsState'; revision: string; documents: DocumentSummary[]; view?: DocumentView;
  assets: Record<string, string>; replace?: boolean; focusPath?: string; notice?: string };
export type DocumentsHostMessage =
  | DocumentsState
  | { type: 'documentFlush'; requestId: string }
  | { type: 'documentFlushResult'; requestId: string; ok: boolean; state?: DocumentsState; code?: string; message?: string }
  | { type: 'documentImageAdded'; path: string; revision: string }
  | { type: 'documentUsages'; path: string; usages: Usages }
  | { type: 'error'; code: string; message: string };
export interface DocumentsHost {
  send(message: DocumentsClientMessage): void;
  subscribe(listener: (message: DocumentsHostMessage) => void): () => void;
}
