import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { applyImport, inspectImport, planImport } from '../src/import.js';
import { inferImportColumnType, normalizeImportInteger } from '../src/import-values.js';
import type { ImportMapping, ImportSheet } from '../src/import-types.js';
import { initProject, loadProject } from '../src/project.js';
import { inspectSource } from '../src/source.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const styles = `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts>
  <fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>
  <cellXfs count="3"><xf numFmtId="0" xfId="0"/><xf numFmtId="14" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" xfId="0" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;

// Inject raw XML: constructing JS numeric cells would round before the import.
function workbook(rows: string): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['placeholder']]), 'Data');
  const zip = XLSX.CFB.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const files = {
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    'xl/styles.xml': styles,
  };
  for (const [path, text] of Object.entries(files)) XLSX.CFB.utils.cfb_add(zip, '/' + path, Buffer.from(text));
  return XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' }) as Buffer;
}
const header = '<row r="1"><c r="A1" t="inlineStr"><is><t>Key</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row>';
function numericRows(values: string[]): string {
  return header + values.map((raw, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="n"><v>${raw}</v></c></row>`).join('');
}
async function fixture(rows: string) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-import-normalization-')); roots.push(root);
  const project = await initProject(root), file = join(root, 'source.xlsx');
  await writeFile(file, workbook(rows));
  const inspection = await inspectImport(file);
  const mapping: ImportMapping = {
    table: 'levels', schema: 'levels', sheet: 'Data', header_row: 1, data_start_row: 2,
    columns: { A: 'level' }, numeric: 'stored',
    definition: { primary_key: 'level', columns: { level: { type: 'integer' } } },
  };
  return { root, project, file, inspection, mapping };
}

describe('exact integer normalization', () => {
  it.each([
    ['1.0', '1'], ['+001', '1'], ['1e3', '1000'], ['-0.0', '0'], ['+001.2300E+0002', '123'],
    ['900719925474099312345.0', '900719925474099312345'], ['9.00719925474099312345e20', '900719925474099312345'],
    ['-123456789012345678901234567890', '-123456789012345678901234567890'],
  ])('normalizes %s exactly', (raw, value) => expect(normalizeImportInteger(raw!)).toBe(value));

  it.each(['1.25', '1e-400', '1e-9000000000000001', '1e9000000000000001', 'Infinity', 'NaN', '0xff', '1_000', '', ' 1 ', '1,000'])
    ('does not normalize non-integer or unsupported %s', raw => expect(normalizeImportInteger(raw)).toBeUndefined());

  it('normalizes integers beyond JS number range without changing Decimal settings', () => {
    expect(normalizeImportInteger('1e400')).toBe('1' + '0'.repeat(400));
  });
});

it('keeps XLSX raw and source inspect literals while tagging only numeric non-date integers', async () => {
  const f = await fixture(header + `<row r="2">
    <c r="A2" t="n"><v>1.0</v></c><c r="B2" t="inlineStr"><is><t>1.0</t></is></c>
    <c r="C2" t="n" s="1"><v>45000.0</v></c><c r="D2" t="n"><v>1.2500</v></c>
    <c r="E2" t="n"><v>900719925474099312345.0</v></c><c r="F2" t="n"><v>1e3</v></c>
    <c r="G2" t="n"><f>1+1</f><v>2.00</v></c><c r="H2" t="n"><v>-0.0</v></c>
    <c r="I2" t="n"><v>+001</v></c><c r="J2" t="b"><v>1</v></c>
    <c r="K2" t="n"><f>1+1</f></c><c r="L2" t="e"><v>#DIV/0!</v></c>
  </row>`);
  const sheet = f.inspection.sheets[0]!;
  expect(sheet.cells.A2).toMatchObject({ sourceType: 'number', raw: '1.0', normalizedInteger: '1' });
  expect(sheet.cells.B2).toMatchObject({ sourceType: 'text', raw: '1.0' });
  expect(sheet.cells.C2?.sourceType).toBe('date');
  expect(sheet.cells.D2).toMatchObject({ sourceType: 'number', raw: '1.2500' });
  expect(sheet.cells.E2).toMatchObject({ raw: '900719925474099312345.0', normalizedInteger: '900719925474099312345', displaySafe: false });
  expect(sheet.cells.F2).toMatchObject({ raw: '1e3', normalizedInteger: '1000' });
  expect(sheet.cells.G2).toMatchObject({ raw: '2.00', normalizedInteger: '2', formula: '1+1' });
  expect(sheet.cells.H2).toMatchObject({ raw: '-0.0', normalizedInteger: '0' });
  expect(sheet.cells.I2).toMatchObject({ raw: '+001', normalizedInteger: '1' });
  for (const address of ['B2', 'C2', 'D2', 'J2', 'K2', 'L2']) expect(sheet.cells[address]?.normalizedInteger, address).toBeUndefined();
  expect(f.inspection.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_FORMULA', cell: 'G2' }));
  expect(sheet.inferredTypes).toMatchObject({ A: 'integer', B: 'text', C: 'text', D: 'text', E: 'integer', F: 'integer', G: 'integer', H: 'integer', I: 'integer', J: 'text', K: 'text', L: 'text' });
  const source = await inspectSource(f.file);
  if (source.kind !== 'spreadsheet') throw new Error('Expected a spreadsheet');
  expect(source.sheets[0]?.cells.A2?.raw).toBe('1.0');
  expect(source.sheets[0]?.cells.C2?.raw).toBe('45000.0');
  expect(source.sheets[0]?.cells.E2?.raw).toBe('900719925474099312345.0');
  expect(source.sheets[0]?.cells.G2).toMatchObject({ raw: '2.00', formula: '1+1' });
});

it('infers from selected final values, exclusions, and data start without treating blank columns as integers', () => {
  const sheet: ImportSheet = {
    name: 'Data', columns: ['A', 'B'], rowCount: 5, header_row: 1, start_column: 'A', data_start_row: 2,
    cells: { A1: { raw: 'Header' }, A2: { raw: '1.0', normalizedInteger: '1', display: '1.00', displaySafe: true },
      A3: { raw: '' }, A4: { raw: '2.5', display: '3', displaySafe: true }, A5: { unsupported: 'no cache' } },
  };
  expect(inferImportColumnType(sheet, 'A')).toBe('text');
  expect(inferImportColumnType(sheet, 'A', { excludeRows: [4, 5], numeric: 'display' })).toBe('integer');
  expect(inferImportColumnType(sheet, 'A', { excludeRows: [5], representations: { A4: 'display' } })).toBe('integer');
  expect(inferImportColumnType(sheet, 'A', { dataStartRow: 3, excludeRows: [4, 5] })).toBe('text');
  expect(inferImportColumnType(sheet, 'B')).toBe('text');
  sheet.cells.A4!.displaySafe = false;
  expect(inferImportColumnType(sheet, 'A', { excludeRows: [5], numeric: 'display' })).toBe('text');
});

it('keeps delimited/text spellings and offers inference for strict integer text only', async () => {
  const f = await fixture(numericRows(['1'])), file = join(f.root, 'source.csv');
  await writeFile(file, 'Key,NumericText,DecimalText,Blank\n+001,1000,1.0,\n-0,2,-0.0,\n');
  const inspection = await inspectImport(file), sheet = inspection.sheets[0]!;
  expect(sheet.inferredTypes).toEqual({ A: 'integer', B: 'integer', C: 'text', D: 'text' });
  expect(sheet.cells.A2).toEqual({ raw: '+001' });
  const plan = planImport(f.project, inspection, { ...f.mapping, sheet: sheet.name });
  expect(plan.rows.map(row => row.values.level)).toEqual(['+001', '-0']);
  expect(plan.provenanceFile).toBeUndefined();
});

it('preserves the synthetic XLSX fixture coordinates and original key text', async () => {
  const file = fileURLToPath(new URL('./fixtures/import/items.xlsx', import.meta.url));
  const sheet = (await inspectImport(file)).sheets[0]!;
  expect(sheet).toMatchObject({ header_row: 2, data_start_row: 3, rowCount: 147 });
  expect(sheet.cells.B145).toMatchObject({ raw: 'sample_item_143', sourceType: 'text' });
  expect(sheet.inferredTypes?.B).toBe('text');
});

it('normalizes before display selection, retains declared schema, and writes deterministic full-record provenance', async () => {
  const f = await fixture(numericRows(['10.0', '2.0', '900719925474099312345.0']));
  const mapping: ImportMapping = { ...f.mapping, numeric: 'display', representations: { A2: 'display' },
    definition: { primary_key: 'level', columns: { level: { type: 'string' } } } };
  const plan = planImport(f.project, f.inspection, mapping);
  expect(plan.canApply).toBe(true);
  expect(plan.rows.map(row => row.values.level)).toEqual(['10', '2', '900719925474099312345']);
  expect(plan.mapping.definition?.columns.level?.type).toBe('string');
  expect(plan.normalizations).toEqual([
    { cell: 'A2', column: 'level', raw: '10.0', value: '10' },
    { cell: 'A3', column: 'level', raw: '2.0', value: '2' },
    { cell: 'A4', column: 'level', raw: '900719925474099312345.0', value: '900719925474099312345' },
  ]);
  expect(plan.provenanceFile).toMatch(/^imports\/[a-f0-9]{64}\.json$/);
  expect(plan.files).toContain(plan.provenanceFile);
  expect(planImport(f.project, f.inspection, mapping).provenanceFile).toBe(plan.provenanceFile);
  expect(planImport(f.project, f.inspection, { ...mapping, table: 'other' }).provenanceFile).not.toBe(plan.provenanceFile);
  expect((await loadProject(f.root)).revision).toBe(f.project.revision);
  await expect(readdir(join(f.root, 'imports'))).rejects.toMatchObject({ code: 'ENOENT' });
  const result = await applyImport(f.root, plan.revision, plan);
  expect(result.changed).toEqual(expect.arrayContaining(plan.files));
  const source = await readFile(join(f.root, plan.provenanceFile!), 'utf8');
  expect(plan.provenanceFile).toBe('imports/' + createHash('sha256').update(source).digest('hex') + '.json');
  expect(JSON.parse(source)).toEqual({ version: 1, file: f.file, sourceHash: f.inspection.sourceHash, format: 'xlsx',
    sheet: 'Data', table: 'levels', mapping, beforeRevision: f.project.revision, normalizations: plan.normalizations });
  const table = result.project.files.get('tables/levels.yaml')!.data as { rows: { level: string }[] };
  expect(table.rows.map(row => row.level)).toEqual(['10', '2', '900719925474099312345']);
  const loaded = await loadProject(f.root);
  expect(loaded.sources.get(plan.provenanceFile!)).toBe(source);
  expect(loaded.revision).toBe(result.project.revision);
});

it('creates no provenance for unchanged literals or excluded cells', async () => {
  const f = await fixture(numericRows(['1', '2.0']));
  const plan = planImport(f.project, f.inspection, { ...f.mapping, exclude_rows: [3] });
  expect(plan.canApply).toBe(true);
  expect(plan.normalizations).toBeUndefined();
  expect(plan.provenanceFile).toBeUndefined();
  expect(plan.files).toEqual(['schemas/levels.yaml', 'tables/levels.yaml']);
});

it('applies cached integer results without evaluation while retaining decimal and text spelling', async () => {
  const f = await fixture(header + `<row r="2">
    <c r="A2" t="n"><v>1.0</v></c><c r="B2" t="n"><f>99+99</f><v>2.00</v></c>
    <c r="C2" t="n"><v>1.2500</v></c><c r="D2" t="inlineStr"><is><t>1.0</t></is></c>
  </row>`);
  const mapping: ImportMapping = { ...f.mapping, columns: { A: 'level', B: 'cached', C: 'decimal', D: 'text' },
    definition: { primary_key: 'level', columns: { level: { type: 'integer' }, cached: { type: 'integer' },
      decimal: { type: 'decimal' }, text: { type: 'text' } } } };
  const plan = planImport(f.project, f.inspection, mapping);
  expect(plan.canApply).toBe(true);
  expect(plan.diagnostics).toEqual([]);
  expect(plan.rows[0]?.values).toEqual({ level: '1', cached: '2', decimal: '1.2500', text: '1.0' });
  expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_FORMULA', cell: 'B2' }));
  expect(plan.normalizations?.map(item => item.cell)).toEqual(['A2', 'B2']);
  // Mapping insertion order cannot change the provenance content hash.
  expect(planImport(f.project, f.inspection, { ...mapping, columns: { D: 'text', C: 'decimal', B: 'cached', A: 'level' } }).provenanceFile).toBe(plan.provenanceFile);
  const result = await applyImport(f.root, plan.revision, plan);
  expect((result.project.files.get('tables/levels.yaml')!.data as { rows: unknown[] }).rows).toEqual([plan.rows[0]?.values]);
});

it('blocks keys that collide after normalization and refuses to overwrite existing normalized keys', async () => {
  const f = await fixture(numericRows(['1.0', '+001']));
  const duplicate = planImport(f.project, f.inspection, f.mapping);
  expect(duplicate.canApply).toBe(false);
  expect(duplicate.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_KEY_DUPLICATE', cell: 'A3' }));
  await expect(applyImport(f.root, duplicate.revision, duplicate)).rejects.toMatchObject({ code: 'IMPORT_BLOCKED' });
  expect((await loadProject(f.root)).revision).toBe(f.project.revision);
  const first = planImport(f.project, f.inspection, { ...f.mapping, exclude_rows: [3] });
  const imported = await applyImport(f.root, first.revision, first);
  await writeFile(f.file, workbook(numericRows(['1e0'])));
  const next = planImport(imported.project, await inspectImport(f.file), f.mapping);
  expect(next.canApply).toBe(false);
  expect(next.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_KEY_DUPLICATE', cell: 'A2' }));
  await writeFile(f.file, workbook(numericRows(['2.0', '10.0'])));
  const append = planImport(imported.project, await inspectImport(f.file), f.mapping);
  const result = await applyImport(f.root, append.revision, append);
  expect((result.project.files.get('tables/levels.yaml')!.data as { rows: { level: string }[] }).rows.map(row => row.level)).toEqual(['1', '2', '10']);
  expect(result.changed).toContain(append.provenanceFile);
});
