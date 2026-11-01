import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { applyTableWrite, loadProject, parseTableWrite, readPath, ScreenHistory } from '../src/index.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-table-writes-'));
  roots.push(root);
  await cp(fileURLToPath(new URL('./fixtures/project/', import.meta.url)), root, { recursive: true });
  return loadProject(root);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('applies cell, key and column writes for the shown table and records each for undo', async () => {
  let project = await fixture();
  const history = new ScreenHistory();
  project = (await applyTableWrite(project, 'offers', history, { type: 'apply', revision: project.revision,
    operations: [{ op: 'update', table: 'offers', key: 'bundle', values: { count: '7' } }] })).project;
  project = (await applyTableWrite(project, 'offers', history, { type: 'rename', revision: project.revision, key: 'bundle', to: 'pack' })).project;
  project = (await applyTableWrite(project, 'offers', history, { type: 'columnRename', revision: project.revision, column: 'count', to: 'amount' })).project;
  expect(readPath(project, 'offers/pack/amount')).toEqual({ value: '7', present: true });

  for (let step = 0; step < 3; step++) project = (await applyTableWrite(project, 'offers', history, { type: 'undo', revision: project.revision })).project;
  expect(readPath(project, 'offers/bundle/count')).not.toEqual({ value: '7', present: true });
  expect(history.info()).toEqual({ canUndo: false, canRedo: true });
});

it('rejects writes outside the shown table without touching files', async () => {
  const project = await fixture();
  const history = new ScreenHistory();
  await expect(applyTableWrite(project, 'offers', history, { type: 'apply', revision: project.revision,
    operations: [{ op: 'update', table: 'items', key: 'currency_gold', values: { name: 'x' } }] })).rejects.toMatchObject({ code: 'INVALID_EDIT' });
  await expect(applyTableWrite(project, 'offers', history, { type: 'structureEdit', revision: project.revision,
    operation: { op: 'column-delete', table: 'items', column: 'note' } })).rejects.toMatchObject({ code: 'INVALID_EDIT' });
  await expect(applyTableWrite(project, 'offers', history, { type: 'structureEdit', revision: project.revision,
    operation: { op: 'table-delete', table: 'offers' } })).rejects.toMatchObject({ code: 'INVALID_EDIT' });
  expect((await loadProject(project.root)).revision).toBe(project.revision);
  expect(history.info()).toEqual({ canUndo: false, canRedo: false });
});

it('parses untrusted request bodies into table writes', () => {
  expect(parseTableWrite({ type: 'whereUsed', key: 'bundle' })).toBeUndefined();
  expect(parseTableWrite(null)).toBeUndefined();
  expect(parseTableWrite({ type: 'undo', revision: 'r', requestId: 'q' })).toEqual({ type: 'undo', revision: 'r' });
  expect(parseTableWrite({ type: 'rename', revision: 'r', key: 'a', to: 'b', table: 'offers' })).toEqual({ type: 'rename', revision: 'r', key: 'a', to: 'b' });
  expect(() => parseTableWrite({ type: 'apply', revision: 'r', operations: 'x' })).toThrow('Malformed apply');
  expect(() => parseTableWrite({ type: 'columnRename', revision: 'r', column: 'a' })).toThrow('Malformed columnRename');
  expect(() => parseTableWrite({ type: 'redo' })).toThrow('Malformed redo');
});
