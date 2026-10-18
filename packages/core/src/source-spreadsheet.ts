import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, posix, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import * as XLSX from 'xlsx';
import type { SourceCell, SourceSheet, SpreadsheetSource } from './source-types.js';

type XmlElement = Record<string, unknown>;
interface Relationship { id: string; type: string; target: string; external: boolean }

function elements(parent: XmlElement | undefined, name: string): XmlElement[] {
  const value = parent?.[name];
  return (Array.isArray(value) ? value : [value]).filter(
    (item): item is XmlElement => item !== null && typeof item === 'object',
  );
}

function child(parent: XmlElement | undefined, name: string): XmlElement | undefined {
  return elements(parent, name)[0];
}

function attribute(node: XmlElement | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`];
  return typeof value === 'string' ? value : undefined;
}

function literal(node: XmlElement | undefined): string | null {
  if (!node) return null;
  return typeof node['#text'] === 'string' ? node['#text'] : '';
}

// Only indexes and coordinates enter JS numbers; cell values never do.
function index(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function emptySheet(name: string): SourceSheet {
  return { name, rowCount: 0, columns: [], cells: {}, merges: [] };
}

function readDelimited(buffer: Buffer, name: string, format: 'csv' | 'tsv'): SourceSheet {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('CSV/TSV must use UTF-8; invalid bytes were not replaced.'); }
  const rows = parse(text, {
    delimiter: format === 'tsv' ? '\t' : ',', bom: true, cast: false, trim: false,
    skip_empty_lines: false, relax_column_count: true,
  }) as string[][];
  const sheet = emptySheet(name);
  let columns = 0;
  rows.forEach((row, r) => {
    columns = Math.max(columns, row.length);
    row.forEach((raw, c) => { sheet.cells[XLSX.utils.encode_cell({ r, c })] = { raw, type: 'string' }; });
  });
  sheet.rowCount = rows.length;
  sheet.columns = Array.from({ length: columns }, (_, c) => XLSX.utils.encode_col(c));
  return sheet;
}

function partPath(owner: string, target: string): string {
  const decoded = decodeURIComponent(target);
  return posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(owner), decoded));
}

function richText(node: XmlElement | undefined): string | null {
  if (!node) return null;
  const plain = child(node, 't');
  if (plain) return literal(plain);
  // Phonetic annotations (rPh) are metadata, not part of the stored text.
  return elements(node, 'r').map(run => literal(child(run, 't')) ?? '').join('');
}

function range(ref: string): XLSX.Range {
  if (!/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(ref)) throw new Error(`Invalid XLSX coordinate: ${ref}`);
  const decoded = XLSX.utils.decode_range(ref);
  if (decoded.s.r > decoded.e.r || decoded.s.c > decoded.e.c || decoded.e.r >= 1048576 || decoded.e.c >= 16384) {
    throw new Error(`Invalid XLSX range: ${ref}`);
  }
  return decoded;
}

function readWorkbook(buffer: Buffer, issues: string[]): SourceSheet[] {
  const files = unzipSync(buffer);
  if (Object.keys(files).some(path => /^xl\/(media|drawings)\/.+/.test(path) && !path.endsWith('/'))) {
    issues.push('XLSX images or drawings are not included in the cell JSON; retain the original XLSX ZIP.');
  }
  const parser = new XMLParser({
    ignoreAttributes: false, removeNSPrefix: true, alwaysCreateTextNode: true,
    parseTagValue: false, parseAttributeValue: false, trimValues: false,
    // In this library numeric XML character references also require this option.
    htmlEntities: true,
  });
  let reportedLineEndings = false;
  const xml = (path: string): XmlElement => {
    const bytes = files[path];
    if (!bytes) throw new Error(`Missing XLSX part: ${path}`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\r') && !reportedLineEndings) {
      issues.push('XLSX XML line endings are normalized by the XML parser; literal CR bytes are not preserved.');
      reportedLineEndings = true;
    }
    return parser.parse(text, true) as XmlElement;
  };
  const relationships = (owner: string): Relationship[] => {
    const path = posix.join(posix.dirname(owner), '_rels', `${posix.basename(owner)}.rels`);
    if (!files[path]) return [];
    return elements(child(xml(path), 'Relationships'), 'Relationship').map(node => ({
      id: attribute(node, 'Id') ?? '', type: attribute(node, 'Type') ?? '',
      target: attribute(node, 'Target') ?? '', external: attribute(node, 'TargetMode') === 'External',
    }));
  };
  const rootRelationship = relationships('').find(rel => rel.type.endsWith('/officeDocument') && !rel.external);
  const workbookPath = rootRelationship ? partPath('', rootRelationship.target) : 'xl/workbook.xml';
  const workbook = child(xml(workbookPath), 'workbook');
  if (!workbook) throw new Error(`Missing workbook element in ${workbookPath}`);
  const workbookRels = relationships(workbookPath);
  const relatedPart = (kind: string): string | undefined => {
    const rel = workbookRels.find(item => item.type.endsWith(`/${kind}`) && !item.external);
    return rel ? partPath(workbookPath, rel.target) : undefined;
  };
  const stringsPath = relatedPart('sharedStrings');
  const strings = stringsPath ? elements(child(xml(stringsPath), 'sst'), 'si').map(richText) : [];
  const stylesPath = relatedPart('styles');
  const styles = stylesPath ? child(xml(stylesPath), 'styleSheet') : undefined;
  // Use the existing library's built-in format table and coordinate helpers only.
  // No XLSX value reader, formatting engine or formula evaluator is invoked.
  const formats: Record<string, string> = { ...XLSX.SSF.get_table() };
  for (const node of elements(child(styles, 'numFmts'), 'numFmt')) {
    const id = attribute(node, 'numFmtId');
    const code = attribute(node, 'formatCode');
    if (id !== undefined && code !== undefined) formats[id] = code;
  }
  const cellStyles = elements(child(styles, 'cellXfs'), 'xf');
  const baseStyles = elements(child(styles, 'cellStyleXfs'), 'xf');
  const sheets: SourceSheet[] = [];
  for (const node of elements(child(workbook, 'sheets'), 'sheet')) {
    const sheet = emptySheet(attribute(node, 'name') ?? '');
    sheet.hidden = ['hidden', 'veryHidden'].includes(attribute(node, 'state') ?? 'visible');
    sheets.push(sheet);
    const rel = workbookRels.find(item => item.id === attribute(node, 'id'));
    if (!rel || rel.external || !rel.type.endsWith('/worksheet')) {
      issues.push(`${sheet.name}: Missing or unsupported worksheet relationship; no cells were read.`);
      continue;
    }
    const sheetPath = partPath(workbookPath, rel.target);
    const worksheet = child(xml(sheetPath), 'worksheet');
    if (!worksheet) throw new Error(`Missing worksheet element in ${sheetPath}`);
    let columns = 0;
    const includeRange = (ref: string): XLSX.Range => {
      const decoded = range(ref);
      columns = Math.max(columns, decoded.e.c + 1);
      sheet.rowCount = Math.max(sheet.rowCount, decoded.e.r + 1);
      return decoded;
    };
    const dimension = attribute(child(worksheet, 'dimension'), 'ref');
    if (dimension) includeRange(dimension);
    let nextRow = 0;
    for (const row of elements(child(worksheet, 'sheetData'), 'row')) {
      const r = (index(attribute(row, 'r')) ?? nextRow + 1) - 1;
      if (r < 0 || r >= 1048576) throw new Error(`Invalid XLSX row in ${sheet.name}`);
      nextRow = r + 1;
      sheet.rowCount = Math.max(sheet.rowCount, nextRow);
      let nextColumn = 0;
      for (const entry of elements(row, 'c')) {
        const address = attribute(entry, 'r') ?? XLSX.utils.encode_cell({ r, c: nextColumn });
        if (address.includes(':')) throw new Error(`Invalid XLSX cell coordinate: ${address}`);
        const position = includeRange(address).s;
        nextColumn = position.c + 1;
        const type = attribute(entry, 't') ?? 'n';
        let raw = literal(child(entry, 'v'));
        if (type === 's') {
          const stringIndex = index(raw ?? undefined);
          raw = stringIndex === undefined ? null : strings[stringIndex] ?? null;
          if (raw === null) issues.push(`${sheet.name}!${address}: Missing or invalid shared string; no text was substituted.`);
        } else if (type === 'inlineStr') {
          raw = richText(child(entry, 'is'));
        }
        if (['s', 'inlineStr', 'str'].includes(type) && raw !== null && /_x[0-9a-fA-F]{4}_/.test(raw)) {
          issues.push(`${sheet.name}!${address}: SpreadsheetML escape text is preserved literally; interpretation is deferred (no decoding).`);
        }
        const cell: SourceCell = { raw, type };
        const formula = child(entry, 'f');
        if (formula) {
          cell.formula = literal(formula) ?? '';
          cell.formulaAttributes = Object.fromEntries(Object.entries(formula)
            .filter(([key, value]) => key.startsWith('@_') && typeof value === 'string')
            .map(([key, value]) => [key.slice(2), value as string]));
        }
        const styleIndex = index(attribute(entry, 's') ?? '0');
        const style = styleIndex === undefined ? undefined : cellStyles[styleIndex];
        const baseIndex = index(attribute(style, 'xfId'));
        const formatId = attribute(style, 'numFmtId')
          ?? attribute(baseIndex === undefined ? undefined : baseStyles[baseIndex], 'numFmtId');
        if (formatId !== undefined) {
          const code = formats[formatId];
          if (code !== undefined) cell.numberFormat = code;
          else issues.push(`${sheet.name}!${address}: Number format ${formatId} has no available format code.`);
        } else if (attribute(entry, 's') !== undefined && !style) {
          issues.push(`${sheet.name}!${address}: Missing or invalid cell style ${attribute(entry, 's')}.`);
        }
        sheet.cells[address] = cell;
      }
    }
    for (const merge of elements(child(worksheet, 'mergeCells'), 'mergeCell')) {
      const ref = attribute(merge, 'ref');
      if (ref) { includeRange(ref); sheet.merges.push(ref); }
    }
    const sheetRels = relationships(sheetPath);
    for (const link of elements(child(worksheet, 'hyperlinks'), 'hyperlink')) {
      const ref = attribute(link, 'ref');
      if (!ref) continue;
      const hyperlink: NonNullable<SourceCell['hyperlink']> = {};
      const id = attribute(link, 'id');
      const target = sheetRels.find(item => item.id === id)?.target;
      const location = attribute(link, 'location');
      if (target !== undefined) hyperlink.target = target;
      if (location !== undefined) hyperlink.location = location;
      if (id !== undefined && target === undefined) issues.push(`${sheet.name}!${ref}: Missing hyperlink relationship ${id}.`);
      const bounds = includeRange(ref);
      for (let r = bounds.s.r; r <= bounds.e.r; r++) {
        for (let c = bounds.s.c; c <= bounds.e.c; c++) {
          const address = XLSX.utils.encode_cell({ r, c });
          const cell = sheet.cells[address] ?? { raw: null, type: 'blank' };
          cell.hyperlink = { ...hyperlink };
          sheet.cells[address] = cell;
        }
      }
    }
    sheet.columns = Array.from({ length: columns }, (_, c) => XLSX.utils.encode_col(c));
  }
  return sheets;
}

/** Inspect stored source literals and metadata without selecting a table, Key or schema. */
export async function inspectSpreadsheetSource(file: string): Promise<SpreadsheetSource> {
  const absoluteFile = resolve(file);
  const extension = extname(absoluteFile).toLowerCase();
  if (extension !== '.csv' && extension !== '.tsv' && extension !== '.xlsx') {
    throw new Error(`Unsupported source file extension: ${extension || '(none)'}. Use CSV, TSV or XLSX.`);
  }
  const format = extension.slice(1) as SpreadsheetSource['format'];
  const buffer = await readFile(absoluteFile);
  const issues: string[] = [];
  const sheets = format === 'xlsx' ? readWorkbook(buffer, issues)
    : [readDelimited(buffer, basename(absoluteFile, extname(absoluteFile)), format)];
  return { kind: 'spreadsheet', file: absoluteFile, sourceHash: createHash('sha256').update(buffer).digest('hex'), format, sheets, issues };
}
