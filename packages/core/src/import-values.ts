import { Decimal } from 'decimal.js';
import type { ImportSheet } from './import-types.js';

const decimalSyntax = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const zeroSyntax = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[eE][+-]?\d+)?$/;

/** Normalize an exact numeric literal, without passing its value through Number. */
export function normalizeImportInteger(raw: string): string | undefined {
  if (!decimalSyntax.test(raw)) return undefined;
  try {
    const value = new Decimal(raw);
    if (!value.isFinite() || !value.isInteger() || value.isZero() && !zeroSyntax.test(raw)) return undefined;
    return value.isZero() ? '0' : value.toFixed(0);
  } catch {
    return undefined;
  }
}

/** Suggest a type from the values that the selected import would actually write. */
export function inferImportColumnType(sheet: ImportSheet, column: string, options: {
  dataStartRow?: number;
  excludeRows?: number[];
  numeric?: 'stored' | 'display';
  representations?: Record<string, 'stored' | 'display'>;
} = {}): 'integer' | 'text' {
  const excluded = new Set(options.excludeRows ?? []);
  let nonempty = false;
  for (let row = options.dataStartRow ?? sheet.data_start_row; row <= sheet.rowCount; row++) {
    if (excluded.has(row)) continue;
    const address = column + row, cell = sheet.cells[address];
    if (!cell) continue;
    if (cell.unsupported || cell.sourceType === 'date' || cell.sourceType === 'error') return 'text';
    let value = cell.normalizedInteger ?? cell.raw;
    if (cell.normalizedInteger === undefined && (options.representations?.[address] ?? options.numeric) === 'display') {
      if (cell.displaySafe === false) return 'text';
      if (cell.display !== undefined && cell.display !== String(value ?? '')) {
        if (!cell.displaySafe) return 'text';
        value = cell.display;
      }
    }
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value)) return 'text';
    nonempty = true;
  }
  return nonempty ? 'integer' : 'text';
}
