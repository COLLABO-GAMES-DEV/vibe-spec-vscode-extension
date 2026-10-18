import type { GitChoice, GitResult, GitStatus } from '@vibe-spec/core';
export type GitClientMessage = { type: 'ready' | 'gitRefresh' | 'gitPush' | 'gitPull' }
  | { type: 'gitSave'; reason: string; revision: string }
  | { type: 'gitResolve'; revision: string; choices: GitChoice[] };
export type GitHostMessage = { type: 'gitState'; status: GitStatus; editing: boolean; result?: GitResult }
  | { type: 'error'; action?: string; code: string; message: string };
export interface GitHost {
  send(message: GitClientMessage): void;
  subscribe(listener: (message: GitHostMessage) => void): () => void;
}
