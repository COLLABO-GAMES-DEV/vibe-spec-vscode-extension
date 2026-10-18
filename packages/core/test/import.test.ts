import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyImport, initProject, inspectImport, loadProject, planImport, readPath } from '../src/index.js';
import type { ImportMapping } from '../src/index.js';
const roots: string[] = [];
async function fixture(source = '\n,Key,Price,Note\n,a,+001.2300E+0002,hello\n,b,900719925474099312345,\n') {
  const root = await mkdtemp(join(tmpdir(), 'vibe-import-')); roots.push(root);
  const project = await initProject(root), file = join(root, 'source.csv'); await writeFile(file, source);
  const inspection = await inspectImport(file);
  const mapping: ImportMapping = { table: 'rates', schema: 'rates', sheet: inspection.sheets[0]!.name,
    header_row: 2, data_start_row: 3, columns: { B: 'code', C: 'price', D: 'note' }, numeric: 'stored',
    definition: { primary_key: 'code', columns: { code: { type: 'string' }, price: { type: 'decimal', minimum: '0' }, note: { type: 'text' } } } };
  return { root, project, file, inspection, mapping };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('preview is read-only; apply preserves source spelling and writes formatted schema/table together', async () => {
  const f = await fixture(), plan = planImport(f.project, f.inspection, f.mapping);
  expect(plan.canApply).toBe(true); expect(plan.rows.map(row => row.sourceRow)).toEqual([3, 4]);
  expect((await loadProject(f.root)).revision).toBe(f.project.revision);
  const result = await applyImport(f.root, plan.revision, plan);
  expect(result.changed.sort()).toEqual(['schemas/rates.yaml', 'tables/rates.yaml']);
  expect(readPath(result.project, 'rates/a/price')).toEqual({ present: true, value: '+001.2300E+0002' });
  expect(readPath(result.project, 'rates/b/price')).toEqual({ present: true, value: '900719925474099312345' });
  expect(readPath(result.project, 'rates/b/note')).toEqual({ present: true, value: '' });
  expect(result.diagnostics).toEqual([]);
});
it('rejects source changes and stale planning revisions without writing the previewed rows', async () => {
  const f = await fixture(), plan = planImport(f.project, f.inspection, f.mapping);
  await writeFile(f.file, '\n,Key,Price,Note\n,x,12.5000,changed\n');
  await expect(applyImport(f.root, plan.revision, plan)).rejects.toMatchObject({ code: 'IMPORT_SOURCE_CHANGED' });
  expect((await loadProject(f.root)).revision).toBe(f.project.revision);
  const fresh = planImport(f.project, await inspectImport(f.file), f.mapping);
  const result = await applyImport(f.root, fresh.revision, fresh);
  await expect(applyImport(f.root, plan.revision, plan)).rejects.toMatchObject({ code: 'STALE_REVISION' });
  expect(readPath(result.project, 'rates/x/price')).toMatchObject({ value: '12.5000' });
});
it('appends using an existing schema and blocks duplicate Keys before any file changes', async () => {
  const f = await fixture(), first = planImport(f.project, f.inspection, f.mapping);
  const result = await applyImport(f.root, first.revision, first);
  const duplicate = planImport(result.project, f.inspection, { ...f.mapping, definition: undefined } as unknown as ImportMapping);
  expect(duplicate.canApply).toBe(false); expect(duplicate.issues.some(issue => issue.code === 'IMPORT_KEY_DUPLICATE')).toBe(true);
  await expect(applyImport(f.root, duplicate.revision, duplicate)).rejects.toMatchObject({ code: 'IMPORT_BLOCKED' });
  expect((await loadProject(f.root)).revision).toBe(result.project.revision);
  await writeFile(f.file, '\n,Key,Price,Note\n,c,0.005,append\n');
  const { definition: _, ...mapping } = f.mapping;
  const plan = planImport(result.project, await inspectImport(f.file), mapping);
  const appended = await applyImport(f.root, plan.revision, plan);
  expect(appended.changed).toEqual(['tables/rates.yaml']);
  expect(readPath(appended.project, 'rates/a/price')).toMatchObject({ value: '+001.2300E+0002' });
});
it('normal schema validation is reported but does not turn an applied import into a rejected write', async () => {
  const f = await fixture('\n,Key,Price,Note\n,a,-1,below range\n');
  const plan = planImport(f.project, f.inspection, f.mapping);
  expect(plan.canApply).toBe(true); expect(plan.diagnostics.some(issue => issue.path === 'rates/a/price')).toBe(true);
  const result = await applyImport(f.root, plan.revision, plan);
  expect(readPath(result.project, 'rates/a/price')).toMatchObject({ value: '-1' });
});
it('supports explicit exclusions and only blocks unsupported cells in mapped source rows', async () => {
  const f = await fixture();
  f.inspection.sheets[0]!.cells.D3 = { unsupported: 'unsupported source cell' };
  const plan = planImport(f.project, f.inspection, f.mapping);
  expect(plan.canApply).toBe(false);
  expect(plan.issues.some(issue => issue.cell === 'D3' && issue.severity === 'error')).toBe(true);
  expect(planImport(f.project, f.inspection, { ...f.mapping, columns: { B: 'code', C: 'price' } }).canApply).toBe(true);
  expect(planImport(f.project, f.inspection, { ...f.mapping, exclude_rows: [3] }).rows).toHaveLength(1);
});
it('does not silently accept unsafe numeric display candidates', async () => {
  const f = await fixture();
  f.inspection.sheets[0]!.cells.C4 = { raw: '900719925474099312345', display: '900719925474099300000', displaySafe: false };
  const plan = planImport(f.project, f.inspection, { ...f.mapping, numeric: 'display' });
  expect(plan.canApply).toBe(false); expect(plan.issues.some(issue => issue.code === 'IMPORT_DISPLAY_UNSAFE')).toBe(true);
  const stored = planImport(f.project, f.inspection, { ...f.mapping, numeric: 'display', representations: { C4: 'stored' } });
  expect(stored.canApply).toBe(true); expect(stored.rows[1]!.values.price).toBe('900719925474099312345');
});
it('revalidates edited plan input and uses the shared writer lock', async () => {
  const f = await fixture(), plan = planImport(f.project, f.inspection, f.mapping);
  await writeFile(join(f.root, '.vibe-spec.lock'), 'another writer');
  await expect(applyImport(f.root, plan.revision, plan)).rejects.toMatchObject({ code: 'PROJECT_LOCKED' });
  await rm(join(f.root, '.vibe-spec.lock'));
  await expect(applyImport(f.root, plan.revision, { ...plan, mapping: { ...f.mapping, table: '../escape' } })).rejects.toMatchObject({ code: 'IMPORT_MAPPING' });
  expect((await loadProject(f.root)).revision).toBe(plan.revision);
});

it('rejects unsupported CSV encoding instead of replacing source characters', async () => {
  const f = await fixture();
  await writeFile(f.file, Buffer.from([0xc3, 0x28]));
  await expect(inspectImport(f.file)).rejects.toMatchObject({ code: 'IMPORT_ENCODING' });
});

for (const resource of ['schemas', 'tables']) {
  it('refuses to replace an existing unparseable ' + resource + ' file', async () => {
    const f = await fixture();
    const file = join(f.root, resource, 'rates.yaml');
    const broken = resource === 'tables' ? 'schema: rates\nrows:\n  - code: "valuable but unclosed\n' : 'primary_key: "broken\n';
    await writeFile(file, broken);
    const current = await loadProject(f.root), plan = planImport(current, f.inspection, f.mapping);
    expect(plan.canApply).toBe(false);
    await expect(applyImport(f.root, plan.revision, plan)).rejects.toMatchObject({ code: 'IMPORT_BLOCKED' });
    expect((await loadProject(f.root)).sources.get(resource + '/rates.yaml')).toBe(broken);
  });
}

it('rejects numeric schema bounds supplied as JS numbers before YAML could coerce them', async () => {
  const f = await fixture();
  const mapping = JSON.parse(JSON.stringify(f.mapping)) as ImportMapping;
  (mapping.definition!.columns.price as unknown as { minimum: number }).minimum = 9007199254740992;
  const plan = planImport(f.project, f.inspection, mapping);
  expect(plan.canApply).toBe(false);
  expect(plan.issues.some(issue => issue.code === 'IMPORT_SCHEMA')).toBe(true);
  await expect(applyImport(f.root, plan.revision, plan)).rejects.toMatchObject({ code: 'IMPORT_BLOCKED' });
  expect((await loadProject(f.root)).revision).toBe(f.project.revision);
});
