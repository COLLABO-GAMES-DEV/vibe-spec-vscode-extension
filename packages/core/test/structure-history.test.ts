import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { applyStructureEdit } from '../src/structure.js';
import { applyEdits, renameResource } from '../src/editing.js';
import { ScreenHistory } from '../src/history.js';
import { loadProject, readPath } from '../src/project.js';
import type { StructureOperation } from '../src/structure-types.js';

const roots: string[] = [];
async function fixture(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-structure-history-'));
  roots.push(root);
  await cp(fileURLToPath(new URL('./fixtures/project/', import.meta.url)), root, { recursive: true });
  for (const [file, source] of Object.entries(extra)) await writeFile(join(root, file), source);
  return loadProject(root);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([
  { op: 'column-add', table: 'items', column: 'added', definition: { type: 'text', required: true } },
  { op: 'column-update', table: 'items', column: 'name', changes: { type: 'boolean', label: 'Display', required: false } },
  { op: 'column-move', table: 'items', column: 'name', position: { anchor: 'note', side: 'after' } },
] satisfies StructureOperation[])('restores exact schema bytes through undo/redo without touching rows: %j', async operation => {
  const project = await fixture();
  const history = new ScreenHistory();
  const written = await applyStructureEdit(project.root, project.revision, operation);
  history.recordStructure(written);
  const external = await applyEdits(project.root, written.project.revision, [{ op: 'update', table: 'items', key: 'currency_gold', values: { note: 'outside' } }]);
  const undone = await history.undo(project.root, external.project.revision);
  expect(undone.changed).toEqual(['schemas/items.yaml']);
  expect(undone.project.sources.get('schemas/items.yaml')).toBe(project.sources.get('schemas/items.yaml'));
  expect(undone.project.sources.get('tables/items.yaml')).toBe(external.project.sources.get('tables/items.yaml'));
  expect(history.info()).toEqual({ canUndo: false, canRedo: true });
  const redone = await history.redo(project.root, undone.project.revision);
  expect(redone.project.sources.get('schemas/items.yaml')).toBe(written.planned.sources.get('schemas/items.yaml'));
  expect(redone.project.sources.get('tables/items.yaml')).toBe(external.project.sources.get('tables/items.yaml'));
});

it('restores deleted column values and entire unique tuples in all shared tables byte for byte', async () => {
  let project = await fixture();
  await writeFile(join(project.root, 'tables/other.yaml'), project.sources.get('tables/items.yaml')!);
  await writeFile(join(project.root, 'schemas/items.yaml'), project.sources.get('schemas/items.yaml')! + 'unique:\n  - [name, kind]\n');
  project = await loadProject(project.root);
  const history = new ScreenHistory();
  const written = await applyStructureEdit(project.root, project.revision, { op: 'column-delete', table: 'items', column: 'name' });
  history.recordStructure(written);
  const undone = await history.undo(project.root, written.project.revision);
  expect(undone.project.sources).toEqual(project.sources);
  const redone = await history.redo(project.root, undone.project.revision);
  expect(redone.project.sources).toEqual(written.planned.sources);
});

it.each(['code', 'name'])('undoes and redoes a column rename, including the Key column: %s', async column => {
  let project = await fixture();
  await writeFile(join(project.root, 'tables/other.yaml'), project.sources.get('tables/items.yaml')!);
  project = await loadProject(project.root);
  const history = new ScreenHistory();
  const written = await renameResource(project.root, project.revision, 'column', 'items/*/' + column, 'renamed');
  history.recordStructure(written);
  const undone = await history.undo(project.root, written.project.revision);
  expect(undone.project.sources).toEqual(project.sources);
  const redone = await history.redo(project.root, undone.project.revision);
  expect(redone.project.sources).toEqual(written.planned.sources);
  expect(readPath(redone.project, 'other/currency_gold')).toHaveProperty('renamed', column === 'code' ? 'currency_gold' : '골드');
});

it('refuses undo and redo if an affected schema was externally changed, retaining the history entry', async () => {
  const project = await fixture();
  const history = new ScreenHistory();
  const written = await applyStructureEdit(project.root, project.revision, { op: 'column-update', table: 'items', column: 'name', changes: { label: 'Changed' } });
  history.recordStructure(written);
  for (const redo of [false, true]) {
    const expected = redo ? project.sources.get('schemas/items.yaml')! : written.planned.sources.get('schemas/items.yaml')!;
    await writeFile(join(project.root, 'schemas/items.yaml'), expected + '# external comment\n');
    let current = await loadProject(project.root);
    await expect(redo ? history.redo(project.root, current.revision) : history.undo(project.root, current.revision))
      .rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
    expect((await loadProject(project.root)).revision).toBe(current.revision);
    expect(history.info()).toEqual({ canUndo: !redo, canRedo: redo });
    await writeFile(join(project.root, 'schemas/items.yaml'), expected);
    current = await loadProject(project.root);
    if (!redo) await history.undo(project.root, current.revision);
  }
});

it.each(['column-delete', 'rename'] as const)('refuses to restore a changed row file after %s', async op => {
  const project = await fixture();
  const history = new ScreenHistory();
  const written = op === 'rename'
    ? await renameResource(project.root, project.revision, 'column', 'items/*/name', 'renamed')
    : await applyStructureEdit(project.root, project.revision, { op, table: 'items', column: 'name' });
  history.recordStructure(written);
  const external = await applyEdits(project.root, written.project.revision, [{ op: 'create', table: 'items', row: { code: 'new', note: 'outside' } }]);
  await expect(history.undo(project.root, external.project.revision)).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
  expect((await loadProject(project.root)).revision).toBe(external.project.revision);
});

it.each(['existing-row', 'new-row', 'new-table'] as const)('refuses to undo a schema-only column add with external values in %s', async location => {
  const project = await fixture();
  const history = new ScreenHistory();
  const written = await applyStructureEdit(project.root, project.revision, { op: 'column-add', table: 'items', column: 'added', definition: { type: 'text' } });
  expect(written.changed).toEqual(['schemas/items.yaml']);
  history.recordStructure(written);
  let current = written.project;
  if (location === 'new-table') {
    await writeFile(join(project.root, 'tables/external.yaml'), 'schema: items\nrows:\n  - code: "new"\n    added: "do not orphan"\n');
    current = await loadProject(project.root);
  } else {
    current = (await applyEdits(project.root, current.revision, location === 'new-row'
      ? [{ op: 'create', table: 'items', row: { code: 'new', added: 'do not orphan' } }]
      : [{ op: 'update', table: 'items', key: 'currency_gold', values: { added: 'do not orphan' } }])).project;
  }
  await expect(history.undo(project.root, current.revision)).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
  expect((await loadProject(project.root)).revision).toBe(current.revision);
  expect(history.info()).toEqual({ canUndo: true, canRedo: false });
});

it.each(['rename-undo', 'delete-redo'] as const)('refuses %s when a new shared table uses the column that would disappear', async direction => {
  const project = await fixture();
  const history = new ScreenHistory();
  const written = direction === 'rename-undo'
    ? await renameResource(project.root, project.revision, 'column', 'items/*/name', 'renamed')
    : await applyStructureEdit(project.root, project.revision, { op: 'column-delete', table: 'items', column: 'name' });
  history.recordStructure(written);
  if (direction === 'delete-redo') await history.undo(project.root, written.project.revision);
  const column = direction === 'rename-undo' ? 'renamed' : 'name';
  await writeFile(join(project.root, 'tables/external.yaml'), 'schema: items\nrows:\n  - code: "new"\n    ' + column + ': "keep"\n');
  const current = await loadProject(project.root);
  await expect(direction === 'rename-undo' ? history.undo(project.root, current.revision) : history.redo(project.root, current.revision))
    .rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
  expect((await loadProject(project.root)).revision).toBe(current.revision);
});

it('allows external rows lacking a removed column and preserves their bytes', async () => {
  const project = await fixture();
  const history = new ScreenHistory();
  const written = await applyStructureEdit(project.root, project.revision, { op: 'column-add', table: 'items', column: 'added', definition: { type: 'text' } });
  history.recordStructure(written);
  const external = await applyEdits(project.root, written.project.revision, [{ op: 'create', table: 'items', row: { code: 'new' } }]);
  const undone = await history.undo(project.root, external.project.revision);
  expect(undone.project.sources.get('tables/items.yaml')).toBe(external.project.sources.get('tables/items.yaml'));
});

it('leaves redo intact for no-op structure edits and does not record table lifecycle history', async () => {
  const project = await fixture();
  const history = new ScreenHistory();
  const written = await applyStructureEdit(project.root, project.revision, { op: 'column-update', table: 'items', column: 'name', changes: { label: 'Display' } });
  history.recordStructure(written);
  const undone = await history.undo(project.root, written.project.revision);
  const noop = await applyStructureEdit(project.root, undone.project.revision, { op: 'column-move', table: 'items', column: 'name', position: { anchor: 'code', side: 'after' } });
  expect(noop.changed).toEqual([]);
  history.recordStructure(noop);
  expect(history.info()).toEqual({ canUndo: false, canRedo: true });
  const separate = new ScreenHistory();
  const created = await applyStructureEdit(project.root, noop.project.revision, { op: 'table-create', table: 'new', key: { code: 'key', label: 'Key' } });
  separate.recordStructure(created);
  expect(separate.info()).toEqual({ canUndo: false, canRedo: false });
});
