/** Source inspection reports stored literals; it never chooses planning schemas or Keys. */
export interface SourceCell {
  raw: string | null;
  type: string;
  formula?: string;
  formulaAttributes?: Record<string, string>;
  numberFormat?: string;
  hyperlink?: { target?: string; location?: string };
}
export interface SourceSheet {
  name: string;
  rowCount: number;
  columns: string[];
  cells: Record<string, SourceCell>;
  merges: string[];
  hidden?: boolean;
}
export interface SpreadsheetSource {
  kind: 'spreadsheet';
  file: string;
  sourceHash: string;
  format: 'csv' | 'tsv' | 'xlsx';
  sheets: SourceSheet[];
  issues: string[];
}
export interface NotionSourceFile {
  path: string;
  sha256: string;
  bytes: number;
  text?: string;
}
export interface NotionSourceLink {
  kind: 'link' | 'image';
  url: string;
  targetId?: string;
  targetPath?: string;
  self: boolean;
  anchor?: string;
}
export interface NotionSource {
  kind: 'notion';
  file: string;
  sourceHash: string;
  files: NotionSourceFile[];
  pages: { id: string; path: string; title: string; links: NotionSourceLink[] }[];
  databases: { id: string; preferred: string; files: string[] }[];
  issues: string[];
}
export type SourceInspection = SpreadsheetSource | NotionSource;
