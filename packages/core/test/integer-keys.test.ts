import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyEdits, renameResource } from '../src/editing.js';
import { ScreenHistory } from '../src/history.js';
import { approvePlan, createPlan, getPlan, readVariant, writeVariant } from '../src/plans.js';
import { formattedSources, initProject, loadProject, readPath, writeChanges } from '../src/project.js';
import type { EditOperation, Project, Table } from '../src/types.js';
import { whereUsed } from '../src/usage.js';
import { validateProject } from '../src/validation.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(keys = ['10', '2', '1'], type = 'integer') {
  const root = await mkdtemp(join(tmpdir(), 'vibe-integer-keys-')); roots.push(root);
  await initProject(root);
  await writeFile(join(root, 'schemas/levels.yaml'), `primary_key: level\ncolumns:\n  level:\n    type: ${type}\n  note:\n    type: text\n`);
  await writeFile(join(root, 'tables/levels.yaml'), 'schema: "levels"\nrows:\n' + keys.map(key => `  - level: ${JSON.stringify(key)}\n    note: ${JSON.stringify('Level ' + key)}\n`).join(''));
  await writeFile(join(root, 'schemas/quests.yaml'), 'primary_key: key\ncolumns:\n  key:\n    type: string\n  level:\n    type: ref\n    table: levels\n    on_delete: restrict\n');
  await writeFile(join(root, 'tables/quests.yaml'), 'schema: quests\nrows:\n  - key: "first"\n    level: "1"\n');
  await mkdir(join(root, 'documents'));
  await writeFile(join(root, 'documents/guide.md'), '# Levels\n\n[Row](levels/1) and [cell](levels/1/note). Level 1 stays prose.\n');
  return loadProject(root);
}
function keys(project: Project) {
  return (readPath(project, 'levels') as { table: Table }).table.rows.map(row => row.level);
}

it.each(['integer', 'string', 'text'])('preserves source row order through read, fmt, edit, append and rename for %s Keys', async type => {
  let p = await fixture(undefined, type);
  expect(validateProject(p)).toEqual([]);
  const original = await readFile(join(p.root, 'tables/levels.yaml'), 'utf8');
  expect(keys(p)).toEqual(['10', '2', '1']);
  expect(readPath(p, 'levels/1')).toEqual({ level: '1', note: 'Level 1' });
  expect(formattedSources(p).get('tables/levels.yaml')).toBe(original);
  await writeChanges(p, formattedSources(p));
  p = await loadProject(p.root);
  p = (await applyEdits(p.root, p.revision, [{ op: 'update', table: 'levels', key: '2', values: { note: 'Edited' } }])).project;
  expect(await readFile(join(p.root, 'tables/levels.yaml'), 'utf8')).toBe(original.replace('Level 2', 'Edited'));
  p = (await applyEdits(p.root, p.revision, [{ op: 'create', table: 'levels', row: { level: '0', note: 'Appended' } }])).project;
  expect(keys(p)).toEqual(['10', '2', '1', '0']);
  p = (await renameResource(p.root, p.revision, 'key', 'levels/2', '20')).project;
  expect(keys(p)).toEqual(['10', '20', '1', '0']);
  expect(formattedSources(p).get('tables/levels.yaml')).toBe(p.sources.get('tables/levels.yaml'));
  expect(validateProject(p)).toEqual([]);
});

it.each(['1.0', '1e0', '1E+2', '.1', ' 1', '1 ', 'one'])('reports strict integer Key grammar for %j without rewriting it', async invalid => {
  const p = await fixture(['10', invalid, '1']);
  expect(validateProject(p)).toEqual(expect.arrayContaining([expect.objectContaining({
    code: 'VALUE_TYPE_OR_RANGE', file: 'tables/levels.yaml', path: 'levels/' + invalid + '/level',
  })]));
  expect(keys(p)).toEqual(['10', invalid, '1']);
  expect(formattedSources(p).get('tables/levels.yaml')).toBe(p.sources.get('tables/levels.yaml'));
});

it('keeps original integer spellings as distinct identities and matches references exactly outside import', async () => {
  let p = await fixture(['001', '1', '+1', '-0', '0', '900719925474099312345']);
  expect(validateProject(p)).toEqual([]);
  const original = p.sources.get('tables/levels.yaml');
  expect(formattedSources(p).get('tables/levels.yaml')).toBe(original);
  expect(readPath(p, 'levels/001/note')).toEqual({ present: true, value: 'Level 001' });
  expect(readPath(p, 'levels/1/note')).toEqual({ present: true, value: 'Level 1' });
  expect((await whereUsed(p, 'levels/001')).references).toEqual([]);
  expect((await whereUsed(p, 'levels/1')).references).toEqual(expect.arrayContaining([
    expect.objectContaining({ file: 'tables/quests.yaml', path: 'quests/first/level' }),
    expect.objectContaining({ file: 'documents/guide.md' }),
  ]));
  await expect(applyEdits(p.root, p.revision, [{ op: 'delete', table: 'levels', key: '1' }]))
    .rejects.toMatchObject({ code: 'DELETE_RESTRICTED' });
  expect((await loadProject(p.root)).revision).toBe(p.revision);
  p = (await renameResource(p.root, p.revision, 'key', 'levels/001', '0001')).project;
  expect(readPath(p, 'quests/first/level')).toEqual({ present: true, value: '1' });
  expect(keys(p)).toEqual(['0001', '1', '+1', '-0', '0', '900719925474099312345']);
  p = (await applyEdits(p.root, p.revision, [{ op: 'delete', table: 'levels', key: '0001' }])).project;
  expect(validateProject(p)).toEqual([]);
  // A numerically equal Key does not satisfy a missing raw-string reference.
  p = (await applyEdits(p.root, p.revision, [{ op: 'update', table: 'quests', key: 'first', values: { level: '01' } }])).project;
  expect(validateProject(p)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REF_MISSING', path: 'quests/first/level' })]));
});

it('renames integer paths, refs, document links and active/archived A/B captures, then composes in source order', async () => {
  let p = await fixture();
  for (const plan of ['live', 'archive']) {
    p = (await createPlan(p.root, p.revision, plan, { title: plan, status: 'review' })).project;
    for (const variant of ['A', 'B']) {
      p = (await writeVariant(p.root, p.revision, plan, variant, {
        set: { 'levels/1/note': variant + ' Level 1', 'quests/first/level': '1' },
        ...(plan === 'live' ? { add: { 'levels/0': { note: 'Added 1' }, 'quests/live': { level: '1' } } } : {}),
        sources: [{ raw: '1', path: 'levels/1' }],
      })).project;
    }
  }
  p = (await approvePlan(p.root, p.revision, 'archive', 'B')).project;
  expect(getPlan(p, 'archive').plan.status).toBe('approved');
  const used = await whereUsed(p, 'levels/1');
  for (const plan of ['live', 'archive']) for (const variant of ['A', 'B']) {
    expect(used.references).toEqual(expect.arrayContaining([expect.objectContaining({ file: `plans/${plan}/${variant}.yaml` })]));
  }
  p = (await renameResource(p.root, p.revision, 'key', 'levels/1', '3')).project;
  expect(keys(p)).toEqual(['10', '2', '3']);
  expect(readPath(p, 'quests/first/level')).toEqual({ present: true, value: '3' });
  expect(await readFile(join(p.root, 'documents/guide.md'), 'utf8'))
    .toBe('# Levels\n\n[Row](levels/3) and [cell](levels/3/note). Level 1 stays prose.\n');
  for (const plan of ['live', 'archive']) for (const variant of ['A', 'B']) {
    const patch = getPlan(p, plan).variants[variant]!;
    expect(patch.set).toEqual({ 'levels/3/note': variant + ' Level 1', 'quests/first/level': '3' });
    if (plan === 'live') expect(patch.add!['quests/live']).toEqual({ level: '3' });
    expect(patch.base_values['levels/3/note']).toBe('Level 1');
    expect(patch.base_values['quests/first/level']).toBe('3');
    expect(patch.base_values).not.toHaveProperty('levels/1/note');
    expect(patch.sources).toEqual([{ raw: '1', path: 'levels/1' }]);
    if (plan === 'live') {
      const composed = readVariant(p, plan, variant);
      expect(keys(composed)).toEqual(['10', '2', '3', '0']);
      expect(readPath(composed, 'levels/3/note')).toEqual({ present: true, value: variant + ' Level 1' });
      expect(readPath(composed, 'quests/live/level')).toEqual({ present: true, value: '3' });
    }
  }
  expect(validateProject(p).filter(item => item.severity !== 'warning')).toEqual([]);
});

it('renames integer remove addresses and captured row Keys in active and archived alternatives', async () => {
  let p = await fixture();
  for (const plan of ['live', 'archive']) {
    p = (await createPlan(p.root, p.revision, plan, { title: plan, status: 'review' })).project;
    p = (await writeVariant(p.root, p.revision, plan, 'A', { remove: ['levels/2'] })).project;
    p = (await writeVariant(p.root, p.revision, plan, 'B', {})).project;
  }
  p = (await approvePlan(p.root, p.revision, 'archive', 'B')).project;
  p = (await renameResource(p.root, p.revision, 'key', 'levels/2', '20')).project;
  expect(keys(p)).toEqual(['10', '20', '1']);
  for (const plan of ['live', 'archive']) {
    const patch = getPlan(p, plan).variants.A!;
    expect(patch.remove).toEqual(['levels/20']);
    expect(patch.base_values).toEqual({ 'levels/20': { level: '20', note: 'Level 2' } });
  }
  expect(keys(readVariant(p, 'live', 'A'))).toEqual(['10', '1']);
  expect(keys(readVariant(p, 'live', 'B'))).toEqual(['10', '20', '1']);
  expect(validateProject(p)).toEqual([]);
});

it.each([false, true])('restores a deleted integer row in source order through undo/redo (external rows: %s)', async external => {
  let p = await fixture();
  const history = new ScreenHistory();
  const operations: EditOperation[] = [{ op: 'delete', table: 'levels', key: '2' }];
  const deleted = await applyEdits(p.root, p.revision, operations);
  history.recordCells(deleted, operations);
  p = deleted.project;
  expect(keys(p)).toEqual(['10', '1']);
  if (external) {
    const file = join(p.root, 'tables/levels.yaml');
    const source = (await readFile(file, 'utf8')).replace('  - level: "1"', '  - level: "0"\n    note: "External before successor"\n  - level: "1"');
    await writeFile(file, source + '  - level: "-1"\n    note: "External tail"\n');
    p = await loadProject(p.root);
    expect(keys(p)).toEqual(['10', '0', '1', '-1']);
  }
  p = (await history.undo(p.root, p.revision)).project;
  expect(keys(p)).toEqual(external ? ['10', '0', '2', '1', '-1'] : ['10', '2', '1']);
  expect(readPath(p, 'levels/2')).toEqual({ level: '2', note: 'Level 2' });
  expect(history.info()).toEqual({ canUndo: false, canRedo: true });
  p = (await history.redo(p.root, p.revision)).project;
  expect(keys(p)).toEqual(external ? ['10', '0', '1', '-1'] : ['10', '1']);
  expect(history.info()).toEqual({ canUndo: true, canRedo: false });
  if (external) {
    expect(readPath(p, 'levels/0/note')).toEqual({ present: true, value: 'External before successor' });
    expect(readPath(p, 'levels/-1/note')).toEqual({ present: true, value: 'External tail' });
  }
  expect(validateProject(p)).toEqual([]);
});
