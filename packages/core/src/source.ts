import { extname, resolve } from 'node:path';
import { VibeError } from './types.js';
import type { SourceInspection } from './source-types.js';

export async function inspectSource(file: string): Promise<SourceInspection> {
  const path = resolve(file), extension = extname(path).toLowerCase();
  if (extension === '.zip') return (await import('./source-notion.js')).inspectNotionSource(path);
  if (['.csv', '.tsv', '.xlsx'].includes(extension)) return (await import('./source-spreadsheet.js')).inspectSpreadsheetSource(path);
  throw new VibeError('SOURCE_FORMAT', 'Use CSV, TSV, XLSX or a Notion export ZIP.');
}
