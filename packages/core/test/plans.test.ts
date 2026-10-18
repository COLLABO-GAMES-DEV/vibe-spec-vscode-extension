import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEdits } from '../src/editing.js';
import { loadProject, readPath } from '../src/project.js';
import { validateBaseline, validateProject } from '../src/validation.js';
import { approvePlan, createPlan, getPlan, listPlans, readVariant, setPlanStatus, validatePlans, writeVariant } from '../src/plans.js';
import type { Project } from '../src/types.js';
import type { PlanDefinition, VariantInput } from '../src/plan-types.js';

const fixture = fileURLToPath(new URL('./fixtures/project/', import.meta.url));
const roots: string[] = [];
async function project(overrides: Record<string, string> = {}): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'vibe-plans-'));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  for (const [path, source] of Object.entries(overrides)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  return loadProject(root);
}
async function withPlan(overrides: Record<string, string> = {}): Promise<Project> {
  const p = await project(overrides);
  return (await createPlan(p.root, p.revision, 'rates', { title: 'Rates', status: 'draft' })).project;
}
async function variant(p: Project, name: string, input: VariantInput): Promise<Project> {
  return (await writeVariant(p.root, p.revision, 'rates', name, input)).project;
}
const tableText = (name: string) => readFile(join(fixture, 'tables', name + '.yaml'), 'utf8');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('plan storage and independent composition', () => {
  it('supports metadata-only review plans, provenance and freely changing draft/review status', async () => {
    const p = await project();
    const definition = { title: 'Unresolved structure', status: 'review' as const, question: 'Which Key?', sources: [{ page: '원문', span: ['A', 'B'] }] };
    const created = await createPlan(p.root, p.revision, '구조', definition);
    expect(created.changed).toEqual(['plans/구조/_plan.yaml']);
    expect(listPlans(created.project)).toEqual([{ ...definition, name: '구조', variants: [] }]);
    expect(getPlan(created.project, '구조')).toMatchObject({ comparison: [], diagnostics: [], variants: {} });
    expect(validateProject(created.project)).toEqual([]);
    const draft = await setPlanStatus(p.root, created.project.revision, '구조', 'draft');
    const review = await setPlanStatus(p.root, draft.project.revision, '구조', 'review');
    expect(listPlans(review.project)[0]).toMatchObject(definition);
  });

  it('inherits untouched baseline values and retains original captures while capturing new paths', async () => {
    let p = await withPlan();
    p = await variant(p, 'A', { set: { 'offers/bundle/price': '0.5' } });
    p = await variant(p, 'B', { set: { 'offers/bundle/price': '0.8' } });
    const patchSource = p.sources.get('plans/rates/A.yaml');
    const shared = await applyEdits(p.root, p.revision, [{ op: 'update', table: 'offers', key: 'bundle', values: { count: '002', price: '7' } }]);
    p = shared.project;
    for (const [name, price] of [['A', '0.5'], ['B', '0.8']]) {
      const composed = readVariant(p, 'rates', name!);
      expect(readPath(composed, 'offers/bundle/price')).toEqual({ present: true, value: price });
      expect(readPath(composed, 'offers/bundle/count')).toEqual({ present: true, value: '002' });
      expect(composed.revision).toBe(p.revision);
      expect([...composed.sources.keys()].some(path => path.startsWith('plans/'))).toBe(false);
      expect([...composed.files.keys()].some(path => path.startsWith('plans/'))).toBe(false);
      expect(validateProject(composed)).toEqual([]);
    }
    expect(p.sources.get('plans/rates/A.yaml')).toBe(patchSource);
    p = await variant(p, 'A', { set: { 'offers/bundle/price': '0.6', 'offers/bundle/count': '003' } });
    const view = getPlan(p, 'rates');
    expect(view.variants.A!.base_values).toEqual({ 'offers/bundle/price': '+001.2300E+0002', 'offers/bundle/count': '002' });
    expect(view.diagnostics.filter(item => item.code === 'BASE_CHANGED')).toEqual([
      expect.objectContaining({ severity: 'warning', path: 'offers/bundle/price', message: expect.stringContaining('rates/A:') }),
      expect.objectContaining({ severity: 'warning', path: 'offers/bundle/price', message: expect.stringContaining('rates/B:') }),
    ]);
    expect(view.diagnostics[0]!.message).toContain('old={"present":true,"value":"+001.2300E+0002"}');
    expect(view.diagnostics[0]!.message).toContain('current={"present":true,"value":"7"}');
    expect(view.diagnostics[0]!.message).toContain('alternative={"present":true,"value":"0.6"}');
    expect(view.comparison.find(item => item.path === 'offers/bundle/count')).toEqual({
      path: 'offers/bundle/count', baseline: { present: true, value: '002' },
      alternatives: { A: { present: true, value: '003' }, B: { present: true, value: '002' } },
    });
    p = await variant(p, 'A', { set: { 'offers/bundle/count': '004' } });
    expect(getPlan(p, 'rates').variants.A!.base_values).toEqual({ 'offers/bundle/count': '002' });
  });

  it('distinguishes an original null cell from an absent cell even after both change', async () => {
    let p = await withPlan({ 'tables/items.yaml': (await tableText('items')).replace('    note: "001"\n', '') });
    p = await variant(p, 'A', { set: { 'offers/starter/currency': 'currency_gold', 'items/currency_gold/note': 'note' } });
    expect(getPlan(p, 'rates').variants.A).toMatchObject({
      base_values: { 'offers/starter/currency': null }, base_missing: ['items/currency_gold/note'],
    });
    await writeFile(join(p.root, 'tables/offers.yaml'), p.sources.get('tables/offers.yaml')!.replace('    currency: null\n', ''));
    await writeFile(join(p.root, 'tables/items.yaml'), p.sources.get('tables/items.yaml')! + '    note: null\n');
    p = await loadProject(p.root);
    const diagnostics = getPlan(p, 'rates').diagnostics.filter(item => item.code === 'BASE_CHANGED');
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.find(item => item.path === 'offers/starter/currency')!.message)
      .toContain('old={"present":true,"value":null}; current={"present":false,"value":null}');
    expect(diagnostics.find(item => item.path === 'items/currency_gold/note')!.message)
      .toContain('old={"present":false,"value":null}; current={"present":true,"value":null}');
    p = await variant(p, 'A', { set: { 'offers/starter/currency': null, 'items/currency_gold/note': 'edited' } });
    expect(getPlan(p, 'rates').variants.A).toMatchObject({
      base_values: { 'offers/starter/currency': null }, base_missing: ['items/currency_gold/note'],
    });
  });

  it('composes row additions and removals and flattens every schema field for comparison', async () => {
    let p = await withPlan();
    p = await variant(p, 'A', { add: { 'items/new': { name: 'New' } }, remove: ['items/consumable_potion'] });
    p = await variant(p, 'B', {});
    const view = getPlan(p, 'rates');
    expect(view.variants.A!.base_missing).toEqual(['items/new']);
    expect(view.variants.A!.base_values['items/consumable_potion']).toEqual({ code: 'consumable_potion', name: '회복약', kind: 'consumable', note: '첫 줄\n둘째 줄' });
    expect(view.comparison.map(item => item.path)).toEqual([
      'items/consumable_potion/code', 'items/consumable_potion/kind', 'items/consumable_potion/name', 'items/consumable_potion/note',
      'items/new/code', 'items/new/kind', 'items/new/name', 'items/new/note',
    ]);
    expect(view.comparison.find(item => item.path === 'items/new/code')).toMatchObject({
      baseline: { present: false, value: null }, alternatives: { A: { present: true, value: 'new' }, B: { present: false, value: null } },
    });
    expect(view.comparison.find(item => item.path === 'items/new/note')!.alternatives.A).toEqual({ present: false, value: null });
    expect(view.comparison.find(item => item.path === 'items/consumable_potion/name')!.alternatives).toEqual({
      A: { present: false, value: null }, B: { present: true, value: '회복약' },
    });
    const composed = readVariant(p, 'rates', 'A');
    expect(readPath(composed, 'items/new')).toEqual({ code: 'new', name: 'New' });
    expect(() => readPath(composed, 'items/consumable_potion')).toThrow();
    expect(readPath(p, 'items/consumable_potion')).toHaveProperty('name', '회복약');
  });

  it('validates references and uniqueness in each independent alternative without mixing variants', async () => {
    let p = await withPlan();
    p = await variant(p, 'A', { set: { 'offers/bundle/price': '5', 'offers/bundle/currency': 'new' }, add: { 'items/new': { name: 'New' } } });
    p = await variant(p, 'B', { set: { 'offers/starter/price': '5' } });
    expect(validateProject(p)).toEqual([]);
    p = await variant(p, 'B', { set: { 'offers/starter/price': '123', 'offers/bundle/currency': 'new' } });
    const errors = validateProject(p);
    expect(errors).toContainEqual(expect.objectContaining({ code: 'REF_MISSING', path: 'offers/bundle/currency', message: expect.stringContaining('rates/B:') }));
    expect(errors).toContainEqual(expect.objectContaining({ code: 'UNIQUE_VIOLATION', message: expect.stringContaining('rates/B:') }));
    expect(errors.every(error => error.message.startsWith('rates/B:'))).toBe(true);
    const calls: Project[] = [];
    validatePlans(p, composed => { calls.push(composed); return validateBaseline(composed); });
    expect(calls).toHaveLength(2);
    expect(calls.every(composed => composed.revision === p.revision && ![...composed.sources.keys()].some(path => path.startsWith('plans/')))).toBe(true);
  });

  it('keeps baseline diagnostics exactly once when there are no variants', async () => {
    const p = await withPlan({ 'tables/items.yaml': (await tableText('items')).replace('name: "골드"', 'name: null') });
    expect(validateProject(p)).toEqual(validateBaseline(p));
  });

  it('preserves numeric spellings, escaped multiline cells and provenance in YAML', async () => {
    let p = await withPlan();
    const sources = [{ source: 'Sheet', ranges: ['A1', 'B2'], note: 'first\nsecond' }];
    p = await variant(p, 'A', { set: { 'offers/bundle/price': '+00012.340000E-002', 'items/currency_gold/note': 'first\nsecond' }, sources });
    const text = await readFile(join(p.root, 'plans/rates/A.yaml'), 'utf8');
    expect(text).toContain('offers/bundle/price: "+00012.340000E-002"\n');
    expect(text).toContain('items/currency_gold/note: "first\\nsecond"\n');
    expect(getPlan(await loadProject(p.root), 'rates').variants.A).toMatchObject({ sources });
    expect(readPath(readVariant(p, 'rates', 'A'), 'offers/bundle/price')).toEqual({ present: true, value: '+00012.340000E-002' });
  });

  it('changes exactly one physical patch line when a value changes, regardless of input key order', async () => {
    let p = await withPlan();
    p = await variant(p, 'A', { set: { 'offers/bundle/price': '0.5', 'items/currency_gold/note': 'first\nsecond' },
      add: { 'items/new': { name: 'New', note: '001' } } });
    const original = p.sources.get('plans/rates/A.yaml')!;
    const captures = getPlan(p, 'rates').variants.A!.base_values;
    p = await variant(p, 'A', { add: { 'items/new': { note: '001', name: 'New' } },
      set: { 'items/currency_gold/note': 'first\nsecond', 'offers/bundle/price': '0.8' } });
    expect(p.sources.get('plans/rates/A.yaml')).toBe(original.replace('offers/bundle/price: "0.5"', 'offers/bundle/price: "0.8"'));
    expect(getPlan(p, 'rates').variants.A!.base_values).toEqual(captures);
  });

  it('retains deleted-row captures and reports row changes or disappearance instead of dropping the patch', async () => {
    let p = await withPlan();
    p = await variant(p, 'A', { remove: ['items/consumable_potion'] });
    const capture = getPlan(p, 'rates').variants.A!.base_values['items/consumable_potion'];
    p = (await applyEdits(p.root, p.revision, [{ op: 'update', table: 'items', key: 'consumable_potion', values: { name: 'Current' } }])).project;
    p = await variant(p, 'A', { remove: ['items/consumable_potion'], sources: ['edited provenance'] });
    expect(getPlan(p, 'rates').variants.A!.base_values['items/consumable_potion']).toEqual(capture);
    expect(validateProject(p)).toEqual([expect.objectContaining({ code: 'BASE_CHANGED', severity: 'warning', path: 'items/consumable_potion' })]);
    p = (await applyEdits(p.root, p.revision, [{ op: 'delete', table: 'items', key: 'consumable_potion' }])).project;
    expect(validateProject(p)).toContainEqual(expect.objectContaining({ code: 'PATH_NOT_FOUND', path: 'items/consumable_potion' }));
    expect(() => readVariant(p, 'rates', 'A')).toThrow(expect.objectContaining({ code: 'PATH_NOT_FOUND' }));
  });
});

describe('source metadata types', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  it.each([
    ['numeric row', [{ row: 12, coords: ['0', '3'] }], 'sources/0/row'],
    ['numeric coordinate', [{ row: '12', coords: ['0', 3] }], 'sources/0/coords/1'],
    ['NaN', [NaN], 'sources/0'],
    ['infinity', [Infinity], 'sources/0'],
    ['undefined property', [{ row: undefined }], 'sources/0/row'],
    ['undefined array item', [undefined], 'sources/0'],
    ['undefined sources', undefined, 'sources'],
    ['function', [{ row: () => '12' }], 'sources/0/row'],
    ['bigint', [12n], 'sources/0'],
    ['symbol', [Symbol('row')], 'sources/0'],
    ['date', [new Date('2026-01-01T00:00:00Z')], 'sources/0'],
    ['map', [new Map([['row', '12']])], 'sources/0'],
    ['set', [new Set(['12'])], 'sources/0'],
    ['regular expression', [/12/], 'sources/0'],
    ['cycle', [cycle], 'sources/0/self'],
    ['sparse array', [new Array(1)], 'sources/0/0'],
    ['custom serializer', [{ toJSON: () => ({ row: 12 }) }], 'sources/0/toJSON'],
    ['symbol property', [{ [Symbol('row')]: '12' }], 'sources/0/Symbol(row)'],
    ['nonenumerable property', [Object.defineProperty({}, 'row', { value: '12' })], 'sources/0/row'],
    ['getter', [Object.defineProperty({}, 'row', { enumerable: true, get: () => '12' })], 'sources/0/row'],
    ['extra array property', [Object.assign(['12'], { row: '12' })], 'sources/0/row'],
  ] as const)('rejects %s in createPlan and writeVariant without changing disk', async (_label, sources, path) => {
    const p = await withPlan();
    const error = { code: 'PLAN_SOURCE_TYPE', message: expect.stringContaining(path),
      diagnostics: [expect.objectContaining({ code: 'PLAN_SOURCE_TYPE', path, message: expect.stringContaining('quote numeric metadata and coordinates') })] };
    await expect(createPlan(p.root, p.revision, 'invalid', {
      title: 'Invalid', status: 'draft', sources: sources as unknown as unknown[],
    })).rejects.toMatchObject(error);
    let disk = await loadProject(p.root);
    expect(disk.revision).toBe(p.revision);
    expect(disk.sources).toEqual(p.sources);
    await expect(writeVariant(p.root, p.revision, 'rates', 'A', {
      set: { 'offers/bundle/price': '0.5' }, sources: sources as unknown as unknown[],
    })).rejects.toMatchObject(error);
    disk = await loadProject(p.root);
    expect(disk.revision).toBe(p.revision);
    expect(disk.sources).toEqual(p.sources);
  });

  it.each(['12', '0.3', '-0', '1e3', '0x10', '.inf', '.nan'])('rejects bare stored numeric source %s in metadata and patches', async number => {
    const p = await project({
      'plans/metadata/_plan.yaml': 'title: "Metadata"\nstatus: "review"\nsources:\n  - row: ' + number + '\n',
      'plans/patch/_plan.yaml': 'title: "Patch"\nstatus: "draft"\n',
      'plans/patch/A.yaml': 'set: {}\nbase_values: {}\nbase_missing: []\nsources:\n  - coords: ["0", ' + number + ']\n',
    });
    expect(validateProject(p)).toEqual([
      expect.objectContaining({ code: 'PLAN_SOURCE_TYPE', file: 'plans/metadata/_plan.yaml', path: 'sources/0/row', message: expect.stringContaining('metadata:') }),
      expect.objectContaining({ code: 'PLAN_SOURCE_TYPE', file: 'plans/patch/A.yaml', path: 'sources/0/coords/1', message: expect.stringContaining('patch/A:') }),
    ]);
    await expect(setPlanStatus(p.root, p.revision, 'metadata', 'draft')).rejects.toMatchObject({ code: 'PLAN_SOURCE_TYPE' });
    await expect(approvePlan(p.root, p.revision, 'patch', 'A')).rejects.toMatchObject({ code: 'PLAN_SOURCE_TYPE' });
    expect((await loadProject(p.root)).sources).toEqual(p.sources);
  });

  it('round-trips quoted coordinates and every supported JSON-like source value', async () => {
    let p = await project();
    const shared = { row: '12', coords: ['0', '3'], nested: { enabled: true, omitted: null, values: ['001', false, [], {}] } };
    const sources = [shared, 'sheet', true, false, null, [], {}, Object.assign(Object.create(null) as Record<string, string>, { row: '0' }), shared];
    p = (await createPlan(p.root, p.revision, 'rates', { title: 'Sources', status: 'review', sources })).project;
    p = await variant(p, 'A', { set: { 'offers/bundle/price': '0.5' }, sources });
    const view = getPlan(await loadProject(p.root), 'rates');
    expect(view.plan.sources).toEqual(sources);
    expect(view.variants.A!.sources).toEqual(sources);
    expect(validateProject(p)).toEqual([]);
    for (const file of ['plans/rates/_plan.yaml', 'plans/rates/A.yaml']) {
      const source = await readFile(join(p.root, file), 'utf8');
      expect(source).toContain('row: "12"');
      expect(source).toContain('- "0"');
      expect(source).toContain('- "3"');
    }
  });
});

describe('structural checks and concurrency', () => {
  it('previews create, patch, status and approval with unchanged disk bytes and revision', async () => {
    let p = await project();
    const unchanged = async () => {
      const disk = await loadProject(p.root);
      expect(disk.revision).toBe(p.revision);
      expect(disk.sources).toEqual(p.sources);
    };
    const definition = { title: 'Preview', status: 'draft' as const };
    const create = await createPlan(p.root, p.revision, 'rates', definition, { dryRun: true });
    expect(create.changed).toEqual(['plans/rates/_plan.yaml']);
    expect(listPlans(create.planned)).toEqual([{ ...definition, name: 'rates', variants: [] }]);
    expect(create.project.revision).toBe(p.revision);
    await unchanged();
    p = (await createPlan(p.root, p.revision, 'rates', definition)).project;
    const input = { set: { 'offers/bundle/price': '0.5' } };
    const patch = await writeVariant(p.root, p.revision, 'rates', 'A', input, { dryRun: true });
    expect(patch.changed).toEqual(['plans/rates/A.yaml']);
    expect(readPath(readVariant(patch.planned, 'rates', 'A'), 'offers/bundle/price')).toEqual({ present: true, value: '0.5' });
    await unchanged();
    p = await variant(p, 'A', input);
    const status = await setPlanStatus(p.root, p.revision, 'rates', 'review', { dryRun: true });
    expect(getPlan(status.planned, 'rates').plan.status).toBe('review');
    await unchanged();
    const approve = await approvePlan(p.root, p.revision, 'rates', 'A', { dryRun: true });
    expect(approve.changed).toEqual(['tables/offers.yaml', 'plans/rates/_plan.yaml']);
    expect(getPlan(approve.planned, 'rates').plan).toMatchObject({ status: 'approved', selected: 'A' });
    expect(readPath(approve.planned, 'offers/bundle/price')).toEqual({ present: true, value: '0.5' });
    expect(readPath(approve.project, 'offers/bundle/price')).toEqual({ present: true, value: '+001.2300E+0002' });
    await unchanged();
  });

  it.each(['_plan', '_PLAN', 'CON', 'x/y', 'trailing.', 'x\\y', ''])('rejects nonportable or reserved name %j', async name => {
    const p = await withPlan();
    await expect(createPlan(p.root, p.revision, name, { title: 'Title', status: 'draft' })).rejects.toMatchObject({ code: 'NAME_INVALID' });
    await expect(writeVariant(p.root, p.revision, 'rates', name, {})).rejects.toMatchObject({ code: 'NAME_INVALID' });
    expect((await loadProject(p.root)).revision).toBe(p.revision);
  });

  it('uses Unicode case folding for plan and variant collisions', async () => {
    let p = await withPlan();
    await expect(createPlan(p.root, p.revision, 'RATES', { title: 'Other', status: 'draft' })).rejects.toMatchObject({ code: 'NAME_EXISTS' });
    p = await variant(p, 'Straße', {});
    await expect(writeVariant(p.root, p.revision, 'rates', 'STRASSE', {})).rejects.toMatchObject({ code: 'NAME_EXISTS' });
  });

  it.each([
    [{ set: { 'items/currency_gold/code': 'renamed' } }, 'RENAME_REQUIRED'],
    [{ add: { 'items/new': { code: 'new', name: 'New' } } }, 'RENAME_REQUIRED'],
    [{ add: { 'items/new': { name: 'New' } }, set: { 'items/new/name': 'Changed' } }, 'VARIANT_CONFLICT'],
    [{ remove: ['items/consumable_potion'], set: { 'items/consumable_potion/name': 'Changed' } }, 'VARIANT_CONFLICT'],
    [{ add: { 'items/new': {} }, remove: ['items/new'] }, 'VARIANT_CONFLICT'],
    [{ remove: ['items/consumable_potion', 'items/consumable_potion'] }, 'VARIANT_CONFLICT'],
    [{ set: { 'items/missing/name': 'Missing' } }, 'PATH_NOT_FOUND'],
    [{ remove: ['items/missing'] }, 'PATH_NOT_FOUND'],
    [{ set: { 'items/currency_gold/missing': 'Missing' } }, 'PATH_NOT_FOUND'],
    [{ set: { 'missing/row/column': 'Missing' } }, 'PATH_NOT_FOUND'],
    [{ set: { 'items/*/name': 'Invalid' } }, 'PATH_INVALID'],
    [{ remove: ['items/currency_gold'] }, 'DELETE_RESTRICTED'],
    [{ add: { 'items/currency_gold': { name: 'Duplicate' } } }, 'NAME_EXISTS'],
  ] satisfies [VariantInput, string][])('rejects invalid patch %j with %s before writing', async (input, code) => {
    const p = await withPlan();
    await expect(variant(p, 'A', input)).rejects.toMatchObject({ code });
    expect((await loadProject(p.root)).revision).toBe(p.revision);
  });

  it('allows a batch to clear references and delete their target together', async () => {
    let p = await withPlan();
    p = await variant(p, 'A', { set: { 'offers/bundle/currency': null }, remove: ['items/currency_gold'] });
    expect(validateProject(p)).toEqual([]);
    expect(readPath(readVariant(p, 'rates', 'A'), 'offers/bundle/currency')).toEqual({ present: true, value: null });
  });

  it.each(['row', 'schema', 'column'] as const)('reports a disappeared %s at its original target path', async kind => {
    let p = await withPlan();
    p = await variant(p, 'A', { set: { 'items/consumable_potion/name': 'Alternative' } });
    if (kind === 'schema') await rm(join(p.root, 'schemas/items.yaml'));
    else if (kind === 'row') {
      const changed = await applyEdits(p.root, p.revision, [{ op: 'delete', table: 'items', key: 'consumable_potion' }]);
      p = changed.project;
    } else await writeFile(join(p.root, 'schemas/items.yaml'), p.sources.get('schemas/items.yaml')!.replace('  name:\n    type: text\n    required: true\n', ''));
    p = await loadProject(p.root);
    expect(() => readVariant(p, 'rates', 'A')).toThrow(expect.objectContaining({ code: 'PATH_NOT_FOUND' }));
    expect(validateProject(p)).toContainEqual(expect.objectContaining({ code: 'PATH_NOT_FOUND', path: 'items/consumable_potion/name', message: expect.stringContaining('rates/A:') }));
    await expect(approvePlan(p.root, p.revision, 'rates', 'A')).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' });
  });

  it('rejects every stale plan mutation after an external patch edit', async () => {
    let p = await withPlan();
    p = await variant(p, 'A', { set: { 'offers/bundle/price': '5' } });
    const file = join(p.root, 'plans/rates/A.yaml');
    const external = p.sources.get('plans/rates/A.yaml')! + '# another writer\n';
    await writeFile(file, external);
    for (const action of [
      () => createPlan(p.root, p.revision, 'other', { title: 'Other', status: 'draft' }),
      () => writeVariant(p.root, p.revision, 'rates', 'A', {}),
      () => setPlanStatus(p.root, p.revision, 'rates', 'review'),
      () => approvePlan(p.root, p.revision, 'rates', 'A'),
    ]) await expect(action()).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(await readFile(file, 'utf8')).toBe(external);
    expect(readPath(await loadProject(p.root), 'offers/bundle/price')).toEqual({ present: true, value: '+001.2300E+0002' });
  });
});

describe('approval and archive', () => {
  it.each([
    { title: 'Bypass', status: 'approved' },
    { title: 'Bypass', status: 'approved', selected: 'A' },
    { title: 'Bypass', status: 'draft', selected: 'A' },
    { title: 'Bypass', status: 'review', selected: 'A' },
  ] satisfies PlanDefinition[])('requires approval to select and archive a new plan: %j', async definition => {
    const p = await project();
    await expect(createPlan(p.root, p.revision, 'invalid', definition)).rejects.toMatchObject({ code: 'PLAN_SHAPE' });
    expect((await loadProject(p.root)).revision).toBe(p.revision);
  });

  it.each([
    { title: 'Invalid', status: 'approved' },
    { title: 'Invalid', status: 'approved', selected: 'missing' },
    { title: 'Invalid', status: 'draft', selected: 'A' },
    { title: 'Invalid', status: 'review', selected: 'A' },
  ] satisfies PlanDefinition[])('diagnoses inconsistent stored approval metadata: %j', async definition => {
    const p = await project({ 'plans/invalid/_plan.yaml': JSON.stringify(definition) });
    expect(validateProject(p)).toEqual([expect.objectContaining({ code: 'PLAN_SHAPE', path: 'selected', message: expect.stringContaining('invalid:') })]);
    expect(() => getPlan(p, 'invalid')).toThrow(expect.objectContaining({ code: 'PLAN_SHAPE' }));
  });

  it('merges the chosen alternative, preserves every patch and makes the archive immutable', async () => {
    let p = await withPlan();
    p = await variant(p, 'A', { add: { 'items/new': { name: 'New' } }, remove: ['items/consumable_potion'], set: { 'offers/bundle/price': '5' } });
    p = await variant(p, 'B', { set: { 'items/consumable_potion/name': 'Another' } });
    const patches = ['plans/rates/A.yaml', 'plans/rates/B.yaml'].map(file => [file, p.sources.get(file)] as const);
    const approved = await approvePlan(p.root, p.revision, 'rates', 'A');
    p = approved.project;
    expect(approved.changed.sort()).toEqual(['plans/rates/_plan.yaml', 'tables/items.yaml', 'tables/offers.yaml']);
    expect(validateProject(p)).toEqual([]);
    expect(readPath(p, 'items/new')).toEqual({ code: 'new', name: 'New' });
    expect(readPath(p, 'offers/bundle/price')).toEqual({ present: true, value: '5' });
    for (const [file, source] of patches) expect(p.sources.get(file)).toBe(source);
    expect(getPlan(p, 'rates')).toMatchObject({ plan: { status: 'approved', selected: 'A', variants: ['A', 'B'] }, diagnostics: [] });
    expect(() => readVariant(p, 'rates', 'A')).toThrow(expect.objectContaining({ code: 'ARCHIVED_PLAN', message: expect.stringContaining('Git') }));
    await expect(writeVariant(p.root, p.revision, 'rates', 'A', {})).rejects.toMatchObject({ code: 'ARCHIVED_PLAN' });
    await expect(setPlanStatus(p.root, p.revision, 'rates', 'draft')).rejects.toMatchObject({ code: 'ARCHIVED_PLAN' });
    await expect(approvePlan(p.root, p.revision, 'rates', 'B')).rejects.toMatchObject({ code: 'ARCHIVED_PLAN' });
    const changed = await applyEdits(p.root, p.revision, [{ op: 'delete', table: 'items', key: 'new' }]);
    expect(validateProject(changed.project)).toEqual([]);
    expect(getPlan(changed.project, 'rates').comparison.find(item => item.path === 'items/new/name')).toMatchObject({
      baseline: { present: false, value: null }, alternatives: { A: { present: true, value: 'New' } },
    });
  });

  it('approves an empty variant and does not impose a draft-to-review workflow', async () => {
    let p = await withPlan();
    p = await variant(p, 'A', {});
    expect(readVariant(p, 'rates', 'A').sources.get('tables/items.yaml')).toBe(p.sources.get('tables/items.yaml'));
    const result = await approvePlan(p.root, p.revision, 'rates', 'A');
    expect(result.changed).toEqual(['plans/rates/_plan.yaml']);
  });

  it('allows normal schema validation errors during approval and returns them as diagnostics', async () => {
    let p = await withPlan();
    p = await variant(p, 'A', { set: { 'items/currency_gold/name': null, 'offers/bundle/price': '0' } });
    const result = await approvePlan(p.root, p.revision, 'rates', 'A');
    expect(getPlan(result.project, 'rates').plan.status).toBe('approved');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: 'items/currency_gold/name' }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNIQUE_VIOLATION' }));
    expect(readPath(result.project, 'items/currency_gold/name')).toEqual({ present: true, value: null });
  });

  it('still reports malformed archived patch syntax without composing against the changed baseline', async () => {
    let p = await withPlan();
    p = await variant(p, 'A', {});
    p = (await approvePlan(p.root, p.revision, 'rates', 'A')).project;
    await writeFile(join(p.root, 'plans/rates/A.yaml'), 'set:\n  items/old/name: [invalid]\nbase_values: {}\nbase_missing: []\n');
    p = await loadProject(p.root);
    expect(validateProject(p)).toEqual([expect.objectContaining({ code: 'VARIANT_SHAPE', file: 'plans/rates/A.yaml', message: expect.stringContaining('rates/A:') })]);
    expect(getPlan(p, 'rates').diagnostics).toContainEqual(expect.objectContaining({ code: 'VARIANT_SHAPE' }));
  });
});
