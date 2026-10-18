import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectSpreadsheetSource } from '../src/source-spreadsheet.js';

const roots: string[] = [];
async function input(name: string, content: string | Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibe-source-spreadsheet-'));
  roots.push(root);
  const file = join(root, name);
  await writeFile(file, content);
  return file;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships';
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const worksheet = (body: string) => xml(`<worksheet xmlns="${main}" xmlns:r="${rels}">${body}</worksheet>`);
const relationships = (body: string) => xml(`<Relationships xmlns="${packageRels}">${body}</Relationships>`);
const relationship = (id: string, type: string, target: string, mode = '') =>
  `<Relationship Id="${id}" Type="${rels}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`;

// Values enter the ZIP as XML text, never as numeric inputs to a workbook writer.
function workbook(body: string, extra: Record<string, string | Uint8Array> = {}): Uint8Array {
  const files = {
    '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/hidden.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': relationships(relationship('book', 'officeDocument', 'xl/workbook.xml')),
    'xl/workbook.xml': xml(`<workbook xmlns="${main}" xmlns:r="${rels}"><sheets><sheet name="원문" sheetId="1" r:id="first"/><sheet name="숨김" sheetId="2" state="veryHidden" r:id="hidden"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': relationships([
      relationship('first', 'worksheet', 'worksheets/sheet1.xml'),
      relationship('hidden', 'worksheet', '/xl/worksheets/hidden.xml'),
      ...(extra['xl/styles.xml'] ? [relationship('styles', 'styles', 'styles.xml')] : []),
      ...(extra['xl/sharedStrings.xml'] ? [relationship('strings', 'sharedStrings', 'sharedStrings.xml')] : []),
    ].join('')),
    'xl/worksheets/sheet1.xml': worksheet(body),
    'xl/worksheets/hidden.xml': worksheet('<sheetData><row r="2"><c r="B2" t="inlineStr"><is><t> 숨김 원문 </t></is></c></row></sheetData>'),
    ...extra,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, typeof value === 'string' ? strToU8(value) : value])));
}

const styles = xml(`<styleSheet xmlns="${main}">
  <numFmts count="2"><numFmt numFmtId="164" formatCode=" 0.0000 &quot;개&quot; "/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss.000"/></numFmts>
  <cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>
  <cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="165"/></cellXfs>
</styleSheet>`);

describe('delimited source inspection', () => {
  it.each(['csv', 'tsv'] as const)('preserves %s strings, blank coordinates and quoting without inferring types or headers', async format => {
    const separator = format === 'csv' ? ',' : '\t';
    const bytes = '\uFEFF\r\n\r\n' + [
      ['', 'Key', 'Key', 'Amount'].join(separator),
      ['', '  한글  ', 'true', '+001.2300E+0002'].join(separator),
      '',
      ['', '900719925474099312345', '-0.000', '"line 1\r\nline ""2"""'].join(separator),
    ].join('\r\n');
    const file = await input(`source.${format}`, bytes);
    const source = await inspectSpreadsheetSource(relative(process.cwd(), file));
    expect(source).toMatchObject({ kind: 'spreadsheet', format, file, issues: [] });
    expect(source.sourceHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    const sheet = source.sheets[0]!;
    expect(sheet).toMatchObject({ name: 'source', rowCount: 6, columns: ['A', 'B', 'C', 'D'], merges: [] });
    expect(sheet.cells.A1).toEqual({ raw: '', type: 'string' });
    expect(sheet.cells.B4).toEqual({ raw: '  한글  ', type: 'string' });
    expect(sheet.cells.C4).toEqual({ raw: 'true', type: 'string' });
    expect(sheet.cells.D4?.raw).toBe('+001.2300E+0002');
    expect(sheet.cells.A5?.raw).toBe('');
    expect(sheet.cells.B5).toBeUndefined();
    expect(sheet.cells.B6?.raw).toBe('900719925474099312345');
    expect(sheet.cells.C6?.raw).toBe('-0.000');
    expect(sheet.cells.D6?.raw).toBe('line 1\r\nline "2"');
    expect(sheet).not.toHaveProperty('header_row');
    expect(sheet).not.toHaveProperty('start_column');
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });

  it('retains columns past Z and empty files without synthesizing rows', async () => {
    const wide = await inspectSpreadsheetSource(await input('wide.csv', ','.repeat(26) + '  001  '));
    expect(wide.sheets[0]?.columns.at(-1)).toBe('AA');
    expect(wide.sheets[0]?.cells.AA1?.raw).toBe('  001  ');
    const empty = await inspectSpreadsheetSource(await input('empty.csv', ''));
    expect(empty.sheets).toEqual([{ name: 'empty', rowCount: 0, columns: [], cells: {}, merges: [] }]);
  });

  it('rejects malformed CSV, unsupported extensions and invalid UTF-8', async () => {
    await expect(inspectSpreadsheetSource(await input('bad.csv', '"unclosed'))).rejects.toThrow();
    await expect(inspectSpreadsheetSource(await input('bad.csv', new Uint8Array([0xff])))).rejects.toThrow(/UTF-8/);
    await expect(inspectSpreadsheetSource(await input('bad.xls', ''))).rejects.toThrow(/Unsupported source/);
  });
});

describe('XLSX source literals', () => {
  it('retains every numeric literal, date storage and format code without display calculation', async () => {
    const values = ['900719925474099312345', '0.123456789012345678901234567890', '+001.2300E+0002', '-0.000', '1e400', '1e-400', '1.2300'];
    const bytes = workbook(`<sheetData>
      ${values.map((value, i) => `<row r="${i + 3}"><c r="C${i + 3}" s="1"><v>${value}</v></c></row>`).join('')}
      <row r="20"><c r="B20" s="2"><v>45292.1234567890123456789</v></c><c r="C20" s="3"><v>00001.5000</v></c><c r="D20" t="d"><v>2024-01-01T00:00:00.000Z</v></c><c r="E20" t="b"><v>0</v></c><c r="F20" t="b"><v>1</v></c><c r="G20" t="e"><v>#DIV/0!</v></c></row>
    </sheetData>`, { 'xl/styles.xml': styles });
    const file = await input('numbers.XLSX', bytes);
    const source = await inspectSpreadsheetSource(file);
    expect(source.sourceHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(source.issues).toEqual([]);
    const sheet = source.sheets[0]!;
    expect(sheet.rowCount).toBe(20);
    expect(sheet.columns).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    values.forEach((value, i) => expect(sheet.cells[`C${i + 3}`]).toEqual({ raw: value, type: 'n', numberFormat: ' 0.0000 "개" ' }));
    expect(sheet.cells.B20).toEqual({ raw: '45292.1234567890123456789', type: 'n', numberFormat: 'm/d/yy' });
    expect(sheet.cells.C20).toEqual({ raw: '00001.5000', type: 'n', numberFormat: 'yyyy-mm-dd hh:mm:ss.000' });
    expect(sheet.cells.D20?.raw).toBe('2024-01-01T00:00:00.000Z');
    expect(sheet.cells.D20?.type).toBe('d');
    expect(sheet.cells.E20?.raw).toBe('0');
    expect(sheet.cells.F20?.raw).toBe('1');
    expect(sheet.cells.E20?.type).toBe('b');
    expect(sheet.cells.G20?.raw).toBe('#DIV/0!');
    expect(sheet.cells.A1).toBeUndefined();
    expect(await readFile(file)).toEqual(Buffer.from(bytes));
  });

  it('keeps absent caches null and preserves shared formula attributes without expanding or evaluating formulas', async () => {
    const source = await inspectSpreadsheetSource(await input('formulas.xlsx', workbook(`<sheetData><row r="3">
      <c r="B3"><f t="shared" si="0007" ref="B3:C3" ca="1"> SUM(A1:A2) &amp; "한글" </f><v>900719925474099312345</v></c>
      <c r="C3"><f t="shared" si="0007"/></c><c r="D3"><f>1+1</f></c>
      <c r="E3" t="str"><f>""</f><v/></c><c r="F3"/><c r="G3"><v/></c>
    </row></sheetData>`)));
    const cells = source.sheets[0]!.cells;
    expect(cells.B3).toEqual({ raw: '900719925474099312345', type: 'n', formula: ' SUM(A1:A2) & "한글" ', formulaAttributes: { t: 'shared', si: '0007', ref: 'B3:C3', ca: '1' } });
    expect(cells.C3).toEqual({ raw: null, type: 'n', formula: '', formulaAttributes: { t: 'shared', si: '0007' } });
    expect(cells.D3).toEqual({ raw: null, type: 'n', formula: '1+1', formulaAttributes: {} });
    expect(cells.E3).toEqual({ raw: '', type: 'str', formula: '""', formulaAttributes: {} });
    expect(cells.F3).toEqual({ raw: null, type: 'n' });
    expect(cells.G3).toEqual({ raw: '', type: 'n' });
  });

  it('decodes XML entities once, preserves Korean/whitespace and leaves SpreadsheetML escapes literal', async () => {
    const shared = xml(`<sst xmlns="${main}" count="3" uniqueCount="3">
      <si><t xml:space="preserve">  한글 &amp; &lt;태그&gt; &quot;말&quot; &apos;글&apos; &#xD55C;&#44544; &#13;\n_x000d_ _x0041_ _x005F_x0041_ &amp;lt;  </t></si>
      <si><r><rPr><b/></rPr><t xml:space="preserve"> 앞 </t></r><r><t>뒤</t></r><rPh sb="0" eb="1"><t>읽기 제외</t></rPh></si><si><t/></si>
    </sst>`);
    const source = await inspectSpreadsheetSource(await input('strings.xlsx', workbook(`<sheetData><row r="1">
      <c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c>
      <c r="D1" t="inlineStr"><is><t xml:space="preserve">  인라인 &amp; &#13;\n_x000A_  </t></is></c>
      <c r="E1" t="inlineStr"><is><r><t>하나 </t></r><r><t>둘</t></r></is></c>
      <c r="F1" t="str"><f>"_x0041_"</f><v>_x0041_</v></c>
      <c r="G1" t="inlineStr"><is><t>_x123_ _xGGGG_ ordinary</t></is></c>
    </row></sheetData>`, { 'xl/sharedStrings.xml': shared })));
    expect(source.issues).toEqual(['A1', 'D1', 'F1'].map(address =>
      `원문!${address}: SpreadsheetML escape text is preserved literally; interpretation is deferred (no decoding).`));
    expect(source.sheets[0]?.cells.A1).toEqual({ raw: '  한글 & <태그> "말" \'글\' 한글 \r\n_x000d_ _x0041_ _x005F_x0041_ &lt;  ', type: 's' });
    expect(source.sheets[0]?.cells.B1?.raw).toBe(' 앞 뒤');
    expect(source.sheets[0]?.cells.C1?.raw).toBe('');
    expect(source.sheets[0]?.cells.D1).toEqual({ raw: '  인라인 & \r\n_x000A_  ', type: 'inlineStr' });
    expect(source.sheets[0]?.cells.E1?.raw).toBe('하나 둘');
    expect(source.sheets[0]?.cells.F1?.raw).toBe('_x0041_');
    expect(source.sheets[0]?.cells.G1?.raw).toBe('_x123_ _xGGGG_ ordinary');
  });

  it.each(['image', 'drawing', 'both'] as const)('reports omitted %s parts once and requires retaining the source ZIP', async kind => {
    const extra: Record<string, string | Uint8Array> = {};
    if (kind !== 'drawing') extra['xl/media/image1.png'] = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1sAAAAASUVORK5CYII=', 'base64');
    if (kind !== 'image') extra['xl/drawings/drawing1.xml'] = xml('<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>');
    const bytes = workbook('<sheetData><row r="1"><c r="A1"><v>001.00</v></c></row></sheetData>', extra);
    const file = await input('assets.xlsx', bytes);
    const source = await inspectSpreadsheetSource(file);
    expect(source.issues).toEqual(['XLSX images or drawings are not included in the cell JSON; retain the original XLSX ZIP.']);
    expect(source.sheets[0]?.cells.A1).toEqual({ raw: '001.00', type: 'n' });
    expect(await readFile(file)).toEqual(Buffer.from(bytes));
  });

  it('retains merge ranges, hidden sheets and actual hyperlink targets and locations', async () => {
    const source = await inspectSpreadsheetSource(await input('metadata.xlsx', workbook(`<dimension ref="B2:F9"/><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>링크 표시</t></is></c></row></sheetData>
      <mergeCells count="1"><mergeCell ref="B2:D2"/></mergeCells>
      <hyperlinks><hyperlink ref="B2" r:id="external" location="section A" display="Not the URL"/><hyperlink ref="E4:F4" location="'숨김'!B2"/><hyperlink ref="D8" r:id="relative"/></hyperlinks>`, {
      'xl/worksheets/_rels/sheet1.xml.rels': relationships(relationship('external', 'hyperlink', 'https://example.test/한글?q=1&amp;x=2', 'External') + relationship('relative', 'hyperlink', '../document.xlsx#Sheet1!A1', 'External')),
    })));
    const sheet = source.sheets[0]!;
    expect(sheet).toMatchObject({ hidden: false, rowCount: 9, columns: ['A', 'B', 'C', 'D', 'E', 'F'], merges: ['B2:D2'] });
    expect(sheet.cells.B2).toEqual({ raw: '링크 표시', type: 'inlineStr', hyperlink: { target: 'https://example.test/한글?q=1&x=2', location: 'section A' } });
    expect(sheet.cells.C2).toBeUndefined();
    expect(sheet.cells.D2).toBeUndefined();
    expect(sheet.cells.E4).toEqual({ raw: null, type: 'blank', hyperlink: { location: "'숨김'!B2" } });
    expect(sheet.cells.F4?.hyperlink).toEqual({ location: "'숨김'!B2" });
    expect(sheet.cells.D8?.hyperlink).toEqual({ target: '../document.xlsx#Sheet1!A1' });
    expect(source.sheets[1]).toMatchObject({ name: '숨김', hidden: true, cells: { B2: { raw: ' 숨김 원문 ', type: 'inlineStr' } } });
  });

  it('follows package relationships for nonstandard part names and namespace prefixes', async () => {
    const bytes = zipSync(Object.fromEntries(Object.entries({
      '_rels/.rels': relationships(relationship('book', 'officeDocument', '/custom/book.xml')),
      'custom/book.xml': xml(`<s:workbook xmlns:s="${main}" xmlns:r="${rels}"><s:sheets><s:sheet name="별도" sheetId="1" r:id="sheet"/></s:sheets></s:workbook>`),
      'custom/_rels/book.xml.rels': relationships(relationship('sheet', 'worksheet', '../data/my%20sheet.xml')),
      'data/my sheet.xml': xml(`<s:worksheet xmlns:s="${main}"><s:sheetData><s:row r="3"><s:c r="AA3"><s:v>001.00</s:v></s:c><s:c><s:v>002.00</s:v></s:c></s:row><s:row><s:c><s:v>003.00</s:v></s:c></s:row></s:sheetData></s:worksheet>`),
    }).map(([path, text]) => [path, strToU8(text)])));
    const source = await inspectSpreadsheetSource(await input('paths.xlsx', bytes));
    expect(source.sheets[0]).toMatchObject({ name: '별도', rowCount: 4, cells: { AA3: { raw: '001.00', type: 'n' }, AB3: { raw: '002.00', type: 'n' }, A4: { raw: '003.00', type: 'n' } } });
    expect(source.sheets[0]?.columns.at(-1)).toBe('AB');
  });

  it('reports unavailable strings, styles, hyperlinks and XML newline normalization', async () => {
    const source = await inspectSpreadsheetSource(await input('missing.xlsx', workbook('<sheetData><row r="1"><c r="A1" t="s"><v>123</v></c><c r="B1" s="17"><v>12.00</v></c><c r="C1" t="inlineStr"><is><t>line1\r\nline2</t></is></c></row></sheetData><hyperlinks><hyperlink ref="A1" r:id="missing"/></hyperlinks>')));
    expect(source.sheets[0]?.cells.A1?.raw).toBeNull();
    expect(source.sheets[0]?.cells.B1?.raw).toBe('12.00');
    expect(source.sheets[0]?.cells.C1?.raw).toBe('line1\nline2');
    expect(source.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('Missing or invalid shared string'),
      expect.stringContaining('Missing or invalid cell style'),
      expect.stringContaining('Missing hyperlink relationship'),
      expect.stringContaining('XML line endings are normalized'),
    ]));
  });

  it('rejects invalid ZIP, missing parts and malformed XML without returning a false successful inspection', async () => {
    await expect(inspectSpreadsheetSource(await input('bad.xlsx', 'not a ZIP'))).rejects.toThrow();
    await expect(inspectSpreadsheetSource(await input('empty.xlsx', zipSync({})))).rejects.toThrow(/Missing XLSX part/);
    await expect(inspectSpreadsheetSource(await input('xml.xlsx', workbook('<sheetData>')))).rejects.toThrow();
  });
});
