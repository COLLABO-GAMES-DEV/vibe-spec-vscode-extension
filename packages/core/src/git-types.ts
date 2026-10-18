import type { Diagnostic } from './types.js';
export type GitConflict = {
  kind: 'row'; file: string; table: string; key: string;
  base: Record<string, unknown> | null; ours: Record<string, unknown> | null; theirs: Record<string, unknown> | null;
} | {
  kind: 'file'; file: string; managed: boolean; reason: string;
  base: string | null; ours: string | null; theirs: string | null;
};
export interface GitChoice { file: string; key?: string; choice: 'base' | 'ours' | 'theirs' }
export interface GitStatus {
  root: string;
  repository: string | null;
  gitDir: string | null;
  branch: string | null;
  revision: string;
  state: 'unsaved' | 'unpublished' | 'published' | 'conflict';
  remote: { name: string; url: string } | null;
  ahead: number;
  behind: number;
  changes: string[];
  otherChanges: string[];
  outgoing: { hash: string; reason: string; otherFiles: boolean }[];
  conflicts: GitConflict[];
  mergeInProgress: boolean;
}
export interface GitResult {
  action: 'save' | 'push' | 'pull' | 'resolve';
  completed: boolean;
  commit?: string;
  status: GitStatus;
  diagnostics: Diagnostic[];
}
