import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { Decimal } from 'decimal.js';
import { readSheet } from 'read-excel-file/node';
import * as XLSX from 'xlsx';
import type { ImportCell, ImportInspection, ImportIssue, ImportSheet } from './import-types.js';
import { inferImportColumnType, normalizeImportInteger } from './import-values.js';
import { VibeError } from './types.js';

// SheetJS exposes these with bookFiles/cellStyles, but omits them from WorkBook's types.
type WorkbookMetadata = XLSX.WorkBook & {
  keys?: string[];
  Styles?: { CellXf?: Record<string, unknown>[] };
};

function warning(issues: ImportIssue[], code: string, message: string, sheet?: string, cell?: string): void {
  issues.push({ code, severity: 'warning', message, ...(sheet === undefined ? {} : { sheet }),
    ...(cell === undefined ? {} : { cell }) });
}

function suggestHeader(sheet: ImportSheet, issues: ImportIssue[]): void {
  let first: XLSX.CellAddress | undefined;
  for (const [address, cell] of Object.entries(sheet.cells)) {
    if (cell.raw === undefined || cell.raw === null || cell.raw === '') continue;
    const position = XLSX.utils.decode_cell(address);
    if (!first || position.r < first.r || (position.r === first.r && position.c < first.c)) first = position;
  }
  sheet.header_row = first ? first.r + 1 : 1;
  sheet.start_column = first ? XLSX.utils.encode_col(first.c) : 'A';
  sheet.data_start_row = sheet.header_row + 1;
  const seen = new Map<string, string>();
  for (const column of sheet.columns) {
    const address = `${column}${sheet.header_row}`;
    const value = sheet.cells[address]?.raw;
    if (value === undefined || value === null || value === '') continue;
    const label = String(value);
    const previous = seen.get(label);
    if (previous) warning(issues, 'IMPORT_DUPLICATE_HEADER',
      `Header ${JSON.stringify(label)} is repeated at ${previous} and ${address}; map columns by their coordinates.`, sheet.name, address);
    else seen.set(label, address);
  }
}

function emptySheet(name: string): ImportSheet {
  return { name, columns: [], rowCount: 0, cells: {}, header_row: 1, start_column: 'A', data_start_row: 2 };
}

function readDelimited(buffer: Buffer, name: string, format: 'csv' | 'tsv', issues: ImportIssue[]): ImportSheet {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new VibeError('IMPORT_ENCODING', 'CSV/TSV must use UTF-8; unsupported bytes were not replaced.'); }
  const rows = parse(text, {
    delimiter: format === 'tsv' ? '\t' : ',', bom: true, cast: false, trim: false,
    skip_empty_lines: false, relax_column_count: true,
  }) as string[][];
  const sheet = emptySheet(name);
  let columnCount = 0;
  rows.forEach((row, r) => {
    columnCount = Math.max(columnCount, row.length);
    row.forEach((raw, c) => { sheet.cells[XLSX.utils.encode_cell({ r, c })] = { raw }; });
  });
  sheet.rowCount = rows.length;
  sheet.columns = Array.from({ length: columnCount }, (_, c) => XLSX.utils.encode_col(c));
  suggestHeader(sheet, issues);
  return sheet;
}

function numericDisplaySafe(raw: string, value: XLSX.CellObject['v']): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  try {
    const stored = new Decimal(raw);
    return stored.isFinite() && stored.equals(new Decimal(value));
  } catch {
    return false;
  }
}

function inspectCell(raw: unknown, metadata: XLSX.CellObject | undefined,
  sheet: string, address: string, issues: ImportIssue[]): ImportCell {
  const cell: ImportCell = {};
  const date = raw instanceof Date || metadata?.t === 'd'
    || metadata?.t === 'n' && typeof metadata.z === 'string' && XLSX.SSF.is_date(metadata.z);
  cell.sourceType = date ? 'date' : metadata?.t === 'n' ? 'number'
    : metadata?.t === 'b' ? 'boolean' : metadata?.t === 'e' ? 'error'
      : metadata?.t === 'z' || raw == null && !metadata ? 'blank' : 'text';
  // The libraries disagree on some SpreadsheetML control-character escapes.
  // Report them instead of guessing a decoder or substituting a normalized value.
  if (metadata?.t === 's' && typeof raw === 'string' && typeof metadata.v === 'string' && raw !== metadata.v) {
    cell.unsupported = 'XLSX text readers disagree on escapes or line endings. Export this text as UTF-8 CSV to retain it without normalization.';
  }
  if (metadata?.f !== undefined || metadata?.F !== undefined) {
    cell.formula = metadata.f ?? metadata.F!;
    warning(issues, 'IMPORT_FORMULA', 'Only the stored formula result can be imported; it may be stale. Formulas are not calculated.', sheet, address);
  }
  if (raw instanceof Date || metadata?.t === 'd') {
    cell.unsupported = 'The reader converted this date to a Date object; its original stored literal cannot be guaranteed.';
  } else if (metadata?.t === 'e' && (cell.formula === undefined || metadata.v !== undefined)) {
    cell.unsupported = `Spreadsheet error${metadata.w ? ` (${metadata.w})` : ''}; no usable stored value is available.`;
  } else if (cell.formula !== undefined && (raw === undefined || raw === null)) {
    cell.unsupported = 'No losslessly readable cached formula result is available.';
  } else if (typeof raw === 'string' || typeof raw === 'boolean' || raw === null) {
    cell.raw = raw;
  } else if (raw === undefined && (!metadata || metadata.t === 'z')) {
    cell.raw = null;
  } else {
    cell.unsupported = 'The reader did not return a lossless string, boolean or empty value for this cell.';
  }

  if (metadata?.w !== undefined) cell.display = metadata.w;
  if (metadata?.t === 'n' && typeof cell.raw === 'string') {
    if (!date && !cell.unsupported) {
      const normalized = normalizeImportInteger(cell.raw);
      if (normalized !== undefined) cell.normalizedInteger = normalized;
    }
    // Never use metadata.v (already a JS number) to construct the stored value.
    cell.displaySafe = cell.display !== undefined && numericDisplaySafe(cell.raw, metadata.v);
    if (!cell.displaySafe) warning(issues, 'IMPORT_UNSAFE_DISPLAY',
      'The calculated display candidate uses an inexact or non-finite numeric value, or is unavailable; choose the losslessly read stored value.', sheet, address);
  } else if (cell.display !== undefined) {
    cell.displaySafe = cell.unsupported === undefined;
  }
  if (cell.display !== undefined && cell.raw !== undefined && cell.raw !== null && cell.display !== String(cell.raw)) {
    warning(issues, 'IMPORT_DISPLAY_VALUE',
      'Stored value and calculated display candidate differ. Choose which representation to import; the candidate is not the original displayed text.', sheet, address);
  }
  if (cell.unsupported) {
    cell.displaySafe = false;
    warning(issues, 'IMPORT_UNSUPPORTED_CELL', cell.unsupported, sheet, address);
  }
  if (typeof metadata?.r === 'string' && /<rPr[\s>]/.test(metadata.r)) {
    warning(issues, 'IMPORT_UNSUPPORTED_FORMAT', 'Rich-text formatting is not imported; only the cell text is retained.', sheet, address);
  }
  return cell;
}

function inspectSheetMetadata(metadata: XLSX.WorkSheet, name: string, issues: ImportIssue[]): void {
  metadata['!rows']?.forEach((row, r) => {
    if (row?.hidden) warning(issues, 'IMPORT_HIDDEN_ROW', `Row ${r + 1} is hidden and is still included in the inspection.`, name, `A${r + 1}`);
  });
  metadata['!cols']?.forEach((column, c) => {
    if (column?.hidden) warning(issues, 'IMPORT_HIDDEN_COLUMN', `Column ${XLSX.utils.encode_col(c)} is hidden and is still included in the inspection.`, name, `${XLSX.utils.encode_col(c)}1`);
  });
  for (const range of metadata['!merges'] ?? []) {
    warning(issues, 'IMPORT_MERGED_CELLS', `Merged range ${XLSX.utils.encode_range(range)} is not expanded; only stored cells are read.`, name, XLSX.utils.encode_cell(range.s));
  }
}

function inspectWorkbookMetadata(workbook: WorkbookMetadata, issues: ImportIssue[]): void {
  if (workbook.keys?.some(key => /^xl\/(media|drawings)\//.test(key))) {
    warning(issues, 'IMPORT_IMAGES', 'Workbook images and drawing objects are not imported.');
  }
  if (workbook.Styles?.CellXf?.some(style =>
    ['fontId', 'fillId', 'borderId'].some(key => typeof style[key] === 'number' && style[key] !== 0)
    || style.alignment !== undefined || style.protection !== undefined)) {
    warning(issues, 'IMPORT_UNSUPPORTED_FORMAT', 'Font, fill, border, alignment and protection formatting are not imported. Number displays are calculated candidates only.');
  }
}

async function readWorkbook(buffer: Buffer, issues: ImportIssue[]): Promise<ImportSheet[]> {
  const workbook: WorkbookMetadata = XLSX.read(buffer, {
    type: 'buffer', cellStyles: true, cellNF: true, cellFormula: true,
    cellText: true, sheetStubs: true, bookFiles: true,
  });
  inspectWorkbookMetadata(workbook, issues);
  const sheets: ImportSheet[] = [];
  for (const [index, name] of workbook.SheetNames.entries()) {
    const metadata = workbook.Sheets[name]!;
    const sheet = emptySheet(name);
    if (workbook.Workbook?.Sheets?.[index]?.Hidden) {
      warning(issues, 'IMPORT_HIDDEN_SHEET', 'This sheet is hidden and is still included in the inspection.', name);
    }
    inspectSheetMetadata(metadata, name, issues);
    let rows: unknown[][] = [];
    let readFailure: string | undefined;
    try {
      rows = await readSheet(buffer, name, { parseNumber: value => value, trim: false });
    } catch (error) {
      readFailure = `The lossless sheet reader failed: ${error instanceof Error ? error.message : String(error)}`;
      warning(issues, 'IMPORT_UNSUPPORTED_SHEET', readFailure, name);
    }
    let columnCount = 0;
    rows.forEach((row, r) => {
      columnCount = Math.max(columnCount, row.length);
      row.forEach((raw, c) => {
        const address = XLSX.utils.encode_cell({ r, c });
        sheet.cells[address] = inspectCell(raw, metadata[address] as XLSX.CellObject | undefined, name, address, issues);
      });
    });
    sheet.rowCount = rows.length;
    // The raw reader discards trailing empty cells (including formula/error cells).
    // Metadata supplies coordinates and diagnostics, never replacement raw values.
    for (const address of Object.keys(metadata)) {
      if (!/^[A-Z]+[1-9]\d*$/.test(address)) continue;
      const position = XLSX.utils.decode_cell(address);
      columnCount = Math.max(columnCount, position.c + 1);
      sheet.rowCount = Math.max(sheet.rowCount, position.r + 1);
      if (sheet.cells[address]) continue;
      if (readFailure) {
        sheet.cells[address] = { unsupported: readFailure, displaySafe: false };
      } else {
        sheet.cells[address] = inspectCell(undefined, metadata[address] as XLSX.CellObject, name, address, issues);
      }
    }
    if (metadata['!ref']) {
      const range = XLSX.utils.decode_range(metadata['!ref']);
      columnCount = Math.max(columnCount, range.e.c + 1);
      sheet.rowCount = Math.max(sheet.rowCount, range.e.r + 1);
    }
    sheet.columns = Array.from({ length: columnCount }, (_, c) => XLSX.utils.encode_col(c));
    suggestHeader(sheet, issues);
    sheets.push(sheet);
  }
  return sheets;
}

export async function inspectImport(file: string): Promise<ImportInspection> {
  const absoluteFile = resolve(file);
  const extension = extname(absoluteFile).toLowerCase();
  if (extension !== '.csv' && extension !== '.tsv' && extension !== '.xlsx') {
    throw new Error(`Unsupported import file extension: ${extension || '(none)'}. Use CSV, TSV or XLSX.`);
  }
  const format = extension.slice(1) as ImportInspection['format'];
  const buffer = await readFile(absoluteFile);
  const issues: ImportIssue[] = [];
  const sheets = format === 'xlsx'
    ? await readWorkbook(buffer, issues)
    : [readDelimited(buffer, basename(absoluteFile, extname(absoluteFile)), format, issues)];
  for (const sheet of sheets) {
    sheet.inferredTypes = Object.fromEntries(sheet.columns.map(column => [column, inferImportColumnType(sheet, column)]));
  }
  return { file: absoluteFile, sourceHash: createHash('sha256').update(buffer).digest('hex'), format, sheets, issues };
}
