import { cp, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { applyEdits, loadProject, readPath, renameResource, ScreenHistory } from '../src/index.js';
import type { EditOperation } from '../src/index.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-history-'));
  roots.push(root);
  await cp(fileURLToPath(new URL('./fixtures/project/', import.meta.url)), root, { recursive: true });
  return loadProject(root);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('undoes a pasted batch in one step, preserves unrelated external edits, and redoes exact numeric text', async () => {
  const original = await fixture();
  const history = new ScreenHistory();
  const operations: EditOperation[] = [
    { op: 'update', table: 'offers', key: 'bundle', values: { price: '12.5000', count: '00042' } },
    { op: 'update', table: 'items', key: 'currency_gold', values: { name: '금화' } },
  ];
  const written = await applyEdits(original.root, original.revision, operations);
  history.recordCells(written, operations);
  const external = await applyEdits(original.root, written.project.revision, [
    { op: 'update', table: 'items', key: 'currency_gold', values: { note: 'Codex 변경' } },
  ]);
  const undone = await history.undo(original.root, external.project.revision);
  expect(readPath(undone.project, 'offers/bundle/price')).toEqual({ value: '+001.2300E+0002', present: true });
  expect(readPath(undone.project, 'items/currency_gold')).toMatchObject({ name: '골드', note: 'Codex 변경' });
  expect(history.info()).toEqual({ canUndo: false, canRedo: true });
  const redone = await history.redo(original.root, undone.project.revision);
  expect(readPath(redone.project, 'offers/bundle')).toMatchObject({ price: '12.5000', count: '00042' });
  expect(readPath(redone.project, 'items/currency_gold/note')).toHaveProperty('value', 'Codex 변경');
});

it('refuses to undo or redo a cell changed elsewhere, without popping the record or touching files', async () => {
  let project = await fixture();
  const history = new ScreenHistory();
  const operations: EditOperation[] = [{ op: 'update', table: 'items', key: 'currency_gold', values: { name: '금화' } }];
  const written = await applyEdits(project.root, project.revision, operations);
  history.recordCells(written, operations);
  project = (await applyEdits(project.root, written.project.revision, [{ ...operations[0]!, op: 'update', table: 'items', key: 'currency_gold', values: { name: '외부' } }])).project;
  await expect(history.undo(project.root, project.revision)).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
  expect((await loadProject(project.root)).revision).toBe(project.revision);
  expect(history.info()).toEqual({ canUndo: true, canRedo: false });
  project = (await applyEdits(project.root, project.revision, operations)).project;
  project = (await history.undo(project.root, project.revision)).project;
  project = (await applyEdits(project.root, project.revision, [{ op: 'update', table: 'items', key: 'currency_gold', values: { name: '다른 외부' } }])).project;
  await expect(history.redo(project.root, project.revision)).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
  expect(readPath(await loadProject(project.root), 'items/currency_gold/name')).toHaveProperty('value', '다른 외부');
});

it('restores absence, rather than null or an empty string, and keeps original neighboring bytes', async () => {
  let project = await fixture();
  const path = join(project.root, 'tables/items.yaml');
  const original = (await readFile(path, 'utf8')).replace('    note: "001"\n', '');
  await writeFile(path, original);
  project = await loadProject(project.root);
  const history = new ScreenHistory();
  const operations: EditOperation[] = [{ op: 'update', table: 'items', key: 'currency_gold', values: { note: '' } }];
  const written = await applyEdits(project.root, project.revision, operations);
  history.recordCells(written, operations);
  const undone = await history.undo(project.root, written.project.revision);
  expect(await readFile(path, 'utf8')).toBe(original);
  expect(readPath(undone.project, 'items/currency_gold/note')).toEqual({ present: false, value: null });
  const redone = await history.redo(project.root, undone.project.revision);
  expect(readPath(redone.project, 'items/currency_gold/note')).toEqual({ present: true, value: '' });
});

it('keeps a declared reference consistent across Key undo/redo, and detects new external uses', async () => {
  let project = await fixture();
  const history = new ScreenHistory();
  const written = await renameResource(project.root, project.revision, 'key', 'items/currency_gold', 'currency_coin');
  history.recordRename(written, 'items', 'currency_gold', 'currency_coin');
  project = (await history.undo(project.root, written.project.revision)).project;
  expect(readPath(project, 'offers/bundle/currency')).toHaveProperty('value', 'currency_gold');
  project = (await history.redo(project.root, project.revision)).project;
  expect(readPath(project, 'offers/bundle/currency')).toHaveProperty('value', 'currency_coin');
  project = (await applyEdits(project.root, project.revision, [{ op: 'update', table: 'offers', key: 'starter', values: { currency: 'currency_coin' } }])).project;
  await expect(history.undo(project.root, project.revision)).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
  expect((await loadProject(project.root)).revision).toBe(project.revision);
});

it('drops redo only on a new actual edit, and has no history in a new screen', async () => {
  let project = await fixture();
  const history = new ScreenHistory();
  const operation: EditOperation = { op: 'update', table: 'items', key: 'currency_gold', values: { name: '금화' } };
  const first = await applyEdits(project.root, project.revision, [operation]);
  history.recordCells(first, [operation]);
  project = (await history.undo(project.root, first.project.revision)).project;
  const noop: EditOperation = { ...operation, values: { name: '골드' } };
  history.recordCells(await applyEdits(project.root, project.revision, [noop]), [noop]);
  expect(history.info().canRedo).toBe(true);
  history.recordCells(await applyEdits(project.root, project.revision, [operation]), [operation]);
  expect(history.info().canRedo).toBe(false);
  expect(new ScreenHistory().info()).toEqual({ canUndo: false, canRedo: false });
});

it('undoes and redoes a created row with exact values while preserving other rows', async () => {
  let project = await fixture();
  const history = new ScreenHistory();
  const row = { sku: 'aaa', currency: null, price: '-0.000', count: '00042', available: false };
  const operations: EditOperation[] = [{ op: 'create', table: 'offers', row }];
  const written = await applyEdits(project.root, project.revision, operations);
  history.recordCells(written, operations);
  expect(history.info()).toEqual({ canUndo: true, canRedo: false });
  project = (await applyEdits(project.root, written.project.revision, [
    { op: 'update', table: 'offers', key: 'bundle', values: { price: '456.000' } },
    { op: 'create', table: 'offers', row: { sku: 'external', price: '777' } },
  ])).project;
  project = (await history.undo(project.root, project.revision)).project;
  expect(() => readPath(project, 'offers/aaa')).toThrow();
  expect(history.info()).toEqual({ canUndo: false, canRedo: true });
  project = (await history.redo(project.root, project.revision)).project;
  expect(readPath(project, 'offers/aaa')).toEqual(row);
  expect(readPath(project, 'offers/bundle/price')).toHaveProperty('value', '456.000');
  expect(readPath(project, 'offers/external/price')).toHaveProperty('value', '777');
  expect(readPath(project, 'offers/*/sku')).toEqual(['bundle', 'starter', 'external', 'aaa'].map(key => ({ key, value: key, present: true })));
});

it('restores a deleted row including absent fields, null, boolean, and numeric source text', async () => {
  let project = await fixture();
  const history = new ScreenHistory();
  project = (await applyEdits(project.root, project.revision, [
    { op: 'create', table: 'offers', row: { sku: 'minimal', currency: null, price: '+001.2300E+0002', available: false } },
  ])).project;
  const row = readPath(project, 'offers/minimal');
  const operations: EditOperation[] = [{ op: 'delete', table: 'offers', key: 'minimal' }];
  const written = await applyEdits(project.root, project.revision, operations);
  history.recordCells(written, operations);
  project = (await history.undo(project.root, written.project.revision)).project;
  expect(readPath(project, 'offers/minimal')).toEqual(row);
  expect(readPath(project, 'offers/minimal/count')).toEqual({ present: false, value: null });
  project = (await history.redo(project.root, project.revision)).project;
  expect(() => readPath(project, 'offers/minimal')).toThrow();
  expect(history.info()).toEqual({ canUndo: true, canRedo: false });
});

it('undoes all selected deletions in one step and checks surviving references after the entire redo batch', async () => {
  let project = await fixture();
  const original = project;
  const history = new ScreenHistory();
  const operations: EditOperation[] = [
    { op: 'delete', table: 'items', key: 'currency_gold' },
    { op: 'delete', table: 'items', key: 'consumable_potion' },
    { op: 'delete', table: 'offers', key: 'bundle' },
  ];
  const written = await applyEdits(project.root, project.revision, operations);
  history.recordCells(written, operations);
  project = (await applyEdits(project.root, written.project.revision, [
    { op: 'update', table: 'offers', key: 'starter', values: { count: '007' } },
  ])).project;
  project = (await history.undo(project.root, project.revision)).project;
  for (const operation of operations) {
    if (operation.op === 'delete') expect(readPath(project, operation.table + '/' + operation.key))
      .toEqual(readPath(original, operation.table + '/' + operation.key));
  }
  expect(history.info()).toEqual({ canUndo: false, canRedo: true });
  const redone = await history.redo(project.root, project.revision);
  expect(redone.diagnostics).toEqual([]);
  expect(readPath(redone.project, 'items/*/code')).toEqual([]);
  expect(() => readPath(redone.project, 'offers/bundle')).toThrow();
  expect(readPath(redone.project, 'offers/starter/count')).toHaveProperty('value', '007');
});

it.each(['update', 'delete', 'replace'] as const)('refuses to remove a created row after an external %s', async external => {
  let project = await fixture();
  const history = new ScreenHistory();
  const operations: EditOperation[] = [{ op: 'create', table: 'items', row: { code: 'new', name: 'original' } }];
  const written = await applyEdits(project.root, project.revision, operations);
  history.recordCells(written, operations);
  const edits: EditOperation[] = external === 'update'
    ? [{ op: 'update', table: 'items', key: 'new', values: { note: 'external field' } }]
    : [{ op: 'delete', table: 'items', key: 'new' }];
  if (external === 'replace') edits.push({ op: 'create', table: 'items', row: { code: 'new', name: 'replacement' } });
  project = (await applyEdits(project.root, written.project.revision, edits)).project;
  await expect(history.undo(project.root, project.revision)).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
  expect((await loadProject(project.root)).sources).toEqual(project.sources);
  expect(history.info()).toEqual({ canUndo: true, canRedo: false });
});

it.each(['undo', 'redo'] as const)('refuses to recreate a row during %s when its Key is already occupied, even with identical values', async direction => {
  let project = await fixture();
  const history = new ScreenHistory();
  const row = { code: 'new', name: 'original' };
  const create: EditOperation[] = [{ op: 'create', table: 'items', row }];
  let written = await applyEdits(project.root, project.revision, create);
  if (direction === 'undo') {
    const operations: EditOperation[] = [{ op: 'delete', table: 'items', key: 'new' }];
    written = await applyEdits(project.root, written.project.revision, operations);
    history.recordCells(written, operations);
    project = written.project;
  } else {
    history.recordCells(written, create);
    project = (await history.undo(project.root, written.project.revision)).project;
  }
  project = (await applyEdits(project.root, project.revision, create)).project;
  await expect(history[direction](project.root, project.revision)).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
  expect((await loadProject(project.root)).sources).toEqual(project.sources);
  expect(history.info()).toEqual({ canUndo: direction === 'undo', canRedo: direction === 'redo' });
});

it('rejects the whole deletion redo when one restored row changed externally', async () => {
  let project = await fixture();
  const history = new ScreenHistory();
  const operations: EditOperation[] = ['bundle', 'starter'].map(key => ({ op: 'delete', table: 'offers', key }));
  const written = await applyEdits(project.root, project.revision, operations);
  history.recordCells(written, operations);
  project = (await history.undo(project.root, written.project.revision)).project;
  project = (await applyEdits(project.root, project.revision, [
    { op: 'update', table: 'offers', key: 'starter', values: { available: true } },
  ])).project;
  await expect(history.redo(project.root, project.revision)).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
  expect((await loadProject(project.root)).sources).toEqual(project.sources);
  expect(history.info()).toEqual({ canUndo: false, canRedo: true });
});

it.each(['undo', 'redo'] as const)('keeps declared deletion protection active during row %s and retains the failed entry', async direction => {
  let project = await fixture();
  const history = new ScreenHistory();
  const create: EditOperation[] = [{ op: 'create', table: 'items', row: { code: 'new', name: 'new item' } }];
  let written = await applyEdits(project.root, project.revision, create);
  if (direction === 'undo') {
    history.recordCells(written, create);
    project = written.project;
  } else {
    const operations: EditOperation[] = [{ op: 'delete', table: 'items', key: 'new' }];
    written = await applyEdits(project.root, written.project.revision, operations);
    history.recordCells(written, operations);
    project = (await history.undo(project.root, written.project.revision)).project;
  }
  project = (await applyEdits(project.root, project.revision, [
    { op: 'update', table: 'offers', key: 'starter', values: { currency: 'new' } },
  ])).project;
  await expect(history[direction](project.root, project.revision)).rejects.toMatchObject({ code: 'DELETE_RESTRICTED' });
  expect((await loadProject(project.root)).sources).toEqual(project.sources);
  expect(history.info()).toEqual({ canUndo: direction === 'undo', canRedo: direction === 'redo' });
  project = (await applyEdits(project.root, project.revision, [
    { op: 'update', table: 'offers', key: 'starter', values: { currency: null } },
  ])).project;
  const moved = await history[direction](project.root, project.revision);
  expect(() => readPath(moved.project, 'items/new')).toThrow();
});

it('uses the current revision and shared core lock for row undo/redo', async () => {
  let project = await fixture();
  const history = new ScreenHistory();
  const operations: EditOperation[] = [{ op: 'delete', table: 'offers', key: 'starter' }];
  const written = await applyEdits(project.root, project.revision, operations);
  history.recordCells(written, operations);
  await expect(history.undo(project.root, project.revision)).rejects.toMatchObject({ code: 'STALE_REVISION' });
  project = written.project;
  const lock = join(project.root, '.vibe-spec.lock');
  await writeFile(lock, 'external writer');
  await expect(history.undo(project.root, project.revision)).rejects.toMatchObject({ code: 'PROJECT_LOCKED' });
  expect(await readFile(lock, 'utf8')).toBe('external writer');
  expect((await loadProject(project.root)).sources).toEqual(project.sources);
  expect(history.info()).toEqual({ canUndo: true, canRedo: false });
  await rm(lock);
  project = (await history.undo(project.root, project.revision)).project;
  await expect(history.redo(project.root, written.project.revision)).rejects.toMatchObject({ code: 'STALE_REVISION' });
  await writeFile(lock, 'external writer');
  await expect(history.redo(project.root, project.revision)).rejects.toMatchObject({ code: 'PROJECT_LOCKED' });
  expect((await loadProject(project.root)).sources).toEqual(project.sources);
  expect(history.info()).toEqual({ canUndo: false, canRedo: true });
});

it('records the final state of a mixed batch, including repeated operations on the same row', async () => {
  const original = await fixture();
  const history = new ScreenHistory();
  const operations: EditOperation[] = [
    { op: 'create', table: 'items', row: { code: 'new', name: 'initial' } },
    { op: 'update', table: 'items', key: 'new', values: { name: 'final' } },
    { op: 'update', table: 'offers', key: 'starter', values: { currency: 'new' } },
    { op: 'delete', table: 'offers', key: 'bundle' },
    { op: 'create', table: 'offers', row: { sku: 'bundle', price: '00012.3400' } },
  ];
  const written = await applyEdits(original.root, original.revision, operations);
  history.recordCells(written, operations);
  const undone = await history.undo(original.root, written.project.revision);
  expect(() => readPath(undone.project, 'items/new')).toThrow();
  expect(readPath(undone.project, 'offers/bundle')).toEqual(readPath(original, 'offers/bundle'));
  expect(readPath(undone.project, 'offers/starter')).toEqual(readPath(original, 'offers/starter'));
  expect(history.info()).toEqual({ canUndo: false, canRedo: true });
  const redone = await history.redo(original.root, undone.project.revision);
  expect(readPath(redone.project, 'items/new/name')).toHaveProperty('value', 'final');
  expect(readPath(redone.project, 'offers/bundle')).toEqual({ sku: 'bundle', price: '00012.3400' });
  expect(readPath(redone.project, 'offers/starter/currency')).toHaveProperty('value', 'new');
});

it('does not record a create/delete batch with no row changes and clears redo on a new row edit', async () => {
  const original = await fixture();
  const history = new ScreenHistory();
  const operations: EditOperation[] = [{ op: 'create', table: 'items', row: { code: 'new', name: 'new item' } }];
  const written = await applyEdits(original.root, original.revision, operations);
  history.recordCells(written, operations);
  const undone = await history.undo(original.root, written.project.revision);
  const noop: EditOperation[] = [...operations, { op: 'delete', table: 'items', key: 'new' }];
  const noChange = await applyEdits(original.root, undone.project.revision, noop);
  history.recordCells(noChange, noop);
  expect(history.info()).toEqual({ canUndo: false, canRedo: true });
  history.recordCells(await applyEdits(original.root, noChange.project.revision, operations), operations);
  expect(history.info()).toEqual({ canUndo: true, canRedo: false });
});
