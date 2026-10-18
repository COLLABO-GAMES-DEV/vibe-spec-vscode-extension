import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { inspectImport } from '../src/import-reader.js';

const fixtures = fileURLToPath(new URL('./fixtures/import/', import.meta.url));
const roots: string[] = [];

async function input(name: string, content: string | Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibe-import-reader-'));
  roots.push(root);
  const file = join(root, name);
  await writeFile(file, content);
  return file;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const xml = (content: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${content}`;
const sheetXml = (content: string) => xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${content}</worksheet>`);

// Put the literals directly in the ZIP's worksheet XML. Writing them as numeric
// JS values with an XLSX writer would lose precision before the reader is tested.
function workbook(sheet: string, extraFiles: Record<string, string | Buffer> = {}): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['placeholder']]), 'Data');
  const hidden = XLSX.utils.aoa_to_sheet([['Key'], ['hidden-value']]);
  XLSX.utils.book_append_sheet(book, hidden, 'Hidden');
  XLSX.utils.book_set_sheet_visibility(book, 'Hidden', 2);
  const zip = XLSX.CFB.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  for (const [path, value] of Object.entries({ 'xl/worksheets/sheet1.xml': sheet, ...extraFiles })) {
    XLSX.CFB.utils.cfb_add(zip, `/${path}`, typeof value === 'string' ? Buffer.from(value) : value);
  }
  return XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' }) as Buffer;
}

const styles = xml(`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="0.00%"/></numFmts>
  <fonts count="2"><font/><font><b/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`);

describe('source snapshots', () => {
  it.each(['csv', 'xlsx'] as const)('inspects synthetic items.%s with original B2 and row 145 coordinates', async format => {
    const file = join(fixtures, `items.${format}`);
    const bytes = await readFile(file);
    const inspection = await inspectImport(relative(process.cwd(), file));
    expect(inspection.file).toBe(file);
    expect(inspection.sourceHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(inspection.format).toBe(format);
    const sheet = inspection.sheets[0]!;
    expect(sheet).toMatchObject({ header_row: 2, start_column: 'B', data_start_row: 3, rowCount: 147 });
    expect(sheet.columns).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(sheet.cells.B2?.raw).toBe('Key');
    expect(sheet.cells.C2?.raw).toBe('Source');
    expect(sheet.cells.D2?.raw).toBe('Lore');
    expect(sheet.cells.E2?.raw).toBe('Note');
    expect(sheet.cells.B3?.raw).toBe('sample_item_001');
    expect(sheet.cells.C3?.raw).toBe('합성 아이템 001');
    expect(sheet.cells.B145?.raw).toBe('sample_item_143');
    expect(sheet.cells.C145?.raw).toBe('합성 아이템 143');
    expect(sheet.cells.D145?.raw).toBe('합성 설명 143입니다.');
    expect(inspection.issues.every(issue => issue.severity === 'warning')).toBe(true);
  });

  it('reads the same nonempty source strings in both synthetic formats', async () => {
    const csv = (await inspectImport(join(fixtures, 'items.csv'))).sheets[0]!;
    const xlsx = (await inspectImport(join(fixtures, 'items.xlsx'))).sheets[0]!;
    for (const [address, cell] of Object.entries(csv.cells)) {
      if (cell.raw !== '') expect(xlsx.cells[address]?.raw, address).toBe(cell.raw);
    }
  });
});

describe('delimited files', () => {
  it.each(['csv', 'tsv'] as const)('preserves leading/internal blanks, whitespace, quoting and numeric literals in %s', async format => {
    const separator = format === 'csv' ? ',' : '\t';
    const content = '\uFEFF\r\n\r\n' + [
      ['', '', 'Key', '', 'Amount', 'Amount'].join(separator),
      ['', '', '  key  ', '', '900719925474099312345', '+001.2300E+0002'].join(separator),
      '',
      ['', '', 'next', '', '-0.000', '"line 1\nline 2"'].join(separator),
    ].join('\r\n');
    const inspection = await inspectImport(await input(`numbers.${format}`, content));
    const sheet = inspection.sheets[0]!;
    expect(sheet).toMatchObject({ header_row: 3, start_column: 'C', data_start_row: 4, rowCount: 6 });
    expect(sheet.columns).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(sheet.cells.A1?.raw).toBe('');
    expect(sheet.cells.D4?.raw).toBe('');
    expect(sheet.cells.C4?.raw).toBe('  key  ');
    expect(sheet.cells.E4?.raw).toBe('900719925474099312345');
    expect(sheet.cells.F4?.raw).toBe('+001.2300E+0002');
    expect(sheet.cells.E6?.raw).toBe('-0.000');
    expect(sheet.cells.F6?.raw).toBe('line 1\nline 2');
    expect(inspection.issues).toEqual([expect.objectContaining({ code: 'IMPORT_DUPLICATE_HEADER', severity: 'warning', cell: 'F3' })]);
  });

  it('does not mistake a leading blank column for an absent column past Z', async () => {
    const inspection = await inspectImport(await input('wide.csv', ','.repeat(26) + 'Key\n' + ','.repeat(26) + 'value'));
    expect(inspection.sheets[0]).toMatchObject({ start_column: 'AA', header_row: 1, data_start_row: 2 });
    expect(inspection.sheets[0]?.columns.at(-1)).toBe('AA');
    expect(inspection.sheets[0]?.cells.AA2?.raw).toBe('value');
  });

  it('handles an empty file and rejects unsupported extensions and malformed quoting', async () => {
    const inspection = await inspectImport(await input('empty.csv', ''));
    expect(inspection.sheets[0]).toMatchObject({ rowCount: 0, columns: [], cells: {}, header_row: 1, start_column: 'A' });
    await expect(inspectImport(await input('input.txt', 'Key\nvalue'))).rejects.toThrow(/Unsupported import/);
    await expect(inspectImport(await input('broken.csv', 'Key\n"unclosed'))).rejects.toThrow();
  });
});

describe('XLSX raw values and metadata', () => {
  it('keeps XML numeric literals without any Number conversion and marks unsafe display candidates', async () => {
    const literals = [
      '900719925474099312345', '0.123456789012345678901234567890',
      '+001.2300E+0002', '-0.000', '1e400', '1e-400', '1.2300', '0.125',
    ];
    const bytes = workbook(sheetXml(`<sheetData>
      <row r="3"><c r="C3" t="inlineStr"><is><t>Amount</t></is></c></row>
      ${literals.map((literal, i) => `<row r="${i + 4}"><c r="C${i + 4}" t="n"><v>${literal}</v></c></row>`).join('')}
    </sheetData>`));
    const inspection = await inspectImport(await input('numbers.xlsx', bytes));
    const sheet = inspection.sheets[0]!;
    expect(sheet).toMatchObject({ header_row: 3, start_column: 'C', data_start_row: 4 });
    expect(sheet.cells.A1?.raw).toBeNull();
    expect(sheet.cells.B4?.raw).toBeNull();
    expect(literals.map((_, i) => sheet.cells[`C${i + 4}`]?.raw)).toEqual(literals);
    expect(sheet.cells.C4?.displaySafe).toBe(false);
    expect(sheet.cells.C5?.displaySafe).toBe(false);
    expect(sheet.cells.C6?.displaySafe).toBe(true);
    expect(sheet.cells.C7?.displaySafe).toBe(true);
    expect(sheet.cells.C8?.displaySafe).toBe(false);
    expect(sheet.cells.C9?.displaySafe).toBe(false);
    expect(sheet.cells.C10?.displaySafe).toBe(true);
    expect(sheet.cells.C11?.displaySafe).toBe(true);
    expect(sheet.cells.C4?.unsupported).toBeUndefined();
    expect(inspection.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_UNSAFE_DISPLAY', cell: 'C4', severity: 'warning' }));
    expect(inspection.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_DISPLAY_VALUE', cell: 'C6', message: expect.stringContaining('calculated display candidate') }));
  });

  it('offers stored and calculated formatted values, without copying metadata values into raw', async () => {
    const bytes = workbook(sheetXml(`<sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Amount</t></is></c></row>
      <row r="2"><c r="A2" s="1" t="n"><v>0.12500</v></c><c r="B2" t="b"><v>0</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">  spaced text  </t></is></c></row>
    </sheetData>`), { 'xl/styles.xml': styles });
    const inspection = await inspectImport(await input('display.xlsx', bytes));
    expect(inspection.sheets[0]?.cells.A2).toMatchObject({ raw: '0.12500', display: '12.50%', displaySafe: true });
    expect(inspection.sheets[0]?.cells.B2?.raw).toBe(false);
    expect(inspection.sheets[0]?.cells.A3?.raw).toBe('  spaced text  ');
    expect(inspection.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_DISPLAY_VALUE', cell: 'A2' }));
    expect(inspection.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_UNSUPPORTED_FORMAT' }));
  });

  it('warns about hidden rows/columns/sheets, merges, formulas, dates, errors, images and formatting', async () => {
    const bytes = workbook(sheetXml(`<cols><col min="3" max="3" hidden="1"/></cols>
      <sheetData>
        <row r="2"><c r="B2" t="inlineStr"><is><t>Key</t></is></c><c r="C2" t="inlineStr"><is><t>Key</t></is></c></row>
        <row r="3" hidden="1">
          <c r="B3" t="inlineStr"><is><t>included</t></is></c>
          <c r="C3" t="n"><f>1+1</f><v>2.00</v></c>
          <c r="D3" t="n"><f>2+2</f></c>
          <c r="E3" t="e"><f>1/0</f><v>#DIV/0!</v></c>
          <c r="F3" t="n" s="2"><v>45292</v></c>
          <c r="G3" t="d"><v>2024-01-01T00:00:00Z</v></c>
          <c r="H3" t="n" s="1"><v>0.5</v></c>
        </row>
        <row r="8"><c r="J8" t="n"><f>9+9</f></c></row>
      </sheetData><mergeCells count="1"><mergeCell ref="B4:C4"/></mergeCells>`), {
      'xl/styles.xml': styles,
      'xl/media/image1.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1sAAAAASUVORK5CYII=', 'base64'),
    });
    const inspection = await inspectImport(await input('warnings.xlsx', bytes));
    const sheet = inspection.sheets[0]!;
    expect(sheet.cells.B3?.raw).toBe('included');
    expect(sheet.cells.C3).toMatchObject({ raw: '2.00', formula: '1+1', displaySafe: true });
    for (const address of ['D3', 'E3', 'F3', 'G3', 'J8']) {
      expect(sheet.cells[address]?.unsupported, address).toEqual(expect.any(String));
      expect(sheet.cells[address]?.raw, address).toBeUndefined();
      expect(sheet.cells[address]?.displaySafe, address).toBe(false);
    }
    expect(sheet.cells.D3?.unsupported).toContain('cached formula result');
    expect(sheet.cells.J8?.unsupported).toContain('cached formula result');
    expect(sheet.cells.E3?.unsupported).toContain('Spreadsheet error');
    expect(sheet.cells.B4?.raw ?? null).toBeNull();
    expect(sheet.cells.C4?.raw ?? null).toBeNull();
    expect(sheet.rowCount).toBe(8);
    expect(sheet.columns.at(-1)).toBe('J');
    expect(inspection.sheets[1]?.cells.A2?.raw).toBe('hidden-value');
    expect(inspection.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'IMPORT_HIDDEN_ROW', 'IMPORT_HIDDEN_COLUMN', 'IMPORT_HIDDEN_SHEET', 'IMPORT_MERGED_CELLS',
      'IMPORT_FORMULA', 'IMPORT_UNSUPPORTED_CELL', 'IMPORT_IMAGES', 'IMPORT_UNSUPPORTED_FORMAT', 'IMPORT_DUPLICATE_HEADER',
    ]));
    // These inspection warnings must not stop applying a mapping which excludes
    // the unsupported coordinates (mapping/apply validates its selected cells).
    expect(inspection.issues.every(issue => issue.severity === 'warning')).toBe(true);
  });

  it('reports a sheet reader failure without claiming rounded metadata is lossless or losing other sheets', async () => {
    const bytes = workbook(sheetXml(`<sheetData><row r="1"><c r="A1" t="not-a-cell-type"><v>123</v></c></row></sheetData>`));
    const inspection = await inspectImport(await input('unsupported.xlsx', bytes));
    expect(inspection.sheets[0]?.cells.A1).toMatchObject({ unsupported: expect.stringContaining('reader failed'), displaySafe: false });
    expect(inspection.sheets[0]?.cells.A1?.raw).toBeUndefined();
    expect(inspection.sheets[1]?.cells.A2?.raw).toBe('hidden-value');
    expect(inspection.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_UNSUPPORTED_SHEET', severity: 'warning' }));
  });
});

it('reports XLSX text reader disagreements instead of silently changing escapes or CRLF', async () => {
  const values = ['line1\r\nline2', 'literal _x000d_ and _x0041_', ' padded text '];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Key', 'Text'], ...values.map((value, index) => ['k' + index, value])]), 'Data');
  const file = await input('strings.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
  const sheet = (await inspectImport(file)).sheets[0]!;
  expect(sheet.cells.B2?.unsupported).toContain('disagree');
  expect(sheet.cells.B3?.unsupported).toContain('disagree');
  expect(sheet.cells.B4?.raw).toBe(' padded text ');
});
