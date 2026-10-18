import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEdits, renameResource } from '../src/editing.js';
import { applyImport, planImport } from '../src/import.js';
import { inspectImport } from '../src/import-reader.js';
import type { ImportMapping } from '../src/import-types.js';
import { resourceNameError, resourceNameKey, suggestResourceName } from '../src/names.js';
import { initProject, loadProject, readPath } from '../src/project.js';
import { applyStructureEdit, inspectStructure } from '../src/structure.js';
import type { Project, TableSchema } from '../src/types.js';
import { schemaDiagnostics, validateProject } from '../src/validation.js';
import { formatYaml, parseYaml } from '../src/yaml.js';

const roots: string[] = [];
const definition: TableSchema = { primary_key: 'key', columns: { key: { type: 'string' }, source: { type: 'text' } } };
const yaml = (file: string, data: unknown) => formatYaml(parseYaml(JSON.stringify(data), file)).source;
async function fixture(entries: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-resource-names-'));
  roots.push(root);
  await initProject(root);
  for (const [file, data] of Object.entries(entries)) await writeFile(join(root, file), yaml(file, data));
  return loadProject(root);
}
async function importFixture(entries: Record<string, unknown> = {}, source = 'Key,Source\na,원문\n') {
  const project = await fixture(entries), file = join(project.root, 'source.csv');
  await writeFile(file, source);
  const inspection = await inspectImport(file);
  const mapping: ImportMapping = { table: 'items', schema: 'items', definition,
    sheet: inspection.sheets[0]!.name, header_row: 1, data_start_row: 2,
    columns: { A: 'key', B: 'source' }, numeric: 'stored' };
  return { project, inspection, mapping };
}
function virtualProject(project: Project, entries: Record<string, unknown>): Project {
  // Windows cannot create legacy reserved filenames; their read/diagnostic contract is portable.
  const sources = new Map(Object.entries(entries).map(([file, data]) => [file, yaml(file, data)]));
  const files = new Map([...sources].map(([file, source]) => [file, parseYaml(source, file)]));
  return { ...project, sources, files, diagnostics: [] };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('resource filename rules', () => {
  it('renames schema declarations and reports plain-text candidates without rewriting them', async () => {
    const project = await fixture({ 'schemas/catalog_rules.yaml': definition,
      'tables/items.yaml': { schema: 'catalog_rules', rows: [{ key: 'a', source: 'catalog_rules 메모' }] } });
    await writeFile(join(project.root, 'plan.md'), 'catalog_rules 검토 메모\n');
    const result = await renameResource(project.root, project.revision, 'schema', 'catalog_rules', 'item_rules');
    expect(readPath(result.project, 'items')).toHaveProperty('table.schema', 'item_rules');
    expect(readPath(result.project, 'items/a/source')).toMatchObject({ value: 'catalog_rules 메모' });
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'tables/items.yaml', path: 'items/a/source' }),
      expect.objectContaining({ file: 'plan.md', line: 1 }),
    ]));
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps Korean spelling and compares NFC/case without normalizing stored names', async () => {
    const project = await fixture();
    const table = '아이템.Mix';
    const result = await applyStructureEdit(project.root, project.revision, {
      op: 'table-create', table, key: { code: 'key', label: '키 / CON:*' },
    });
    expect(result.changed.sort()).toEqual(['schemas/' + table + '.yaml', 'tables/' + table + '.yaml']);
    expect(result.diagnostics).toEqual([]);
    expect(readPath(result.project, table)).toHaveProperty('table.schema', table);
    expect(resourceNameKey('가')).toBe(resourceNameKey('가'.normalize('NFD')));
    expect(resourceNameKey('Items')).toBe(resourceNameKey('items'));
    expect(resourceNameKey('ΟΣ')).toBe(resourceNameKey('οσ'));
    expect(resourceNameKey('ẞ')).toBe(resourceNameKey('ß'));
  });

  it.each(['CON', 'con.txt', 'NUL', 'COM1', 'LPT9', 'bad/name', 'bad\\name', 'bad:name', 'bad?name', 'bad*name', 'trailing.', 'trailing ', 'bad\u0001name', 'bad\ud800name'])
    ('rejects destination %j with a usable suggestion and leaves files untouched', async name => {
      const project = await fixture({ 'schemas/items.yaml': definition, 'tables/items.yaml': { schema: 'items', rows: [] } });
      expect(resourceNameError(name)).toBeDefined();
      const suggestion = suggestResourceName(name);
      expect(resourceNameError(suggestion)).toBeUndefined();
      const operation = { op: 'table-create' as const, table: name, key: { code: 'key', label: 'Key' } };
      expect((await inspectStructure(project, operation)).blocked).toContain('이름 제안:');
      await expect(applyStructureEdit(project.root, project.revision, operation)).rejects.toMatchObject({ code: 'NAME_INVALID' });
      await expect(renameResource(project.root, project.revision, 'table', 'items', name)).rejects.toMatchObject({ code: 'NAME_INVALID', message: expect.stringContaining('이름 제안:') });
      await expect(renameResource(project.root, project.revision, 'schema', 'items', name)).rejects.toMatchObject({ code: 'NAME_INVALID', message: expect.stringContaining('이름 제안:') });
      expect((await loadProject(project.root)).revision).toBe(project.revision);
    });

  it.each([
    ['ASCII', 'a'.repeat(79) + '.' + 'b'.repeat(180), 'a'.repeat(79)],
    ['Korean', '가'.repeat(79) + '.' + '나'.repeat(180), '가'.repeat(79)],
  ])('keeps %s suggestions valid after truncating the basename', (_label, name, base) => {
    expect(resourceNameError(name)).toBeDefined();
    const suggestion = suggestResourceName(name);
    expect(resourceNameError(suggestion)).toBeUndefined();
    expect(suggestion).toBe(base);
    const duplicate = suggestResourceName(name, [base.toUpperCase()]);
    expect(duplicate).toBe(base + '_2');
    expect(resourceNameError(duplicate)).toBeUndefined();
  });

  it('checks all existing filenames for case collisions, including unreadable files', async () => {
    let project = await fixture({ 'schemas/base.yaml': definition, 'tables/base.yaml': { schema: 'base', rows: [] } });
    await writeFile(join(project.root, 'tables', 'Items.yaml'), 'broken: [\n');
    project = await loadProject(project.root);
    const operation = { op: 'table-create' as const, table: 'items', key: { code: 'key', label: 'Key' } };
    expect((await inspectStructure(project, operation)).blocked).toContain('items_2');
    await expect(applyStructureEdit(project.root, project.revision, operation)).rejects.toMatchObject({ code: 'NAME_EXISTS' });
    await expect(renameResource(project.root, project.revision, 'table', 'base', 'ITEMS')).rejects.toMatchObject({ code: 'NAME_EXISTS' });
    expect((await loadProject(project.root)).revision).toBe(project.revision);
  });

  it('keeps table/schema namespaces separate and avoids case collisions in generated schemas', async () => {
    const project = await fixture({ 'schemas/Items.yaml': definition, 'schemas/ITEMS_2.yaml': definition });
    const result = await applyStructureEdit(project.root, project.revision, {
      op: 'table-create', table: 'items', key: { code: 'key', label: 'Key' },
    });
    expect(readPath(result.project, 'items')).toHaveProperty('table.schema', 'items_3');
    expect(result.project.sources.get('schemas/Items.yaml')).toBe(project.sources.get('schemas/Items.yaml'));
    expect(result.changed.sort()).toEqual(['schemas/items_3.yaml', 'tables/items.yaml']);
  });

  it('rejects case-only rename before changing declarations or disk spelling', async () => {
    const ref = { primary_key: 'key', columns: { key: { type: 'string' }, target: { type: 'ref', table: 'items' } } };
    const project = await fixture({ 'schemas/items.yaml': definition, 'tables/items.yaml': { schema: 'items', rows: [] },
      'schemas/offers.yaml': ref, 'tables/offers.yaml': { schema: 'offers', rows: [] } });
    await expect(renameResource(project.root, project.revision, 'table', 'items', 'Items'))
      .rejects.toMatchObject({ code: 'CASE_ONLY_RENAME', message: expect.stringContaining('저장') });
    expect((await loadProject(project.root)).revision).toBe(project.revision);
    expect(await readdir(join(project.root, 'tables'))).toEqual(expect.arrayContaining(['items.yaml']));
  });

  it('renames to Korean spelling and preserves row bytes while updating declared targets', async () => {
    const ref = { primary_key: 'key', columns: { key: { type: 'string' }, target: { type: 'ref', table: 'items' } } };
    const project = await fixture({ 'schemas/items.yaml': definition, 'tables/items.yaml': { schema: 'items', rows: [{ key: 'CON' }] },
      'schemas/offers.yaml': ref, 'tables/offers.yaml': { schema: 'offers', rows: [{ key: 'offer', target: 'CON' }] } });
    const result = await renameResource(project.root, project.revision, 'table', 'items', '아이템');
    expect(result.project.sources.get('tables/아이템.yaml')).toBe(project.sources.get('tables/items.yaml'));
    expect(readPath(result.project, 'offers')).toHaveProperty('schema.columns.target.table', '아이템');
    expect(result.diagnostics).toEqual([]);
  });

  it('renames a shared schema without changing its source or unrelated table declarations', async () => {
    const project = await fixture({ 'schemas/items.yaml': definition, 'schemas/other.yaml': definition,
      'tables/items.yaml': { schema: 'items', rows: [{ key: 'CON', source: 'items remains plain text' }] },
      'tables/shared.yaml': { schema: 'items', rows: [] }, 'tables/other.yaml': { schema: 'other', rows: [] } });
    const result = await renameResource(project.root, project.revision, 'schema', 'items', '아이템 스키마');
    expect(result.project.sources.get('schemas/아이템 스키마.yaml')).toBe(project.sources.get('schemas/items.yaml'));
    expect(result.project.sources.has('schemas/items.yaml')).toBe(false);
    expect(readPath(result.project, 'items')).toHaveProperty('table.schema', '아이템 스키마');
    expect(readPath(result.project, 'shared')).toHaveProperty('table.schema', '아이템 스키마');
    expect(readPath(result.project, 'items/CON/source')).toMatchObject({ value: 'items remains plain text' });
    expect(result.project.sources.get('tables/other.yaml')).toBe(project.sources.get('tables/other.yaml'));
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects schema case collisions and case-only rename before writing', async () => {
    const project = await fixture({ 'schemas/items.yaml': definition, 'schemas/Other.yaml': definition });
    await expect(renameResource(project.root, project.revision, 'schema', 'items', 'OTHER')).rejects.toMatchObject({ code: 'NAME_EXISTS' });
    await expect(renameResource(project.root, project.revision, 'schema', 'items', 'Items')).rejects.toMatchObject({ code: 'CASE_ONLY_RENAME' });
    expect((await loadProject(project.root)).revision).toBe(project.revision);
  });
});

describe('resource declarations and legacy names', () => {
  it.each(['CON', 'bad/name', 'bad\\name', 'bad:', 'trailing.'])('diagnoses schema and ref target %j with suggestions', async name => {
    const project = virtualProject(await fixture(), {
      'schemas/base.yaml': { primary_key: 'key', columns: { key: { type: 'string' }, target: { type: 'ref', table: name } } },
      'tables/base.yaml': { schema: name, rows: [] },
    });
    expect(validateProject(project)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NAME_INVALID', file: 'schemas/base.yaml', path: 'columns/target/table', message: expect.stringContaining('이름 제안:') }),
      expect.objectContaining({ code: 'NAME_INVALID', file: 'tables/base.yaml', path: 'schema', message: expect.stringContaining('이름 제안:') }),
    ]));
  });

  it('keeps legacy resource names readable despite filename diagnostics', async () => {
    const project = virtualProject(await fixture(), {
      'schemas/NUL.yaml': definition, 'tables/CON.yaml': { schema: 'NUL', rows: [{ key: 'a' }] },
      'schemas/offers.yaml': { primary_key: 'key', columns: { key: { type: 'string' }, target: { type: 'ref', table: 'CON' } } },
      'tables/offers.yaml': { schema: 'offers', rows: [{ key: 'b', target: 'a' }] },
    });
    expect(readPath(project, 'CON/a')).toEqual({ key: 'a' });
    expect(readPath(project, 'offers/b/target')).toMatchObject({ value: 'a' });
    expect(validateProject(project).some(error => error.code === 'REF_MISSING')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('repairs an existing reserved table name and its self/external references', async () => {
    const schema = { primary_key: 'key', columns: { key: { type: 'string' }, target: { type: 'ref', table: 'CON' } } };
    const project = await fixture({ 'schemas/items.yaml': schema, 'tables/CON.yaml': { schema: 'items', rows: [{ key: 'a', target: 'a' }] },
      'tables/other.yaml': { schema: 'items', rows: [{ key: 'b', target: 'a' }] } });
    expect(validateProject(project)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'NAME_INVALID' })]));
    const result = await renameResource(project.root, project.revision, 'table', 'CON', '아이템');
    expect(readPath(result.project, '아이템/a')).toMatchObject({ key: 'a', target: 'a' });
    expect(readPath(result.project, 'other')).toHaveProperty('schema.columns.target.table', '아이템');
    expect(result.diagnostics).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('repairs an existing reserved schema name and its table declarations', async () => {
    const project = await fixture({ 'schemas/NUL.yaml': definition,
      'tables/items.yaml': { schema: 'NUL', rows: [{ key: 'a' }] } });
    expect(readPath(project, 'items/a')).toEqual({ key: 'a' });
    const result = await renameResource(project.root, project.revision, 'schema', 'NUL', '스키마');
    expect(readPath(result.project, 'items')).toHaveProperty('table.schema', '스키마');
    expect(result.diagnostics).toEqual([]);
  });

  it('does not extend filename rules to existing column codes, labels, Key values or ref cells', async () => {
    const keys = ['CON', 'NUL.txt', 'a\\b', 'a:b', 'a?', 'trailing.', 'trailing ', 'Key', 'key'];
    const schema: TableSchema = { primary_key: 'CON', columns: {
      CON: { type: 'string', label: '표시명 /:*?<>|' },
      'NUL:': { type: 'text', label: '다른 / 표시명' },
      target: { type: 'ref', table: 'items' },
    } };
    let project = await fixture({ 'schemas/items.yaml': schema,
      'tables/items.yaml': { schema: 'items', rows: keys.map(key => ({ CON: key, 'NUL:': 'text', target: key })) } });
    expect(schemaDiagnostics(project.files.get('schemas/items.yaml')!)).toEqual([]);
    expect(validateProject(project)).toEqual([]);
    const created = await applyEdits(project.root, project.revision, [{ op: 'create', table: 'items', row: { CON: 'COM1', target: 'CON' } }]);
    expect(created.diagnostics).toEqual([]);
    const renamed = await renameResource(project.root, created.project.revision, 'key', 'items/COM1', 'LPT1');
    expect(renamed.diagnostics).toEqual([]);
    project = renamed.project;
    const column = await renameResource(project.root, project.revision, 'column', 'items/*/NUL:', 'AUX');
    expect(column.diagnostics).toEqual([]);
    expect(readPath(column.project, 'items/CON/AUX')).toMatchObject({ value: 'text' });
  });
});

describe('import resource names', () => {
  it.each(['CON', 'bad/name', 'bad\\name', 'bad:', 'trailing.'])('rejects invalid table/schema destination %j without replacing it by a suggestion', async name => {
    const { project, inspection, mapping } = await importFixture();
    for (const field of ['table', 'schema']) {
      expect(() => planImport(project, inspection, { ...mapping, [field]: name }))
        .toThrow(expect.objectContaining({ code: 'IMPORT_MAPPING', message: expect.stringContaining('이름 제안:') }));
    }
    expect((await loadProject(project.root)).revision).toBe(project.revision);
  });

  it.each(['schemas', 'tables'])('blocks case-colliding %s filenames in preview and edited plans', async directory => {
    const { project, inspection, mapping } = await importFixture({
      [directory + '/Items.yaml']: directory === 'schemas' ? definition : { schema: 'items', rows: [] },
    });
    const plan = planImport(project, inspection, mapping);
    expect(plan.canApply).toBe(false);
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_NAME_EXISTS', message: expect.stringContaining('items_2') }));
    await expect(applyImport(project.root, project.revision, { ...plan, canApply: true }))
      .rejects.toMatchObject({ code: 'IMPORT_BLOCKED' });
    expect((await loadProject(project.root)).revision).toBe(project.revision);
  });

  it('reports invalid ref declarations with their name suggestions in the import plan', async () => {
    const { project, inspection, mapping } = await importFixture();
    const plan = planImport(project, inspection, { ...mapping, definition: { ...definition,
      columns: { ...definition.columns, target: { type: 'ref', table: 'NUL' } } } });
    expect(plan.canApply).toBe(false);
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_SCHEMA', message: expect.stringContaining('이름 제안:') }));
  });

  it('preserves Korean destination spelling and permits Windows-reserved Key text', async () => {
    const { project, inspection, mapping } = await importFixture({}, 'Key,Source\nCON,예약 장치 이름도 Key에서는 허용\nKey,대문자\nkey,소문자\n');
    const plan = planImport(project, inspection, { ...mapping, table: '아이템.Mix', schema: '스키마.Mix' });
    expect(plan.canApply).toBe(true);
    const result = await applyImport(project.root, project.revision, plan);
    expect(result.changed.sort()).toEqual(['schemas/스키마.Mix.yaml', 'tables/아이템.Mix.yaml']);
    expect(readPath(result.project, '아이템.Mix/CON')).toHaveProperty('key', 'CON');
    expect(result.diagnostics).toEqual([]);
  });
});
