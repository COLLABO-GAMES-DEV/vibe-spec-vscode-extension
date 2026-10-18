import type { Diagnostic } from './types.js';

/** Source offsets and indices are valid only for their read revision; never persisted IDs. */
export interface DocumentBlock {
  index: number;
  kind: string;
  start: number;
  end: number;
  markdown: string;
  path?: string;
  editable: boolean;
  issues: string[];
}
export interface DocumentLink {
  destination: string;
  start: number;
  end: number;
  kind: 'resource' | 'image' | 'external';
  path?: string;
  block: number;
  resolved?: boolean;
  value?: unknown;
}
export interface ParsedDocument {
  name: string;
  source: string;
  blocks: DocumentBlock[];
  links: DocumentLink[];
  diagnostics: Diagnostic[];
}
export interface DocumentView extends ParsedDocument { revision: string }
export interface DocumentSummary { name: string; errors: number; warnings: number }
/** Desired document order at one read revision. Omitting markdown reuses source bytes. */
export interface DocumentSnapshotBlock {
  original?: number;
  markdown?: string;
}
export interface DocumentSnapshot { name: string; blocks: DocumentSnapshotBlock[] }
export type DocumentOperation =
  | { op: 'replace'; block: number; markdown: string }
  | { op: 'insert'; before: number; markdown: string }
  | { op: 'delete'; block: number };
