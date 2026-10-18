import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyEdits, loadProject, readPath, renameResource, validateProject, whereUsed,
} from '../src/index.js';
import type { EditOperation, Project, TableSchema } from '../src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/project/', import.meta.url));
const roots: string[] = [];
async function project(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-writes-'));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  for (const [path, content] of Object.entries(overrides)) await writeFile(join(root, path), content);
  return loadProject(root);
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const source = (kind: 'schemas' | 'tables', name: string) =>
  readFile(join(fixture, kind, name + '.yaml'), 'utf8');
const update = (table: string, key: string, values: Record<string, string | boolean | null>): EditOperation =>
  ({ op: 'update', table, key, values });
async function expectUnchanged(p: Project) {
  expect((await loadProject(p.root)).sources).toEqual(p.sources);
  expect(await readdir(p.root)).not.toContain('.vibe-spec.lock');
}

describe('row edits and batches', () => {
  it('changes one cell through apply with a one-line Git diff and untouched other files', async () => {
    const p = await project();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: p.root, encoding: 'utf8' });
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    const result = await applyEdits(p.root, p.revision, [update('items', 'currency_gold', { name: '금화' })]);
    expect(result.changed).toEqual(['tables/items.yaml']);
    expect(result.diagnostics).toEqual([]);
    expect(result.project.revision).not.toBe(p.revision);
    expect(result.project.sources.get('tables/items.yaml'))
      .toBe(p.sources.get('tables/items.yaml')!.replace('name: "골드"', 'name: "금화"'));
    for (const [file, text] of p.sources) {
      if (file !== 'tables/items.yaml') expect(result.project.sources.get(file)).toBe(text);
    }
    expect(git('diff', '--numstat').trim()).toBe('1\t1\ttables/items.yaml');
  });

  it('keeps numeric strings, escaped line breaks, booleans and nullable cells intact after reload', async () => {
    const p = await project();
    const numeric = '+00012.340000E-002';
    const result = await applyEdits(p.root, p.revision, [
      update('offers', 'bundle', { price: numeric, count: '900719925474099312345678901', available: false, currency: null }),
      update('items', 'currency_gold', { note: 'first\nsecond' }),
    ]);
    const reloaded = await loadProject(p.root);
    expect(result.diagnostics).toEqual([]);
    expect(readPath(reloaded, 'offers/bundle')).toMatchObject({
      price: numeric, count: '900719925474099312345678901', available: false, currency: null,
    });
    expect(reloaded.sources.get('tables/items.yaml')).toContain('note: "first\\nsecond"');
    expect(readPath(reloaded, 'items/currency_gold/note')).toEqual({ value: 'first\nsecond', present: true });
  });

  it('keeps comments and other values while writing an edited CRLF source with LF endings', async () => {
    const original = (await source('tables', 'items'))
      .replace('name: "골드"', 'name: \'골드\' # reviewer note')
      .replaceAll('\n', '\r\n');
    const p = await project({ 'tables/items.yaml': original });
    const result = await applyEdits(p.root, p.revision, [update('items', 'currency_gold', { name: '금화' })]);
    expect(result.project.sources.get('tables/items.yaml')).toBe(original.replace("'골드'", '"금화"').replaceAll('\r\n', '\n'));
    expect(result.planned.sources).toEqual(result.project.sources);
  });

  it('fills an absent optional cell by adding only its field line', async () => {
    const original = (await source('tables', 'items')).replace('    note: "001"\n', '');
    const p = await project({ 'tables/items.yaml': original });
    const result = await applyEdits(p.root, p.revision, [update('items', 'currency_gold', { note: 'new note' })]);
    expect(result.project.sources.get('tables/items.yaml')).toBe(original + '    note: "new note"\n');
    expect(result.diagnostics).toEqual([]);
  });

  it('does not rewrite bytes or change the revision for a no-op update', async () => {
    const p = await project();
    const result = await applyEdits(p.root, p.revision, [update('offers', 'bundle', { price: '+001.2300E+0002' })]);
    expect(result.changed).toEqual([]);
    expect(result.project.revision).toBe(p.revision);
    await expectUnchanged(p);
  });

  it('appends a row without sorting and deletes an unreferenced row', async () => {
    const p = await project();
    const result = await applyEdits(p.root, p.revision, [
      { op: 'create', table: 'items', row: { code: 'aaa', name: '새 아이템', kind: 'consumable' } },
      { op: 'delete', table: 'items', key: 'consumable_potion' },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(readPath(result.project, 'items/*/code')).toEqual([
      { key: 'currency_gold', value: 'currency_gold', present: true },
      { key: 'aaa', value: 'aaa', present: true },
    ]);
    expect(readPath(result.project, 'items/aaa/name')).toEqual({ value: '새 아이템', present: true });
  });

  it('creates rows in an empty table and checks references after the complete batch', async () => {
    const p = await project({ 'tables/items.yaml': 'schema: items\nrows: []\n' });
    const result = await applyEdits(p.root, p.revision, [
      update('offers', 'bundle', { currency: 'new_key' }),
      { op: 'create', table: 'items', row: { code: 'new_key', name: '새 이름' } },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(readPath(result.project, 'items/new_key/name')).toEqual({ value: '새 이름', present: true });
  });

  it('applies enum and range errors and returns diagnostics instead of adding a validation gate', async () => {
    const p = await project();
    const result = await applyEdits(p.root, p.revision, [
      update('items', 'currency_gold', { kind: 'future_kind' }),
      update('offers', 'bundle', { price: '-1.000' }),
    ]);
    expect(result.changed.sort()).toEqual(['tables/items.yaml', 'tables/offers.yaml']);
    expect(result.diagnostics).toEqual(validateProject(result.project));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'items/currency_gold/kind' }),
      expect.objectContaining({ path: 'offers/bundle/price' }),
    ]));
    expect(readPath(await loadProject(p.root), 'offers/bundle/price')).toEqual({ value: '-1.000', present: true });
  });

  it.each([
    { op: 'create', table: 'items', row: { code: 'currency_gold', name: 'duplicate' } },
    { op: 'create', table: 'items', row: { name: 'missing key' } },
    { op: 'create', table: 'items', row: { code: '', name: 'empty key' } },
    { op: 'create', table: 'items', row: { code: 'bad/key', name: 'slash' } },
    { op: 'create', table: 'items', row: { code: '*', name: 'reserved' } },
    { op: 'update', table: 'items', key: 'currency_gold', values: { code: 'different' } },
    { op: 'update', table: 'items', key: 'absent', values: { name: 'missing' } },
  ] satisfies EditOperation[])('refuses invalid or ambiguous edit requests without partially applying prior operations: %j', async operation => {
    const p = await project();
    await expect(applyEdits(p.root, p.revision, [update('items', 'currency_gold', { name: 'must not persist' }), operation]))
      .rejects.toThrow();
    await expectUnchanged(p);
  });

  it('refuses numeric JSON values so no write can accidentally use a floating-point value', async () => {
    const p = await project();
    const malformed = { op: 'update', table: 'offers', key: 'bundle', values: { price: 0.1 } };
    await expect(applyEdits(p.root, p.revision, [malformed as unknown as EditOperation])).rejects.toThrow();
    await expectUnchanged(p);
  });

  it('refuses to select a row with an already duplicated Key', async () => {
    const original = await source('tables', 'items');
    const p = await project({ 'tables/items.yaml': original.replace('"consumable_potion"', '"currency_gold"') });
    await expect(applyEdits(p.root, p.revision, [update('items', 'currency_gold', { name: 'ambiguous' })])).rejects.toThrow();
    await expectUnchanged(p);
  });

  it('rejects an outdated revision and preserves the other local writer’s bytes', async () => {
    const p = await project();
    const editedByOtherWriter = p.sources.get('tables/items.yaml')!.replace('name: "골드"', 'name: "다른 프로세스"');
    await writeFile(join(p.root, 'tables/items.yaml'), editedByOtherWriter);
    await expect(applyEdits(p.root, p.revision, [update('items', 'currency_gold', { name: 'old view' })]))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(await readFile(join(p.root, 'tables/items.yaml'), 'utf8')).toBe(editedByOtherWriter);
    expect(await readdir(p.root)).not.toContain('.vibe-spec.lock');
  });
});

describe('declared deletion protection', () => {
  it('blocks deleting a restrict target and applies none of the batch', async () => {
    const p = await project();
    await expect(applyEdits(p.root, p.revision, [
      update('items', 'consumable_potion', { name: 'must not persist' }),
      { op: 'delete', table: 'items', key: 'currency_gold' },
    ])).rejects.toMatchObject({ diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'DELETE_RESTRICTED', path: 'offers/bundle/currency' }),
    ]) });
    await expectUnchanged(p);
  });

  it('keeps a declared restrict guard active when an unrelated column in the source schema is invalid', async () => {
    const p = await project({
      'schemas/offers.yaml': (await source('schemas', 'offers')).replace('    type: boolean', '    type: enum'),
    });
    expect(validateProject(p).map(diagnostic => diagnostic.code)).toContain('SCHEMA_RULE');
    await expect(applyEdits(p.root, p.revision, [{ op: 'delete', table: 'items', key: 'currency_gold' }]))
      .rejects.toMatchObject({ diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'DELETE_RESTRICTED', path: 'offers/bundle/currency' }),
      ]) });
    await expectUnchanged(p);
  });

  it.each(['before', 'after'])('allows removal when a surviving ref is changed %s the delete in the same batch', async order => {
    const p = await project();
    const remove: EditOperation = { op: 'delete', table: 'items', key: 'currency_gold' };
    const retarget = update('offers', 'bundle', { currency: 'consumable_potion' });
    const result = await applyEdits(p.root, p.revision, order === 'before' ? [retarget, remove] : [remove, retarget]);
    expect(result.diagnostics).toEqual([]);
    expect(() => readPath(result.project, 'items/currency_gold')).toThrow();
    expect(readPath(result.project, 'offers/bundle/currency')).toEqual({ value: 'consumable_potion', present: true });
  });

  it('allows deleting a target and the referencing row in the same batch', async () => {
    const p = await project();
    const result = await applyEdits(p.root, p.revision, [
      { op: 'delete', table: 'items', key: 'currency_gold' },
      { op: 'delete', table: 'offers', key: 'bundle' },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(() => readPath(result.project, 'offers/bundle')).toThrow();
  });

  it('allows deleting a self-reference together with its own row', async () => {
    const p = await project({
      'schemas/nodes.yaml': 'primary_key: key\ncolumns:\n  key:\n    type: string\n  parent:\n    type: ref\n    table: nodes\n    on_delete: restrict\n',
      'tables/nodes.yaml': 'schema: nodes\nrows:\n  - key: "self"\n    parent: "self"\n',
    });
    const result = await applyEdits(p.root, p.revision, [{ op: 'delete', table: 'nodes', key: 'self' }]);
    expect(result.diagnostics).toEqual([]);
    expect(readPath(result.project, 'nodes/*/key')).toEqual([]);
  });

  it('applies unprotected deletion and reports the remaining broken ref', async () => {
    const p = await project({
      'schemas/offers.yaml': (await source('schemas', 'offers')).replace('    on_delete: restrict\n', ''),
    });
    const result = await applyEdits(p.root, p.revision, [{ op: 'delete', table: 'items', key: 'currency_gold' }]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'REF_MISSING', path: 'offers/bundle/currency' }));
    expect(() => readPath(result.project, 'items/currency_gold')).toThrow();
    expect(readPath(result.project, 'offers/bundle/currency')).toEqual({ value: 'currency_gold', present: true });
  });
});

describe('name-based lookup and rename', () => {
  it('returns structured references separately from free-text occurrences without writing', async () => {
    const p = await project({
      'tables/items.yaml': (await source('tables', 'items')).replace('note: "001"', 'note: "Use currency_gold; currency_gold_bonus is also a text candidate."'),
    });
    const usages = await whereUsed(p, 'items/currency_gold');
    expect(usages.references).toContainEqual(expect.objectContaining({ file: 'tables/offers.yaml', path: 'offers/bundle/currency' }));
    expect(usages.candidates).toContainEqual(expect.objectContaining({ file: 'tables/items.yaml', path: 'items/currency_gold/note' }));
    for (const hit of [...usages.references, ...usages.candidates]) {
      expect(hit.line).toBeGreaterThan(0);
      expect(hit.text).toContain('currency_gold');
    }
    await expectUnchanged(p);
  });

  it('finds plain Markdown mentions inside the planning repository as candidates and leaves them intact', async () => {
    const text = '# Review\nPlease check currency_gold before approval.\n';
    const p = await project({ 'review.md': text });
    const usages = await whereUsed(p, 'items/currency_gold');
    expect(usages.candidates).toContainEqual(expect.objectContaining({
      file: 'review.md', line: 2, text: 'Please check currency_gold before approval.',
    }));
    const result = await renameResource(p.root, p.revision, 'key', 'items/currency_gold', 'currency_coin');
    expect(result.candidates).toContainEqual(expect.objectContaining({ file: 'review.md', line: 2 }));
    expect(await readFile(join(p.root, 'review.md'), 'utf8')).toBe(text);
  });

  it('finds declared table references without confusing another table with the same Key names', async () => {
    const p = await project({
      'tables/other-items.yaml': await source('tables', 'items'),
      'schemas/other-offers.yaml': (await source('schemas', 'offers')).replace('table: items', 'table: other-items'),
      'tables/other-offers.yaml': (await source('tables', 'offers')).replace('schema: offers', 'schema: other-offers'),
    });
    const tableUsages = await whereUsed(p, 'items');
    expect(tableUsages.references).toContainEqual(expect.objectContaining({ file: 'schemas/offers.yaml' }));
    expect(tableUsages.references).not.toContainEqual(expect.objectContaining({ file: 'schemas/other-offers.yaml' }));
    const rowUsages = await whereUsed(p, 'items/currency_gold');
    expect(rowUsages.references.map(hit => hit.path)).toEqual(['offers/bundle/currency']);
    const result = await renameResource(p.root, p.revision, 'key', 'items/currency_gold', 'coin');
    expect(readPath(result.project, 'offers/bundle/currency')).toEqual({ value: 'coin', present: true });
    expect(readPath(result.project, 'other-offers/bundle/currency')).toEqual({ value: 'currency_gold', present: true });
  });

  it('finds ref declarations in schemas not yet used by any table', async () => {
    const p = await project({
      'schemas/unused.yaml': 'primary_key: code\ncolumns:\n  code:\n    type: string\n  reward:\n    type: ref\n    table: items\n',
    });
    const usages = await whereUsed(p, 'items');
    expect(usages.references).toContainEqual(expect.objectContaining({
      file: 'schemas/unused.yaml', path: 'columns/reward/table',
    }));
  });

  it('renames every declared ref even when an unrelated referencing table has duplicate Keys', async () => {
    const p = await project({
      'tables/offers.yaml': (await source('tables', 'offers'))
        .replace('sku: "starter"', 'sku: "bundle"')
        .replace('currency: null', 'currency: "currency_gold"'),
    });
    const result = await renameResource(p.root, p.revision, 'key', 'items/currency_gold', 'coin');
    expect(readPath(result.project, 'offers/*/currency')).toEqual([
      { key: 'bundle', value: 'coin', present: true },
      { key: 'bundle', value: 'coin', present: true },
    ]);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('KEY_DUPLICATE');
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).not.toContain('REF_MISSING');
  });

  it('renames a declared ref despite an unrelated error in its source schema', async () => {
    const p = await project({
      'schemas/offers.yaml': (await source('schemas', 'offers')).replace('    type: boolean', '    type: enum'),
    });
    const result = await renameResource(p.root, p.revision, 'key', 'items/currency_gold', 'coin');
    expect(result.project.sources.get('tables/offers.yaml'))
      .toBe(p.sources.get('tables/offers.yaml')!.replace('currency: "currency_gold"', 'currency: "coin"'));
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('SCHEMA_RULE');
  });

  it('renames a Key and declared refs without changing row order or free text', async () => {
    const p = await project({
      'tables/items.yaml': (await source('tables', 'items')).replace('note: "001"', 'note: "See currency_gold for the reward."'),
      'tables/other-items.yaml': await source('tables', 'items'),
    });
    const result = await renameResource(p.root, p.revision, 'key', 'items/currency_gold', 'aaa_coin');
    expect(result.diagnostics).toEqual([]);
    expect(readPath(result.project, 'items/aaa_coin')).toMatchObject({ code: 'aaa_coin', note: 'See currency_gold for the reward.' });
    expect(readPath(result.project, 'offers/bundle/currency')).toEqual({ value: 'aaa_coin', present: true });
    expect(readPath(result.project, 'other-items/currency_gold/name')).toEqual({ value: '골드', present: true });
    expect(() => readPath(result.project, 'items/currency_gold')).toThrow();
    expect(result.candidates).toContainEqual(expect.objectContaining({ file: 'tables/items.yaml', text: expect.stringContaining('currency_gold') }));
    expect(readPath(result.project, 'items/*/code')).toEqual([
      { key: 'consumable_potion', value: 'consumable_potion', present: true },
      { key: 'aaa_coin', value: 'aaa_coin', present: true },
    ]);
  });

  it('renames a table file and ref target declarations while keeping its schema name and ref Key values', async () => {
    const p = await project();
    const result = await renameResource(p.root, p.revision, 'table', 'items', 'catalog');
    expect(result.diagnostics).toEqual([]);
    expect(await readdir(join(p.root, 'tables'))).toEqual(expect.arrayContaining(['catalog.yaml', 'offers.yaml']));
    expect(await readdir(join(p.root, 'tables'))).not.toContain('items.yaml');
    expect(result.project.sources.get('tables/catalog.yaml')).toBe(p.sources.get('tables/items.yaml'));
    expect(result.project.sources.get('schemas/items.yaml')).toBe(p.sources.get('schemas/items.yaml'));
    expect(readPath(result.project, 'catalog')).toHaveProperty('table.schema', 'items');
    expect(readPath(result.project, 'offers')).toHaveProperty('schema.columns.currency.table', 'catalog');
    expect(readPath(result.project, 'offers/bundle/currency')).toEqual({ value: 'currency_gold', present: true });
    expect(() => readPath(result.project, 'items')).toThrow();
  });

  it('renames a column throughout a shared schema, all its tables, and declared unique tuples', async () => {
    const p = await project({
      'schemas/items.yaml': await source('schemas', 'items') + 'unique:\n  - [name, kind]\n',
      'tables/other-items.yaml': await source('tables', 'items'),
    });
    const result = await renameResource(p.root, p.revision, 'column', 'items/*/name', 'source');
    expect(result.diagnostics).toEqual([]);
    const schema = result.project.files.get('schemas/items.yaml')!.data as TableSchema;
    expect(schema.columns.source).toMatchObject({ type: 'text', required: true });
    expect(schema.columns).not.toHaveProperty('name');
    expect(schema.unique).toEqual([['source', 'kind']]);
    expect(readPath(result.project, 'items/currency_gold/source')).toEqual({ value: '골드', present: true });
    expect(readPath(result.project, 'other-items/currency_gold/source')).toEqual({ value: '골드', present: true });
    expect(readPath(result.project, 'items/currency_gold')).not.toHaveProperty('name');
  });

  it('renames the Key column code and primary_key declaration without renaming Key values or labels', async () => {
    const p = await project({ 'tables/other-items.yaml': await source('tables', 'items') });
    const result = await renameResource(p.root, p.revision, 'column', 'items/*/code', 'key');
    expect(result.diagnostics).toEqual([]);
    const schema = result.project.files.get('schemas/items.yaml')!.data as TableSchema;
    expect(schema.primary_key).toBe('key');
    expect(schema.columns.key?.label).toBe('코드');
    expect(readPath(result.project, 'items/currency_gold')).toHaveProperty('key', 'currency_gold');
    expect(readPath(result.project, 'other-items/currency_gold')).toHaveProperty('key', 'currency_gold');
    expect(readPath(result.project, 'offers/bundle/currency')).toEqual({ value: 'currency_gold', present: true });
  });

  it.each([
    ['key', 'items/currency_gold', 'consumable_potion'],
    ['key', 'items/currency_gold', 'bad/key'],
    ['key', 'items/currency_gold', '*'],
    ['key', 'items', 'new_key'],
    ['table', 'items', 'offers'],
    ['column', 'items/*/name', 'kind'],
    ['column', 'items/currency_gold/name', 'source'],
  ] as const)('refuses conflicting or invalid rename %s %s → %s', async (kind, path, to) => {
    const p = await project();
    await expect(renameResource(p.root, p.revision, kind, path, to)).rejects.toThrow();
    await expectUnchanged(p);
  });

  it('requires a current revision for rename and leaves all files in the newer state', async () => {
    const p = await project();
    const changed = await applyEdits(p.root, p.revision, [update('items', 'currency_gold', { name: 'newer' })]);
    await expect(renameResource(p.root, p.revision, 'key', 'items/currency_gold', 'coin'))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expectUnchanged(changed.project);
  });
});
