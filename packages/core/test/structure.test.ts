import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isMap, isScalar } from 'yaml';
import { applyStructureEdit, editProject, inspectStructure } from '../src/structure.js';
import { loadProject, readPath } from '../src/project.js';
import type { Project, TableSchema } from '../src/types.js';
import type { StructureOperation } from '../src/structure-types.js';

const roots: string[] = [];
const source = (folder: string, name: string) => readFile(new URL('./fixtures/project/' + folder + '/' + name + '.yaml', import.meta.url), 'utf8');
async function fixture(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-structure-'));
  roots.push(root);
  await cp(fileURLToPath(new URL('./fixtures/project/', import.meta.url)), root, { recursive: true });
  for (const [file, text] of Object.entries(extra)) await writeFile(join(root, file), text);
  return loadProject(root);
}
const schema = (project: Project, name = 'items') => project.files.get('schemas/' + name + '.yaml')!.data as TableSchema;
const order = (project: Project, name = 'items') => {
  const columns = project.files.get('schemas/' + name + '.yaml')!.document.get('columns', true);
  return isMap(columns) ? columns.items.map(pair => isScalar(pair.key) ? pair.key.value : undefined) : [];
};
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('column structure edits', () => {
  it('previews and refuses Key deletion without writing', async () => {
    const project = await fixture();
    const operation: StructureOperation = { op: 'column-delete', table: 'items', column: 'code' };
    const preview = await inspectStructure(project, operation);
    expect(preview.blocked).toMatch(/Key/);
    expect(preview.usages.references).toContainEqual(expect.objectContaining({ file: 'schemas/items.yaml', path: 'primary_key' }));
    await expect(applyStructureEdit(project.root, project.revision, operation)).rejects.toMatchObject({ code: 'KEY_COLUMN_REQUIRED' });
    expect((await loadProject(project.root)).revision).toBe(project.revision);
  });

  it('adds a required column to the shared schema only and reports missing values', async () => {
    const project = await fixture({ 'tables/other.yaml': await source('tables', 'items') });
    const operation: StructureOperation = { op: 'column-add', table: 'items', column: 'rank_2',
      definition: { type: 'integer', label: 'Rank', required: true }, position: { anchor: 'name', side: 'after' } };
    const preview = await inspectStructure(project, operation);
    expect(preview).toMatchObject({ revision: project.revision, tables: ['items', 'other'], files: ['schemas/items.yaml'] });
    expect(preview.blocked).toBeUndefined();
    expect((await loadProject(project.root)).revision).toBe(project.revision);
    const result = await applyStructureEdit(project.root, project.revision, operation);
    expect(result.changed).toEqual(['schemas/items.yaml']);
    expect(order(result.project)).toEqual(['code', 'name', 'rank_2', 'kind', 'note']);
    expect(result.diagnostics.filter(item => item.code === 'VALUE_REQUIRED')).toHaveLength(4);
    for (const table of ['items', 'other']) expect(result.project.sources.get('tables/' + table + '.yaml')).toBe(project.sources.get('tables/' + table + '.yaml'));
  });

  it('keeps all data bytes through required, label and type changes and cleans obsolete type options', async () => {
    let project = await fixture();
    const rows = project.sources.get('tables/items.yaml');
    for (const changes of [{ type: 'integer' as const, label: 'Number', required: true }, { type: 'text' as const, required: false }]) {
      const result = await applyStructureEdit(project.root, project.revision, { op: 'column-update', table: 'items', column: 'kind', changes });
      expect(result.changed).toEqual(['schemas/items.yaml']);
      expect(result.project.sources.get('tables/items.yaml')).toBe(rows);
      expect(schema(result.project).columns.kind).toEqual(changes.type === 'integer'
        ? { type: 'integer', label: 'Number', required: true } : { type: 'text', label: 'Number', required: false });
      if (changes.type === 'integer') expect(result.diagnostics.filter(item => item.code === 'VALUE_TYPE_OR_RANGE')).toHaveLength(2);
      project = result.project;
    }
  });

  it('moves only the schema mapping, preserving row bytes and avoiding no-op rewrites', async () => {
    const rows = (await source('tables', 'items')).replaceAll('\n', '\r\n');
    const project = await fixture({ 'tables/items.yaml': rows });
    const operation: StructureOperation = { op: 'column-move', table: 'items', column: 'note', position: { anchor: 'code', side: 'before' } };
    const result = await applyStructureEdit(project.root, project.revision, operation);
    expect(order(result.project)).toEqual(['note', 'code', 'name', 'kind']);
    expect(result.project.sources.get('tables/items.yaml')).toBe(rows);
    expect(result.changed).toEqual(['schemas/items.yaml']);
    expect((await applyStructureEdit(project.root, result.project.revision, operation)).changed).toEqual([]);
  });

  it('keeps numeric-only column codes in the requested YAML mapping order', async () => {
    const project = await fixture();
    const added = await applyStructureEdit(project.root, project.revision, {
      op: 'column-add', table: 'items', column: '123', definition: { type: 'text' }, position: { anchor: 'name', side: 'after' },
    });
    expect(order(added.project)).toEqual(['code', 'name', '123', 'kind', 'note']);
    const moved = await applyStructureEdit(project.root, added.project.revision, {
      op: 'column-move', table: 'items', column: '123', position: { anchor: 'note', side: 'after' },
    });
    expect(order(moved.project)).toEqual(['code', 'name', 'kind', 'note', '123']);
    expect(moved.project.sources.get('tables/items.yaml')).toBe(project.sources.get('tables/items.yaml'));
  });

  it('reports newly required missing cells without filling them or blocking the schema update', async () => {
    const rows = (await source('tables', 'items')).replace('    note: "001"\n', '');
    const project = await fixture({ 'tables/items.yaml': rows });
    const result = await applyStructureEdit(project.root, project.revision, {
      op: 'column-update', table: 'items', column: 'note', changes: { required: true },
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'VALUE_REQUIRED', path: 'items/currency_gold/note' }));
    expect(result.project.sources.get('tables/items.yaml')).toBe(rows);
  });

  it('deletes values throughout a shared schema and removes complete unique tuples that include the column', async () => {
    const project = await fixture({
      'tables/other.yaml': await source('tables', 'items'),
      'schemas/items.yaml': await source('schemas', 'items') + 'unique:\n  - [name, kind]\n  - [name]\n  - [kind]\n',
      'notes.md': 'The name column is being removed.\n',
    });
    const operation: StructureOperation = { op: 'column-delete', table: 'items', column: 'name' };
    const preview = await inspectStructure(project, operation);
    expect(preview.tables).toEqual(['items', 'other']);
    expect(preview.files).toEqual(['schemas/items.yaml', 'tables/items.yaml', 'tables/other.yaml']);
    expect(preview.usages.references).toContainEqual(expect.objectContaining({ path: 'unique/0/0' }));
    expect(preview.usages.candidates).toContainEqual(expect.objectContaining({ file: 'notes.md' }));
    const result = await applyStructureEdit(project.root, project.revision, operation);
    expect(schema(result.project).unique).toEqual([['kind']]);
    expect(schema(result.project).columns).not.toHaveProperty('name');
    for (const table of ['items', 'other']) {
      expect(readPath(result.project, table + '/currency_gold')).not.toHaveProperty('name');
      expect(readPath(result.project, table + '/currency_gold')).toMatchObject({ code: 'currency_gold', kind: 'currency', note: '001' });
    }
    expect(result.diagnostics).toEqual([]);
    expect(result.candidates).toEqual(preview.usages.candidates);
  });

  it('accepts existing uppercase column codes while enforcing lowercase codes for new columns', async () => {
    const project = await fixture({
      'schemas/items.yaml': (await source('schemas', 'items')).replaceAll('code', 'Key').replace('  name:', '  Source:'),
      'tables/items.yaml': (await source('tables', 'items')).replaceAll('code:', 'Key:').replaceAll('name:', 'Source:'),
    });
    const result = await applyStructureEdit(project.root, project.revision, { op: 'column-update', table: 'items', column: 'Source', changes: { label: 'Displayed' } });
    expect(schema(result.project).columns.Source?.label).toBe('Displayed');
    await expect(applyStructureEdit(project.root, result.project.revision, { op: 'column-add', table: 'items', column: 'NewCode', definition: { type: 'text' } }))
      .rejects.toMatchObject({ code: 'INVALID_COLUMN_CODE' });
  });

  it.each([
    { op: 'column-add', table: 'items', column: 'name', definition: { type: 'text' } },
    { op: 'column-add', table: 'items', column: 'enum', definition: { type: 'enum' } },
    { op: 'column-update', table: 'items', column: 'code', changes: { required: false } },
    { op: 'column-update', table: 'items', column: 'name', changes: { type: 'decimal', minimum: 1 } },
    { op: 'column-update', table: 'items', column: 'name', changes: { label: 12 } },
    { op: 'column-update', table: 'items', column: 'name', changes: { unexpected: true } },
    { op: 'column-move', table: 'items', column: 'name', position: { anchor: 'missing', side: 'after' } },
  ])('rejects malformed schema edits without writing: %j', async input => {
    const project = await fixture();
    const preview = await inspectStructure(project, input as StructureOperation);
    expect(preview.blocked).toBeTruthy();
    await expect(editProject(project.root, project.revision, input)).rejects.toThrow();
    expect((await loadProject(project.root)).revision).toBe(project.revision);
  });
});

describe('table lifecycle', () => {
  it('creates just an empty table and its Key schema, selecting an unused readable schema suffix', async () => {
    const project = await fixture({ 'schemas/new.yaml': 'broken: [\n', 'schemas/new_2.yaml': 'reserved: true\n' });
    const operation: StructureOperation = { op: 'table-create', table: 'new', key: { code: 'key_1', label: 'Primary / Key' } };
    const preview = await inspectStructure(project, operation);
    expect(preview.files).toEqual(['schemas/new_3.yaml', 'tables/new.yaml']);
    const result = await editProject(project.root, project.revision, operation);
    expect(readPath(result.project, 'new')).toEqual({ schema: { primary_key: 'key_1', columns: { key_1: { type: 'string', label: 'Primary / Key' } } }, table: { schema: 'new_3', rows: [] } });
    expect(result.project.sources.get('schemas/new.yaml')).toBe(project.sources.get('schemas/new.yaml'));
    expect(result.project.sources.get('schemas/new_2.yaml')).toBe(project.sources.get('schemas/new_2.yaml'));
  });

  it.each([
    { op: 'table-create', table: 'broken', key: { code: 'key', label: 'Key' } },
    { op: 'table-create', table: 'items', key: { code: 'key', label: 'Key' } },
    { op: 'table-create', table: 'bad/name', key: { code: 'key', label: 'Key' } },
    { op: 'table-create', table: '', key: { code: 'key', label: 'Key' } },
    { op: 'table-create', table: 'new', key: { code: 'Key', label: 'Key' } },
  ])('rejects colliding files, invalid names and uppercase new Key codes: %j', async input => {
    const project = await fixture({ 'tables/broken.yaml': 'rows: [\n' });
    expect((await inspectStructure(project, input as StructureOperation)).blocked).toBeTruthy();
    await expect(editProject(project.root, project.revision, input)).rejects.toThrow();
    expect((await loadProject(project.root)).revision).toBe(project.revision);
  });

  it('blocks table deletion from another table ref declaration even with no rows and no restrict', async () => {
    const project = await fixture({
      'tables/offers.yaml': 'schema: offers\nrows: []\n',
      'schemas/offers.yaml': (await source('schemas', 'offers')).replace('    on_delete: restrict\n', ''),
    });
    const operation: StructureOperation = { op: 'table-delete', table: 'items' };
    const preview = await inspectStructure(project, operation);
    expect(preview.blocked).toContain('offers/*/currency');
    expect(preview.usages.references).toContainEqual(expect.objectContaining({ file: 'schemas/offers.yaml', path: 'columns/currency/table' }));
    await expect(applyStructureEdit(project.root, project.revision, operation)).rejects.toMatchObject({ code: 'DELETE_RESTRICTED' });
    expect((await loadProject(project.root)).revision).toBe(project.revision);
  });

  it('protects declarations even if an unrelated part of the referencing schema is invalid', async () => {
    const project = await fixture({ 'schemas/offers.yaml': (await source('schemas', 'offers')).replace('type: boolean', 'type: enum') });
    const preview = await inspectStructure(project, { op: 'table-delete', table: 'items' });
    expect(preview.blocked).toBeTruthy();
    expect(preview.usages.references).toContainEqual(expect.objectContaining({ file: 'schemas/offers.yaml', path: 'columns/currency/table' }));
  });

  it('deletes a table containing self references and cycles with its exclusive schema', async () => {
    const project = await fixture({
      'schemas/nodes.yaml': 'primary_key: key\ncolumns:\n  key:\n    type: string\n  parent:\n    type: ref\n    table: nodes\n    on_delete: restrict\n',
      'tables/nodes.yaml': 'schema: nodes\nrows:\n  - key: "a"\n    parent: "b"\n  - key: "b"\n    parent: "a"\n  - key: "self"\n    parent: "self"\n',
    });
    const operation: StructureOperation = { op: 'table-delete', table: 'nodes' };
    expect(await inspectStructure(project, operation)).toMatchObject({ files: ['schemas/nodes.yaml', 'tables/nodes.yaml'], tables: ['nodes'] });
    const result = await applyStructureEdit(project.root, project.revision, operation);
    expect(result.project.sources.has('schemas/nodes.yaml')).toBe(false);
    expect(result.project.sources.has('tables/nodes.yaml')).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it('blocks cycles between distinct tables and retains a schema used by a surviving table', async () => {
    const project = await fixture({
      'schemas/items.yaml': await source('schemas', 'items') + '  offer:\n    type: ref\n    table: offers\n',
      'tables/other.yaml': await source('tables', 'items'),
    });
    for (const table of ['items', 'offers']) expect((await inspectStructure(project, { op: 'table-delete', table })).blocked).toBeTruthy();
    const operation: StructureOperation = { op: 'table-delete', table: 'other' };
    expect((await inspectStructure(project, operation)).files).toEqual(['tables/other.yaml']);
    const result = await applyStructureEdit(project.root, project.revision, operation);
    expect(result.changed).toEqual(['tables/other.yaml']);
    expect(result.project.sources.get('schemas/items.yaml')).toBe(project.sources.get('schemas/items.yaml'));
  });
});

it('routes a single row edit through the core validator, rejects arrays, and requires the current revision', async () => {
  let project = await fixture();
  const initial = project;
  project = (await editProject(project.root, project.revision, { op: 'update', table: 'items', key: 'currency_gold', values: { note: 'changed' } })).project;
  await expect(editProject(project.root, project.revision, [{ op: 'create', table: 'items', row: { code: 'new' } }]))
    .rejects.toMatchObject({ code: 'INVALID_EDIT' });
  expect(readPath(project, 'items/currency_gold/note')).toHaveProperty('value', 'changed');
  await expect(editProject(project.root, project.revision, { op: 'update', table: 'items', key: 'currency_gold', values: { note: 1 } })).rejects.toMatchObject({ code: 'INVALID_EDIT' });
  await expect(editProject(project.root, initial.revision, { op: 'column-delete', table: 'items', column: 'note' })).rejects.toMatchObject({ code: 'STALE_REVISION' });
});
