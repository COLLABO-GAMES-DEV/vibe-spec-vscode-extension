import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic, ImportPlan, PlanSummary, PlanView } from '@vibe-spec/core';
import { afterEach, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../core/test/fixtures/project/', import.meta.url));
const roots: string[] = [];
interface Reply<T = unknown> {
  ok: boolean;
  revision: string | null;
  target?: string;
  data: T;
  diagnostics: Diagnostic[];
  error?: { code: string; message: string };
}
interface Preview {
  applied: false;
  changed: string[];
  planned: string[];
  preview: Record<string, string | null>;
  candidates: unknown[];
}
function cli<T = unknown>(root: string, args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return { status: result.status, reply: JSON.parse(result.stdout) as Reply<T> };
}
async function setup(existing = true) {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-cli-plans-'));
  roots.push(directory);
  const root = join(directory, 'planning');
  expect(cli(directory, ['init', root]).status).toBe(0);
  if (existing) await cp(fixture, root, { recursive: true });
  return { root, directory };
}
function revision(root: string) {
  const value = cli(root, ['validate']).reply.revision;
  expect(value).toMatch(/^[a-f0-9]{64}$/);
  return value!;
}
async function input(directory: string, value: unknown) {
  const file = join(directory, 'input.json');
  // The same BOM accepted by baseline writes must work for plan JSON too.
  await writeFile(file, '\uFEFF' + JSON.stringify(value));
  return file;
}
async function write(root: string, directory: string, command: string[], value: unknown, expected = revision(root)) {
  return cli(root, [...command, '--input', await input(directory, value), '--expect-revision', expected]);
}
async function create(root: string, directory: string, name = 'prices') {
  const result = await write(root, directory, ['plan', 'create', name], { title: 'Price review', status: 'review' });
  expect(result).toMatchObject({ status: 0, reply: { target: name, data: { applied: true } } });
  return result;
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isDirectory()) {
      for (const [path, source] of Object.entries(await snapshot(join(root, item.name)))) files[item.name + '/' + path] = source;
    } else files[item.name] = await readFile(join(root, item.name), 'utf8');
  }
  return files;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// A workflow launches many separate CLI processes, including dry-runs and reads.
describe('plans through actual CLI processes', { timeout: process.platform === 'win32' ? 120_000 : 60_000 }, () => {
  it('creates symmetric alternatives, inherits baseline edits, warns on drift and approves with original provenance', async () => {
    const { root, directory } = await setup();
    const pricePath = 'offers/bundle/price';
    const baseline = '+001.2300E+0002';
    const a = '+000.1234567890123456789012345678900E+0002', b = '00042.0000';
    const sourceA = { file: '/original/prices.csv', sourceHash: 'a'.repeat(64), sheet: 'prices', cell: 'D3', raw: a };
    const sourceB = { file: '/original/notion.zip', sourceHash: 'b'.repeat(64), page: 'page-id', path: 'DB_all/prices.csv', raw: b };
    const sources = [sourceA, sourceB];
    const before = await readFile(join(root, 'tables/offers.yaml'), 'utf8');
    expect(await write(root, directory, ['plan', 'create', 'prices'], {
      title: 'Price review', status: 'review', question: 'Which original price?', sources,
    })).toMatchObject({ status: 0, reply: { target: 'prices', data: { applied: true } } });
    for (const [variant, value, source] of [['A', a, sourceA], ['B', b, sourceB]] as const) {
      expect(await write(root, directory, ['plan', 'variant', 'prices/' + variant], {
        set: { [pricePath]: value }, sources: [source],
      })).toMatchObject({ status: 0, reply: { target: 'prices/' + variant, data: { applied: true } } });
      expect(cli(root, ['read', pricePath, '--target', 'prices/' + variant]))
        .toMatchObject({ status: 0, reply: { target: 'prices/' + variant, data: { present: true, value } } });
    }
    expect(await readFile(join(root, 'tables/offers.yaml'), 'utf8')).toBe(before);
    expect(cli(root, ['read', pricePath, '--target', 'base']).reply).toMatchObject({ target: 'base', data: { value: baseline } });
    const plain = spawnSync(process.execPath, [entry, 'read', pricePath, '--target', 'prices/A'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('Target: prices/A\n');
    expect(plain.stdout).toContain(a);
    expect(cli<PlanSummary[]>(root, ['plan', 'list']).reply.data).toMatchObject([
      { name: 'prices', status: 'review', sources, variants: ['A', 'B'] },
    ]);
    const view = cli<PlanView>(root, ['plan', 'read', 'prices']).reply.data;
    expect(view.plan.sources).toEqual(sources);
    expect(view.comparison).toContainEqual({ path: pricePath, baseline: { present: true, value: baseline }, alternatives: {
      A: { present: true, value: a }, B: { present: true, value: b },
    } });
    for (const variant of ['A', 'B']) expect(view.variants[variant]!.base_values).toEqual({ [pricePath]: baseline });
    const count = '900719925474099312345678901234567890';
    expect((await write(root, directory, ['edit', '--target', 'base'], {
      op: 'update', table: 'offers', key: 'bundle', values: { count },
    })).status).toBe(0);
    for (const variant of ['A', 'B']) {
      expect(cli(root, ['read', 'offers/bundle', '--target', 'prices/' + variant]).reply.data).toMatchObject({ count });
    }
    const drift = await write(root, directory, ['edit', '--target', 'base'], {
      op: 'update', table: 'offers', key: 'bundle', values: { price: '00024.0000' },
    });
    expect(drift).toMatchObject({ status: 0, reply: { ok: true, target: 'base' } });
    for (const result of [drift, cli(root, ['validate']), cli(root, ['read', pricePath, '--target', 'prices/A'])]) {
      expect(result.status).toBe(0);
      expect(result.reply.diagnostics).toContainEqual(expect.objectContaining({ code: 'BASE_CHANGED', severity: 'warning', path: pricePath }));
      expect(result.reply.diagnostics.every(item => item.severity === 'warning')).toBe(true);
    }
    const warning = drift.reply.diagnostics.find(item => item.file.endsWith('/A.yaml'))!;
    for (const value of [baseline, '00024.0000', a]) expect(warning.message).toContain(value);
    for (const status of ['draft', 'review']) {
      expect(cli(root, ['plan', 'status', 'prices', '--to', status, '--expect-revision', revision(root)]).status).toBe(0);
      expect(cli<PlanView>(root, ['plan', 'read', 'prices']).reply.data.plan.status).toBe(status);
    }
    const variants = await Promise.all(['A', 'B'].map(name => readFile(join(root, 'plans/prices/' + name + '.yaml'), 'utf8')));
    expect(cli(root, ['plan', 'approve', 'prices/B', '--expect-revision', revision(root)]))
      .toMatchObject({ status: 0, reply: { target: 'prices/B', data: { applied: true, changed: expect.arrayContaining(['tables/offers.yaml']) } } });
    expect(cli(root, ['read', 'offers/bundle', '--target', 'base']).reply.data).toMatchObject({ price: b, count });
    const approved = cli<PlanView>(root, ['plan', 'read', 'prices']).reply.data;
    expect(approved.plan).toMatchObject({ status: 'approved', selected: 'B', sources });
    expect(approved.variants.A!.sources).toEqual([sourceA]);
    expect(approved.variants.B!.sources).toEqual([sourceB]);
    expect(await Promise.all(['A', 'B'].map(name => readFile(join(root, 'plans/prices/' + name + '.yaml'), 'utf8')))).toEqual(variants);
  });

  it('stores a pending question without a fabricated target or alternative in an empty project', async () => {
    const { root, directory } = await setup(false);
    const definition = { title: 'Unmapped source', status: 'review', question: 'Which table should own this value?',
      sources: [{ file: 'notion.zip', sourceHash: 'c'.repeat(64), page: 'unknown-table', path: 'page.md', raw: '123,456,789' }] };
    expect((await write(root, directory, ['plan', 'create', 'pending'], definition)).status).toBe(0);
    expect(cli<PlanView>(root, ['plan', 'read', 'pending'])).toMatchObject({ status: 0, reply: { target: 'pending', data: {
      plan: { ...definition, name: 'pending', variants: [] }, variants: {}, comparison: [], diagnostics: [],
    } } });
    expect((await readdir(join(root, 'plans/pending')))).toEqual(['_plan.yaml']);
    expect(cli(root, ['validate'])).toMatchObject({ status: 0, reply: { diagnostics: [] } });
  });

  it('previews create, variant, status and approval without changing files or revision', async () => {
    const { root, directory } = await setup();
    const literal = '+000.1234567890123456789012345678900E+0002';
    const stages: { command: string[]; value?: unknown; files: string[]; target: string }[] = [
      { command: ['plan', 'create', 'prices'], value: { title: 'Price review', status: 'review' }, files: ['plans/prices/_plan.yaml'], target: 'prices' },
      { command: ['plan', 'variant', 'prices/A'], value: { set: { 'offers/bundle/price': literal }, sources: [{ raw: literal, file: 'original.csv', cell: 'B2' }] }, files: ['plans/prices/A.yaml'], target: 'prices/A' },
      { command: ['plan', 'status', 'prices', '--to', 'draft'], files: ['plans/prices/_plan.yaml'], target: 'prices' },
      { command: ['plan', 'approve', 'prices/A'], files: ['plans/prices/_plan.yaml', 'tables/offers.yaml'], target: 'prices/A' },
    ];
    for (const stage of stages) {
      const expected = revision(root), before = await snapshot(root);
      const request = [...stage.command, ...(stage.value === undefined ? [] : ['--input', await input(directory, stage.value)]), '--expect-revision', expected];
      const preview = cli<Preview>(root, [...request, '--dry-run']);
      expect(preview).toMatchObject({ status: 0, reply: { ok: true, target: stage.target, revision: expected,
        data: { applied: false, changed: [], candidates: [] }, diagnostics: [],
      } });
      expect([...preview.reply.data.planned].sort()).toEqual(stage.files);
      expect(Object.keys(preview.reply.data.preview).sort()).toEqual(stage.files);
      expect(await snapshot(root)).toEqual(before);
      expect(revision(root)).toBe(expected);
      const applied = cli(root, request);
      expect(applied).toMatchObject({ status: 0, reply: { target: stage.target, data: { applied: true, changed: preview.reply.data.planned } } });
      expect(applied.reply.revision).not.toBe(expected);
      for (const [file, source] of Object.entries(preview.reply.data.preview)) {
        expect(await readFile(join(root, file), 'utf8')).toBe(source);
      }
    }
    expect(cli(root, ['read', 'offers/bundle/price', '--target', 'base']).reply.data).toEqual({ present: true, value: literal });
  });

  it('composes added and removed rows while capturing absent baseline paths', async () => {
    const { root, directory } = await setup();
    await create(root, directory);
    const patch = { add: { 'offers/new': { price: '00042.0000', count: '001', available: true } }, remove: ['offers/starter'] };
    expect((await write(root, directory, ['plan', 'variant', 'prices/A'], patch)).status).toBe(0);
    expect(cli(root, ['read', 'offers/new', '--target', 'prices/A']).reply.data).toEqual({ sku: 'new', ...patch.add['offers/new'] });
    expect(cli(root, ['read', 'offers/starter', '--target', 'prices/A']).status).toBe(2);
    expect(cli(root, ['read', 'offers/starter', '--target', 'base']).status).toBe(0);
    const variant = cli<PlanView>(root, ['plan', 'read', 'prices']).reply.data.variants.A!;
    expect(variant.base_missing).toEqual(['offers/new']);
    expect(variant.base_values['offers/starter']).toMatchObject({ sku: 'starter', price: '-0.000' });
    expect(cli(root, ['plan', 'approve', 'prices/A', '--expect-revision', revision(root)]).status).toBe(0);
    expect(cli(root, ['read', 'offers/new', '--target', 'base']).reply.data).toEqual({ sku: 'new', ...patch.add['offers/new'] });
    expect(cli(root, ['read', 'offers/starter', '--target', 'base']).status).toBe(2);
    expect(cli(root, ['validate']).status).toBe(0);
  });

  it('validates baseline and every live variant even when reading only one target', async () => {
    const { root, directory } = await setup();
    await create(root, directory);
    expect((await write(root, directory, ['plan', 'variant', 'prices/A'], { set: { 'offers/bundle/price': '-001.00' } })).status).toBe(1);
    expect((await write(root, directory, ['plan', 'variant', 'prices/B'], { set: { 'offers/bundle/currency': 'missing' } })).status).toBe(1);
    expect((await write(root, directory, ['edit', '--target', 'base'], {
      op: 'update', table: 'items', key: 'currency_gold', values: { kind: 'invalid' },
    })).status).toBe(1);
    for (const args of [['validate'], ['read', 'offers/bundle', '--target', 'base'], ['read', 'offers/bundle', '--target', 'prices/A']]) {
      const result = cli(root, args);
      expect(result).toMatchObject({ status: 1, reply: { ok: false } });
      expect(result.reply.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'VALUE_TYPE_OR_RANGE', path: 'items/currency_gold/kind' }),
        expect.objectContaining({ code: 'VALUE_TYPE_OR_RANGE', path: 'offers/bundle/price', message: expect.stringContaining('prices/A') }),
        expect.objectContaining({ code: 'REF_MISSING', path: 'offers/bundle/currency', message: expect.stringContaining('prices/B') }),
      ]));
    }
  });

  it('rejects stale create, variant, status and approve requests without changing files', async () => {
    const { root, directory } = await setup();
    await create(root, directory);
    expect((await write(root, directory, ['plan', 'variant', 'prices/A'], { set: { 'offers/bundle/price': '00042.0000' } })).status).toBe(0);
    const stale = revision(root);
    expect(cli(root, ['plan', 'status', 'prices', '--to', 'draft', '--expect-revision', stale]).status).toBe(0);
    const current = revision(root), before = await snapshot(root);
    const requests = [
      ['plan', 'create', 'other', '--input', await input(directory, { title: 'Stale', status: 'review' })],
      ['plan', 'status', 'prices', '--to', 'review'], ['plan', 'approve', 'prices/A'],
    ];
    for (const request of requests) {
      expect(cli(root, [...request, '--expect-revision', stale])).toMatchObject({ status: 2, reply: {
        revision: current, data: { applied: false, changed: [] }, error: { code: 'STALE_REVISION' },
      } });
      expect(await snapshot(root)).toEqual(before);
    }
    expect(await write(root, directory, ['plan', 'variant', 'prices/A'], { set: { 'offers/bundle/price': '00099' } }, stale))
      .toMatchObject({ status: 2, reply: { revision: current, target: 'prices/A', data: { applied: false, changed: [] }, error: { code: 'STALE_REVISION' } } });
    expect(await snapshot(root)).toEqual(before);
  });

  it('requires explicit baseline for every legacy write after plans exist and keeps the old importer flow', async () => {
    const { root, directory } = await setup();
    const operation = { op: 'update', table: 'offers', key: 'bundle', values: { count: '0002' } };
    // Existing projects have an unambiguous default until the first plan is created.
    expect(await write(root, directory, ['edit'], operation)).toMatchObject({ status: 0, reply: { target: 'base' } });
    await create(root, directory);
    const csv = join(directory, 'extra.csv');
    await writeFile(csv, 'Code,Name\nnew,Original\n');
    const mapping = await input(directory, { table: 'extra', schema: 'extra', sheet: 'extra', header_row: 1, data_start_row: 2,
      numeric: 'stored', columns: { A: 'code', B: 'name' }, definition: { primary_key: 'code', columns: { code: { type: 'string' }, name: { type: 'string' } } } });
    const preview = cli<ImportPlan>(root, ['import', 'plan', csv, '--mapping', mapping]);
    expect(preview.status).toBe(0);
    const importFile = join(directory, 'import.json');
    await writeFile(importFile, JSON.stringify(preview.reply.data));
    const editFile = join(directory, 'edit.json'), applyFile = join(directory, 'apply.json');
    await writeFile(editFile, JSON.stringify(operation));
    await writeFile(applyFile, JSON.stringify([operation]));
    const requests = [
      ['edit', '--input', editFile], ['apply', '--input', applyFile],
      ['rename', 'key', 'offers/starter', '--to', 'renamed'], ['import', 'apply', '--input', importFile],
    ];
    const expected = revision(root), before = await snapshot(root);
    for (const request of requests) {
      expect(cli(root, [...request, '--expect-revision', expected])).toMatchObject({ status: 2, reply: {
        data: { applied: false, changed: [] }, error: { code: 'TARGET_REQUIRED' },
      } });
      expect(cli(root, [...request, '--target', 'prices/A', '--expect-revision', expected])).toMatchObject({ status: 2, reply: {
        data: { applied: false, changed: [] }, error: { code: 'INVALID_ARGUMENT' },
      } });
      expect(await snapshot(root)).toEqual(before);
    }
    // Applying the exact importer preview first preserves its captured revision/hash.
    for (const request of [requests[3]!, ...requests.slice(0, 3)]) {
      expect(cli(root, [...request, '--target', 'base', '--expect-revision', revision(root)]))
        .toMatchObject({ status: 0, reply: { target: 'base', data: { applied: true } } });
    }
    expect(cli(root, ['read', 'extra/new', '--target', 'base']).reply.data).toEqual({ code: 'new', name: 'Original' });
  });

  it('rejects malformed targets, unsupported status and numeric JSON cells without falling back to baseline', async () => {
    const { root, directory } = await setup();
    await create(root, directory);
    const expected = revision(root), before = await snapshot(root);
    for (const target of ['', 'prices', '/A', 'prices/', 'prices/A/extra', '../A', 'prices\\A', 'base/A/extra']) {
      expect(cli(root, ['read', 'offers', '--target', target])).toMatchObject({ status: 2, reply: { error: { code: 'INVALID_ARGUMENT' } } });
    }
    for (const args of [
      ['plan', 'variant', 'prices/A/extra'], ['plan', 'approve', 'prices'],
      ['plan', 'status', 'prices', '--to', 'approved', '--expect-revision', expected],
      ['plan', 'list', '--target', 'base'], ['validate', '--target', 'prices/A'],
      ['plan', 'read', 'prices', '--dry-run'], ['plan', 'list', '--dry-run'],
    ]) expect(cli(root, args)).toMatchObject({ status: 2, reply: { error: { code: 'INVALID_ARGUMENT' } } });
    expect(await write(root, directory, ['plan', 'variant', 'prices/A'], { set: { 'offers/bundle/price': 42 } }))
      .toMatchObject({ status: 2, reply: { data: { applied: false, changed: [] } } });
    expect(cli(root, ['plan', 'create', 'other'])).toMatchObject({ status: 2, reply: { error: { code: 'REVISION_REQUIRED' } } });
    expect(await snapshot(root)).toEqual(before);
  });
});
