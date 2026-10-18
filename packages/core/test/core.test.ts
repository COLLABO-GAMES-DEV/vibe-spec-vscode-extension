import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deletionDiagnostics, formattedSources, formatYaml, loadProject, parseYaml,
  readPath, resolveReference, serializeYaml, updateCell, validateProject, writeChanges,
} from '../src/index.js';
import type { TableSchema } from '../src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/project/', import.meta.url));
const roots: string[] = [];
async function project(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-core-'));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  for (const [path, content] of Object.entries(overrides)) await writeFile(join(root, path), content);
  return loadProject(root);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const schemaText = (name: string) => readFile(join(fixture, 'schemas', name + '.yaml'), 'utf8');
const tableText = (name: string) => readFile(join(fixture, 'tables', name + '.yaml'), 'utf8');
const codes = (p: Awaited<ReturnType<typeof project>>) => validateProject(p).map(d => d.code);

it('resolves a reference using the declared table and its configured Key column', async () => {
  const p = await project();
  expect(resolveReference(p, 'offers', 'bundle', 'currency')).toEqual({
    table: 'items', key: 'currency_gold', column: 'code',
  });
  expect(() => resolveReference(p, 'offers', 'starter', 'currency')).toThrow(/target Key/);
  expect(() => resolveReference(p, 'offers', 'bundle', 'price')).toThrow(/not a reference/);
  const broken = await project({ 'tables/offers.yaml': (await tableText('offers'))
    .replace('currency: "currency_gold"', 'currency: "missing"') });
  expect(() => resolveReference(broken, 'offers', 'bundle', 'currency')).toThrow();
});

describe('lossless YAML and writes', () => {
  it('round-trips schema/table bytes including comments, quote styles and final newline choices', async () => {
    const p = await project();
    for (const file of p.files.values()) expect(serializeYaml(parseYaml(file.source))).toBe(file.source);
    const unusual = '\uFEFFschema: items\r\nrows: [] # comment\r\n';
    expect(serializeYaml(parseYaml(unusual))).toBe(unusual);
    const noNewline = 'primary_key: code\ncolumns: {code: {type: string}}';
    expect(serializeYaml(parseYaml(noNewline))).toBe(noNewline);
    expect(await writeChanges(p, p.sources)).toEqual([]);
    expect((await loadProject(p.root)).revision).toBe(p.revision);
  });

  it('never coerces numeric literals to JS numbers, even before a style diagnostic', async () => {
    const raw = 'value: 90071992547409931234567890\nsmall: 0.00000000000000000000000001\n';
    expect(parseYaml(raw).data).toEqual({
      value: '90071992547409931234567890', small: '0.00000000000000000000000001',
    });
    const p = await project({ 'tables/offers.yaml': (await tableText('offers')).replace('"+001.2300E+0002"', '900719925474099312345') });
    expect(codes(p)).toContain('STRING_STYLE');
    expect(readPath(p, 'offers/bundle/price')).toEqual({ value: '900719925474099312345', present: true });
  });

  it('fmt quotes cells, preserves row order and is byte-idempotent', async () => {
    const p = await project();
    const schema = p.files.get('schemas/items.yaml')!.data as TableSchema;
    const input = parseYaml('schema: items\nrows:\n - code: z\n   name: Z\n - code: a\n   name: A\n');
    const once = formatYaml(input, schema);
    expect(once.source.indexOf('"z"')).toBeLessThan(once.source.indexOf('"a"'));
    expect(formatYaml(once, schema).source).toBe(once.source);
    await writeChanges(p, formattedSources(p));
    const second = await loadProject(p.root);
    expect(await writeChanges(second, formattedSources(second))).toEqual([]);
    expect(codes(second)).toEqual([]);
    expect(readPath(second, 'offers/bundle/count')).toEqual({ value: '900719925474099312345', present: true });
    expect(readPath(second, 'offers/bundle/price')).toEqual({ value: '+001.2300E+0002', present: true });
    expect(readPath(second, 'offers/starter/price')).toEqual({ value: '-0.000', present: true });
  });

  it('changes exactly one line in an actual git diff and preserves neighboring bytes', async () => {
    let p = await project();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: p.root, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'core.autocrlf', 'true');
    // Match init's LF contract even when the host Git configuration uses CRLF.
    await writeFile(join(p.root, '.gitattributes'), '* text=auto eol=lf\n');
    p = await loadProject(p.root);
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    const file = p.files.get('tables/items.yaml')!;
    const schema = p.files.get('schemas/items.yaml')!.data as TableSchema;
    const edited = updateCell(file, schema, 'currency_gold', 'name', '금화\n기본');
    expect(edited.source).toBe(file.source.replace('name: "골드"', 'name: "금화\\n기본"'));
    await writeChanges(p, new Map([[file.file, serializeYaml(edited)]]));
    expect(git('diff', '--numstat').trim()).toBe('1\t1\ttables/items.yaml');
    expect(codes(await loadProject(p.root))).toEqual([]);
  });

  it('preserves an inline comment when replacing a scalar', async () => {
    const p = await project();
    const schema = p.files.get('schemas/items.yaml')!.data as TableSchema;
    const original = parseYaml('schema: items\nrows:\n  - code: "x"\n    name: "old" # retain\n');
    expect(updateCell(original, schema, 'x', 'name', 'new').source)
      .toBe(original.source.replace('"old"', '"new"'));
  });

  it('preserves the supplied numeric spelling through a cell edit and disk reload', async () => {
    const p = await project();
    const file = p.files.get('tables/offers.yaml')!;
    const schema = p.files.get('schemas/offers.yaml')!.data as TableSchema;
    const value = '+00012.340000E-002';
    const edited = updateCell(file, schema, 'bundle', 'price', value);
    expect(edited.source).toBe(file.source.replace('"+001.2300E+0002"', '"' + value + '"'));
    expect(updateCell(edited, schema, 'bundle', 'price', value).source).toBe(edited.source);
    await writeChanges(p, new Map([[file.file, serializeYaml(edited)]]));
    const reloaded = await loadProject(p.root);
    expect(readPath(reloaded, 'offers/bundle/price')).toEqual({ value, present: true });
    expect(codes(reloaded)).toEqual([]);
  });

  it('formats flow rows and multiline cells as one field per physical line', async () => {
    const p = await project();
    const schema = p.files.get('schemas/items.yaml')!.data as TableSchema;
    const input = parseYaml('schema: items\nrows: [{code: "x", name: "hello\\nworld"}]\n');
    const formatted = formatYaml(input, schema);
    expect(formatted.source).toContain('  - code: "x"\n    name: "hello\\nworld"\n');
    expect(formatYaml(formatted, schema).source).toBe(formatted.source);
    const multiline = await project({
      'tables/items.yaml': 'schema: items\nrows:\n  - code: "x"\n    name: "hello\n      world"\n',
    });
    expect(codes(multiline)).toContain('STRING_STYLE');
  });

  it('refuses stale revisions and leaves the external edit untouched', async () => {
    const p = await project();
    const path = 'tables/items.yaml';
    await writeFile(join(p.root, path), p.sources.get(path)! + '\n');
    await expect(writeChanges(p, new Map([[path, p.sources.get(path)!.replace('골드', '금화')]])))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(await readFile(join(p.root, path), 'utf8')).toBe(p.sources.get(path)! + '\n');
    expect(await readdir(p.root)).not.toContain('.vibe-spec.lock');
  });

  it('does not remove another writer’s lock or overwrite an existing temporary file', async () => {
    const p = await project();
    const path = 'tables/items.yaml';
    const changes = new Map([[path, p.sources.get(path)!.replace('골드', '금화')]]);
    await writeFile(join(p.root, '.vibe-spec.lock'), 'other writer');
    await expect(writeChanges(p, changes)).rejects.toMatchObject({ code: 'PROJECT_LOCKED' });
    expect(await readFile(join(p.root, '.vibe-spec.lock'), 'utf8')).toBe('other writer');
    await rm(join(p.root, '.vibe-spec.lock'));
    await writeFile(join(p.root, path + '.vibe-tmp'), 'existing');
    await expect(writeChanges(p, changes)).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(await readFile(join(p.root, path), 'utf8')).toBe(p.sources.get(path));
    expect(await readFile(join(p.root, path + '.vibe-tmp'), 'utf8')).toBe('existing');
    expect(await readdir(p.root)).not.toContain('.vibe-spec.lock');
  });

  it('reports partial writes and recovers tracked files with Git after a later file fails', async () => {
    let p = await project();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: p.root, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'core.autocrlf', 'true');
    // Match init's LF contract even when the host Git configuration uses CRLF.
    await writeFile(join(p.root, '.gitattributes'), '* text=auto eol=lf\n');
    p = await loadProject(p.root);
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    const first = 'tables/items.yaml';
    const second = 'tables/offers.yaml';
    await writeFile(join(p.root, second + '.vibe-tmp'), 'other writer');
    await expect(writeChanges(p, new Map([
      [first, p.sources.get(first)!.replace('골드', '금화')],
      [second, p.sources.get(second)! + '\n'],
    ]))).rejects.toMatchObject({ code: 'WRITE_FAILED', message: expect.stringContaining('already replaced: tables/items.yaml') });
    expect(await readFile(join(p.root, first), 'utf8')).toContain('금화');
    expect(await readFile(join(p.root, second), 'utf8')).toBe(p.sources.get(second));
    expect(await readdir(p.root)).not.toContain('.vibe-spec.lock');
    git('restore', '--source=HEAD', '--', 'tables');
    expect(git('diff')).toBe('');
    expect((await loadProject(p.root)).revision).toBe(p.revision);
  });
});

describe('schema, values and references', () => {
  it('validates the fixture without imposing domain columns or prefix rules', async () => {
    expect(codes(await project())).toEqual([]);
  });
  it.each([
    ['multiple Key columns', 'primary_key: [code, name]', 'SCHEMA_SHAPE'],
    ['missing Key declaration', 'primary_key: absent', 'SCHEMA_RULE'],
  ])('%s is diagnosed', async (_name, primary, code) => {
    const p = await project({ 'schemas/items.yaml': (await schemaText('items')).replace('primary_key: code', primary) });
    expect(codes(p)).toContain(code);
  });
  it.each(['""', 'null', '"a/b"', '"*"'])('rejects invalid Key %s', async value => {
    const p = await project({ 'tables/items.yaml': (await tableText('items')).replace('"currency_gold"', value) });
    expect(codes(p)).toContain('KEY_REQUIRED');
  });
  it('reports missing and duplicate Keys', async () => {
    const original = await tableText('items');
    expect(codes(await project({ 'tables/items.yaml': original.replace('  - code: "currency_gold"\n    name:', '  - name:') })))
      .toContain('KEY_REQUIRED');
    expect(codes(await project({ 'tables/items.yaml': original.replace('"currency_gold"', '"consumable_potion"') })))
      .toContain('KEY_DUPLICATE');
  });
  it.each([
    ['kind: "currency"', 'kind: "unknown"'],
    ['name: "골드"', 'name: null'],
    ['name: "골드"', 'name: true'],
    ['name: "골드"', 'wrong: "골드"'],
  ])('validates enum/type/required/declared columns: %s', async (from, to) => {
    const p = await project({ 'tables/items.yaml': (await tableText('items')).replace(from, to) });
    expect(validateProject(p).length).toBeGreaterThan(0);
  });
  it.each(['"items/currency_gold"', '"absent"'])('ref cells contain a target Key, not %s', async value => {
    const p = await project({ 'tables/offers.yaml': (await tableText('offers')).replace('"currency_gold"', value) });
    expect(codes(p)).toContain('REF_MISSING');
  });
  it('validates reference target declarations even for empty tables', async () => {
    const p = await project({
      'schemas/offers.yaml': (await schemaText('offers')).replace('table: items', 'table: missing'),
      'tables/offers.yaml': 'schema: offers\nrows: []\n',
    });
    expect(codes(p)).toContain('REF_TABLE_MISSING');
  });
  it('compares arbitrary precision ranges without rounding at a close boundary', async () => {
    const p = await project({
      'schemas/offers.yaml': (await schemaText('offers')).replace('maximum: "99999999999999999999999999"', 'maximum: "1.0000000000000000000000000000000000001"'),
      'tables/offers.yaml': (await tableText('offers')).replace('"+001.2300E+0002"', '"1.0000000000000000000000000000000000002"'),
    });
    expect(validateProject(p)).toContainEqual(expect.objectContaining({ path: 'offers/bundle/price', message: 'Value is above maximum.' }));
  });
  it.each(['"1.5"', 'true', '"NaN"'])('validates integer type %s', async value => {
    const p = await project({ 'tables/offers.yaml': (await tableText('offers')).replace('"900719925474099312345"', value) });
    expect(codes(p)).toContain('VALUE_TYPE_OR_RANGE');
  });
  it('uses numeric equality for declared uniqueness, retaining original spellings', async () => {
    const p = await project({ 'tables/offers.yaml': (await tableText('offers')).replace('"+001.2300E+0002"', '"0.0"') });
    expect(codes(p)).toContain('UNIQUE_VIOLATION');
    expect(readPath(p, 'offers/bundle/price')).toEqual({ value: '0.0', present: true });
  });
  it('checks composite uniqueness only when declared', async () => {
    const schema = await schemaText('items') + 'unique:\n  - [name, kind]\n';
    const table = (await tableText('items')).replace('"골드"', '"회복약"');
    expect(codes(await project({ 'schemas/items.yaml': schema, 'tables/items.yaml': table }))).toEqual([]);
    expect(codes(await project({
      'schemas/items.yaml': schema, 'tables/items.yaml': table.replace('kind: "currency"', 'kind: "consumable"'),
    }))).toContain('UNIQUE_VIOLATION');
  });
  it('diagnoses unsupported decimal comparison instead of silently underflowing', async () => {
    const p = await project({
      'tables/offers.yaml': (await tableText('offers')).replace('"+001.2300E+0002"', '"1e-9007199254740992"'),
    });
    expect(codes(p)).toContain('VALUE_TYPE_OR_RANGE');
    expect(readPath(p, 'offers/bundle/price')).toEqual({ value: '1e-9007199254740992', present: true });
  });
  it('diagnoses invalid schema declarations and missing schemas', async () => {
    const p = await project({
      'schemas/bad.yaml': 'primary_key: k\ncolumns:\n  k:\n    type: string\n    nullable: true\n  e:\n    type: enum\nunique:\n  - [missing]\n',
      'tables/missing.yaml': 'schema: nowhere\nrows: []\n',
    });
    expect(codes(p)).toContain('SCHEMA_RULE');
    expect(codes(p)).toContain('SCHEMA_MISSING');
  });
  it('allows self-references removed together with the target row', async () => {
    const p = await project({
      'schemas/nodes.yaml': 'primary_key: key\ncolumns:\n  key:\n    type: string\n  parent:\n    type: ref\n    table: nodes\n    on_delete: restrict\n',
      'tables/nodes.yaml': 'schema: nodes\nrows:\n  - key: "self"\n    parent: "self"\n',
    });
    expect(codes(p)).toEqual([]);
    expect(deletionDiagnostics(p, 'nodes', 'self')).toEqual([]);
  });
  it('reads and validates a 5,000-row reference fixture', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      '  - code: "' + String(i).padStart(5, '0') + '"\n    parent: "' + String(i).padStart(5, '0') + '"\n').join('');
    const p = await project({
      'schemas/large.yaml': 'primary_key: code\ncolumns:\n  code:\n    type: string\n  parent:\n    type: ref\n    table: large\n',
      'tables/large.yaml': 'schema: large\nrows:\n' + rows,
    });
    expect(codes(p)).toEqual([]);
    expect(readPath(p, 'large/*/parent')).toHaveLength(5000);
  });
  it('keeps string Keys 1 and 1.0 distinct and ignores null in an optional unique tuple', async () => {
    const p = await project({
      'schemas/plain.yaml': 'primary_key: name\ncolumns:\n  name:\n    type: string\n  value:\n    type: text\n    nullable: true\nunique:\n  - [value]\n',
      'tables/plain.yaml': 'schema: plain\nrows:\n  - name: "1"\n    value: null\n  - name: "1.0"\n',
    });
    expect(codes(p)).toEqual([]);
  });
  it('requires deletion protection only when a surviving ref declares restrict', async () => {
    const p = await project();
    expect(deletionDiagnostics(p, 'items', 'currency_gold')).toEqual([
      expect.objectContaining({ code: 'DELETE_RESTRICTED', path: 'offers/bundle/currency' }),
    ]);
    expect(deletionDiagnostics(p, 'items', 'consumable_potion')).toEqual([]);
    const permissive = await project({ 'schemas/offers.yaml': (await schemaText('offers')).replace('    on_delete: restrict\n', '') });
    expect(deletionDiagnostics(permissive, 'items', 'currency_gold')).toEqual([]);
    const deleted = (await tableText('items')).split('  - code: "currency_gold"')[0]!;
    await writeFile(join(permissive.root, 'tables/items.yaml'), deleted);
    expect(codes(await loadProject(permissive.root))).toContain('REF_MISSING');
  });
  it.each(['x: 1\nx: 2\n', 'x: &a "a"\ny: *a\n', 'x: !custom "a"\n', '? [a, b]\n: c\n'])('reports invalid/unsupported YAML without expanding it', text => {
    expect(() => parseYaml(text)).toThrow();
  });
  it('reads table, row, column and cell paths using codes rather than labels', async () => {
    const p = await project();
    expect(readPath(p, 'items')).toHaveProperty('schema.primary_key', 'code');
    expect(readPath(p, 'items/currency_gold')).toHaveProperty('name', '골드');
    expect(readPath(p, 'offers/*/currency')).toEqual([
      { key: 'bundle', value: 'currency_gold', present: true },
      { key: 'starter', value: null, present: true },
    ]);
    expect(() => readPath(p, 'items/currency_gold/코드')).toThrow();
    expect(() => readPath(p, 'items/*')).toThrow();
    expect(() => readPath(p, 'items/missing/name')).toThrow();
    expect(() => readPath(p, 'items/a/name/extra')).toThrow();
  });
});
