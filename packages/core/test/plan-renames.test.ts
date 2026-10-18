import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { initProject, loadProject } from '../src/project.js';
import { renameResource, applyEdits } from '../src/editing.js';
import { createPlan, writeVariant, getPlan, approvePlan, readVariant } from '../src/plans.js';
import { deletionUsages, whereUsed } from '../src/usage.js';
import { VibeError } from '../src/types.js';
import { validateProject } from '../src/validation.js';
import { readPath } from '../src/project.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-plan-renames-')); folders.push(root);
  await initProject(root);
  await writeFile(join(root, 'schemas/items.yaml'), 'primary_key: key\ncolumns:\n  key:\n    type: string\n  note:\n    type: text\n');
  await writeFile(join(root, 'tables/items.yaml'), 'schema: items\nrows:\n  - key: "gold"\n    note: "gold note"\n');
  await writeFile(join(root, 'schemas/shop.yaml'), 'primary_key: key\ncolumns:\n  key:\n    type: string\n  reward:\n    type: ref\n    table: items\n  note:\n    type: text\n');
  await writeFile(join(root, 'tables/shop.yaml'), 'schema: shop\nrows:\n  - key: "first"\n    reward: "gold"\n    note: "unchanged"\n');
  await writeFile(join(root, 'tables/shop2.yaml'), 'schema: shop\nrows:\n  - key: "other"\n    reward: "gold"\n    note: "other"\n');
  return loadProject(root);
}

it('renames patch addresses, declared references and captures in active and archived plans', async () => {
  let p = await fixture();
  for (const plan of ['live', 'archive']) {
    p = (await createPlan(p.root, p.revision, plan, { title: plan, status: 'review' })).project;
    p = (await writeVariant(p.root, p.revision, plan, 'A', {
      set: { 'items/gold/note': 'gold quoted in prose', 'shop/first/reward': 'gold' },
      add: { ['shop/' + plan]: { reward: 'gold', note: 'gold text' } },
      sources: [{ raw: 'gold', file: 'original' }],
    })).project;
    p = (await writeVariant(p.root, p.revision, plan, 'B', { set: { 'shop2/other/reward': 'gold' } })).project;
  }
  p = (await approvePlan(p.root, p.revision, 'archive', 'B')).project;
  const used = await whereUsed(p, 'items/gold');
  expect(used.references.some(item => item.file === 'plans/live/A.yaml')).toBe(true);
  expect(used.references.some(item => item.file === 'plans/archive/A.yaml')).toBe(true);
  const renamed = await renameResource(p.root, p.revision, 'key', 'items/gold', 'coin'); p = renamed.project;
  expect(renamed.candidates.some(item => item.file === 'plans/live/A.yaml')).toBe(true);
  for (const name of ['live', 'archive']) {
    const patch = getPlan(p, name).variants.A!;
    expect(patch.set).toEqual({ 'items/coin/note': 'gold quoted in prose', 'shop/first/reward': 'coin' });
    expect(patch.add!['shop/' + name]).toEqual({ reward: 'coin', note: 'gold text' });
    expect(patch.base_values['shop/first/reward']).toBe('coin');
    expect(patch.sources).toEqual([{ raw: 'gold', file: 'original' }]);
  }
  p = (await renameResource(p.root, p.revision, 'table', 'items', 'currencies')).project;
  expect(getPlan(p, 'live').variants.A!.set).toHaveProperty('currencies/coin/note', 'gold quoted in prose');
  p = (await renameResource(p.root, p.revision, 'column', 'shop/*/reward', 'item')).project;
  expect(getPlan(p, 'live').variants.A!.set).toHaveProperty('shop/first/item', 'coin');
  expect(getPlan(p, 'archive').variants.B!.set).toHaveProperty('shop2/other/item', 'coin');
  expect(getPlan(p, 'live').variants.A!.add!['shop/live']).toEqual({ item: 'coin', note: 'gold text' });
  expect(validateProject(p).filter(item => item.severity !== 'warning')).toEqual([]);
  expect(readPath(readVariant(p, 'live', 'A'), 'shop/live/item')).toEqual({ present: true, value: 'coin' });
});

it('renames deleted-row snapshots and keeps old-name references detectable after a merge', async () => {
  let p = await fixture();
  p = (await createPlan(p.root, p.revision, 'remove', { title: 'remove', status: 'review' })).project;
  p = (await writeVariant(p.root, p.revision, 'remove', 'A', { remove: ['shop/first'] })).project;
  p = (await renameResource(p.root, p.revision, 'key', 'items/gold', 'coin')).project;
  expect(getPlan(p, 'remove').variants.A!.base_values['shop/first']).toEqual({ key: 'first', reward: 'coin', note: 'unchanged' });
  p = (await renameResource(p.root, p.revision, 'key', 'shop/first', 'renamed')).project;
  expect(getPlan(p, 'remove').variants.A!.remove).toEqual(['shop/renamed']);
  expect(getPlan(p, 'remove').variants.A!.base_values['shop/renamed']).toEqual({ key: 'renamed', reward: 'coin', note: 'unchanged' });
  const file = join(p.root, 'plans/remove/A.yaml');
  const current = await readFile(file, 'utf8');
  await writeFile(file, current.replace('remove:\n  - "shop/renamed"', 'set:\n  shop/renamed/reward: "gold"').replace(/base_values:[\s\S]*$/, 'base_values:\n  shop/renamed/reward: "coin"\nbase_missing: []\n'));
  p = await loadProject(p.root);
  expect(validateProject(p)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REF_MISSING', path: 'shop/renamed/reward' })]));
});

it('reports deleted baseline targets as errors without silently dropping the alternative', async () => {
  let p = await fixture();
  p = (await createPlan(p.root, p.revision, 'note', { title: 'note', status: 'review' })).project;
  p = (await writeVariant(p.root, p.revision, 'note', 'A', { set: { 'items/gold/note': 'alternative' } })).project;
  p = (await applyEdits(p.root, p.revision, [{ op: 'delete', table: 'items', key: 'gold' }])).project;
  expect(validateProject(p)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PATH_NOT_FOUND', path: 'items/gold/note' })]));
  expect(getPlan(p, 'note').variants.A!.set).toEqual({ 'items/gold/note': 'alternative' });
});

it('keeps declared alternative references connected when an unrelated schema rule is broken', async () => {
  let p = await fixture();
  for (const name of ['live', 'archived']) {
    p = (await createPlan(p.root, p.revision, name, { title: name, status: 'review' })).project;
    p = (await writeVariant(p.root, p.revision, name, 'A', { set: { 'shop/first/reward': 'gold' }, add: { 'shop/new': { reward: 'gold' } } })).project;
    if (name === 'archived') {
      p = (await writeVariant(p.root, p.revision, name, 'B', {})).project;
      p = (await approvePlan(p.root, p.revision, name, 'B')).project;
    }
  }
  const schemaPath = join(p.root, 'schemas/shop.yaml');
  const schema = await readFile(schemaPath, 'utf8');
  await writeFile(schemaPath, schema + 'unique:\n  - [missing]\n');
  p = await loadProject(p.root);
  expect((await whereUsed(p, 'items/gold')).references.some(item => item.file === 'plans/live/A.yaml')).toBe(true);
  p = (await renameResource(p.root, p.revision, 'key', 'items/gold', 'coin')).project;
  for (const name of ['live', 'archived']) {
    const patch = getPlan(p, name).variants.A!;
    expect(patch.set!['shop/first/reward']).toBe('coin');
    expect(patch.add!['shop/new']!.reward).toBe('coin');
    expect(patch.base_values['shop/first/reward']).toBe('coin');
  }
  await writeFile(schemaPath, schema);
  expect(validateProject(await loadProject(p.root))).toEqual([]);
});

it('protects references that survive only in a live variant and reports the actual target usage', async () => {
  let p = await fixture();
  p = (await applyEdits(p.root, p.revision, [{ op: 'create', table: 'items', row: { key: 'potion', note: 'potion' } }])).project;
  const schemaPath = join(p.root, 'schemas/shop.yaml');
  await writeFile(schemaPath, (await readFile(schemaPath, 'utf8')).replace('    table: items', '    table: items\n    on_delete: restrict'));
  p = await loadProject(p.root);
  p = (await createPlan(p.root, p.revision, 'live', { title: 'live', status: 'review' })).project;
  p = (await writeVariant(p.root, p.revision, 'live', 'A', { set: { 'shop/first/reward': 'potion' } })).project;
  const revision = p.revision;
  try {
    await applyEdits(p.root, p.revision, [{ op: 'delete', table: 'items', key: 'potion' }]);
    expect.fail('Expected protection from the live alternative');
  } catch (error) {
    expect(error).toBeInstanceOf(VibeError);
    const failure = error as VibeError;
    expect(failure.code).toBe('DELETE_RESTRICTED');
    const used = await deletionUsages(p, failure.diagnostics);
    expect(used.key).toBe('items/potion');
    expect(used.result.references.some(item => item.file === 'plans/live/A.yaml')).toBe(true);
  }
  expect((await loadProject(p.root)).revision).toBe(revision);
  p = (await createPlan(p.root, p.revision, 'remove', { title: 'remove', status: 'review' })).project;
  p = (await writeVariant(p.root, p.revision, 'remove', 'A', { remove: ['items/potion'] })).project;
  await expect(approvePlan(p.root, p.revision, 'remove', 'A')).rejects.toMatchObject({ code: 'DELETE_RESTRICTED' });
  p = (await writeVariant(p.root, p.revision, 'live', 'B', {})).project;
  p = (await approvePlan(p.root, p.revision, 'live', 'B')).project;
  // Archived references are evidence, not a surviving restrictive reference.
  p = (await approvePlan(p.root, p.revision, 'remove', 'A')).project;
  expect(validateProject(p)).toEqual([]);
});

it('finds and renames a Key introduced only by symmetric alternatives without adding it to the baseline', async () => {
  let p = await fixture();
  p = (await createPlan(p.root, p.revision, 'added', { title: 'added', status: 'review' })).project;
  for (const name of ['A', 'B']) p = (await writeVariant(p.root, p.revision, 'added', name, {
    add: { 'items/potion': { note: name } }, set: { 'shop/first/reward': 'potion' },
  })).project;
  const baseline = p.sources.get('tables/items.yaml');
  expect((await whereUsed(p, 'items/potion')).references).toEqual(expect.arrayContaining([
    expect.objectContaining({ file: 'plans/added/A.yaml' }), expect.objectContaining({ file: 'plans/added/B.yaml' }),
  ]));
  p = (await renameResource(p.root, p.revision, 'key', 'items/potion', 'tonic')).project;
  expect(p.sources.get('tables/items.yaml')).toBe(baseline);
  for (const name of ['A', 'B']) {
    const patch = getPlan(p, 'added').variants[name]!;
    expect(patch.add).toEqual({ 'items/tonic': { note: name } });
    expect(patch.set).toEqual({ 'shop/first/reward': 'tonic' });
    expect(patch.base_missing).toEqual(['items/tonic']);
    expect(readPath(readVariant(p, 'added', name), 'items/tonic/note')).toEqual({ present: true, value: name });
  }
  expect(validateProject(p)).toEqual([]);
  await expect(renameResource(p.root, p.revision, 'key', 'items/gold', 'tonic')).rejects.toMatchObject({ code: 'NAME_EXISTS' });
});
