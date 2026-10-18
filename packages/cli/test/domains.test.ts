import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../core/test/fixtures/project/', import.meta.url));
const roots: string[] = [];
interface Reply<T = unknown> {
  ok: boolean; revision: string; data: T;
  diagnostics: { code: string; file: string; path: string }[];
  error?: { code: string; message: string };
}
function cli<T = unknown>(root: string, args: string[], status = 0): Reply<T> {
  const result = spawnSync(process.execPath, [entry, ...args, '--project', root, '--json'], {
    cwd: root, encoding: 'utf8', timeout: process.platform === 'win32' ? 60_000 : 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  expect(result.status, result.stdout).toBe(status);
  return JSON.parse(result.stdout) as Reply<T>;
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-cli-domains-'));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  return root;
}
async function input(root: string, name: string, value: unknown) {
  const path = join(root, name + '.json');
  await writeFile(path, JSON.stringify(value));
  return path;
}
function write(root: string, args: string[], status = 0) {
  return cli<{ applied: boolean; changed: string[]; planned?: string[]; preview?: Record<string, string | null> }>(root,
    [...args, '--target', 'base', '--expect-revision', cli(root, ['validate']).revision], status);
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('creates, edits, renames and locates nested resources by global public names', async () => {
  const root = await setup();
  const before = cli(root, ['validate']).revision;
  const preview = write(root, ['folder', 'create', '경제/상점', '--dry-run']);
  expect(preview).toMatchObject({ revision: before, data: { applied: false, changed: [],
    planned: expect.arrayContaining(['tables/경제/상점/.gitkeep', 'documents/경제/상점/.gitkeep']) } });
  expect(cli(root, ['folder', 'list']).data).toEqual([]);
  write(root, ['folder', 'create', '경제/상점']);
  expect(cli(root, ['folder', 'list']).data).toEqual(['경제', '경제/상점']);

  const originalTable = await readFile(join(root, 'tables/offers.yaml'), 'utf8');
  write(root, ['move', 'table', 'offers', '--folder', '경제/상점']);
  expect(await readFile(join(root, 'tables/경제/상점/offers.yaml'), 'utf8')).toBe(originalTable);
  expect(cli(root, ['read', 'offers/bundle/price']).data).toEqual({ value: '+001.2300E+0002', present: true });
  cli(root, ['read', '경제/상점/offers'], 2);
  const changes = await input(root, 'edit', { op: 'update', table: 'offers', key: 'bundle', values: { price: '+0001.2500' } });
  expect(write(root, ['edit', '--input', changes]).data.changed).toContain('tables/경제/상점/offers.yaml');

  const markdown = '\uFEFF# 가격\r\n\r\n[가격](offers/bundle/price)\r\n\r\n남길 문장 👋';
  const source = join(root, 'source.md');
  await writeFile(source, markdown);
  const created = write(root, ['document', 'create', '상점 안내', '--folder', '경제/상점', '--input', source]);
  expect(created.data.changed).toContain('documents/경제/상점/상점 안내.md');
  expect(cli<{ source: string }>(root, ['document', 'read', '상점 안내']).data.source).toBe(markdown);
  const usages = cli<{ links: { file: string }[] }>(root, ['where-used', 'offers/bundle/price']);
  expect(JSON.stringify(usages.data)).toContain('documents/경제/상점/상점 안내.md');
  write(root, ['rename', 'table', 'offers', '--to', 'products']);
  expect(await readFile(join(root, 'documents/경제/상점/상점 안내.md'), 'utf8')).toBe(markdown.replace('offers/', 'products/'));
  write(root, ['rename', 'document', '상점 안내', '--to', '구매 안내']);
  const documentEdit = await input(root, 'document-edit', [{ op: 'replace', block: 2, markdown: '수정한 문장 👋' }]);
  write(root, ['document', 'edit', '구매 안내', '--input', documentEdit]);
  expect(cli<{ source: string }>(root, ['document', 'read', '구매 안내']).data.source)
    .toBe(markdown.replace('offers/', 'products/').replace('남길 문장 👋', '수정한 문장 👋'));

  const createTable = await input(root, 'create-table', { op: 'table-create', table: 'quests', key: { code: 'id', label: '퀘스트' } });
  expect(write(root, ['edit', '--folder', '경제/상점', '--input', createTable]).data.changed)
    .toContain('tables/경제/상점/quests.yaml');
  expect(cli(root, ['read', 'quests']).data).toMatchObject({ schema: { primary_key: 'id' } });
  const output = join(root, 'exported');
  cli(root, ['export', '--output', output]);
  expect(await readFile(join(output, '경제/상점/products.md'), 'utf8')).toContain('+0001.2500');
  cli(root, ['fmt']);
  cli(root, ['fmt', '--check']);
  cli(root, ['validate']);
}, process.platform === 'win32' ? 120_000 : 60_000);

it('moves both domain roots, preserves document bytes, and deletes only empty folders', async () => {
  const root = await setup();
  write(root, ['folder', 'create', '경제/상점']);
  write(root, ['folder', 'create', '보관']);
  write(root, ['move', 'table', 'offers', '--folder', '경제/상점']);
  const source = join(root, 'source.md'), markdown = '\uFEFF# 가격\r\n\r\n[가격](offers/bundle/price)';
  await writeFile(source, markdown);
  write(root, ['document', 'create', '안내', '--folder', '경제/상점', '--input', source]);
  write(root, ['folder', 'rename', '경제/상점', '--to', '판매']);
  write(root, ['folder', 'move', '경제/판매', '--folder', '보관']);
  expect(await readFile(join(root, 'documents/보관/판매/안내.md'), 'utf8')).toBe(markdown);
  expect(cli(root, ['read', 'offers/bundle/price']).ok).toBe(true);
  expect(write(root, ['folder', 'delete', '보관/판매'], 2).data.applied).toBe(false);
  const revision = cli(root, ['validate']).revision;
  const preview = write(root, ['move', 'document', '안내', '--folder', '', '--dry-run']);
  expect(preview.revision).toBe(revision);
  expect(preview.data.planned).toContain('documents/안내.md');
  expect(await readFile(join(root, 'documents/보관/판매/안내.md'), 'utf8')).toBe(markdown);
  write(root, ['move', 'document', '안내', '--folder', '']);
  write(root, ['move', 'table', 'offers', '--folder', '']);
  write(root, ['folder', 'delete', '보관/판매']);
  expect(cli(root, ['folder', 'list']).data).not.toContain('보관/판매');
  expect(await readFile(join(root, 'documents/안내.md'), 'utf8')).toBe(markdown);
}, process.platform === 'win32' ? 120_000 : 60_000);

it('imports into a nested destination and rejects unsafe or stale folder writes without changes', async () => {
  const root = await setup();
  write(root, ['folder', 'create', '경제/불러오기']);
  const source = join(root, 'source.csv');
  await writeFile(source, 'id,label\none,001\n');
  const mapping = await input(root, 'mapping', { table: 'imported', schema: 'imported', folder: '경제/불러오기', sheet: 'source',
    header_row: 1, data_start_row: 2, columns: { A: 'id', B: 'label' }, numeric: 'stored',
    definition: { primary_key: 'id', columns: { id: { type: 'string', required: true }, label: { type: 'string' } } } });
  const inspection = cli<{ sheets: { name: string }[] }>(root, ['import', 'inspect', source]);
  const rawMapping = JSON.parse(await readFile(mapping, 'utf8')) as Record<string, unknown>;
  rawMapping.sheet = inspection.data.sheets[0]!.name;
  await writeFile(mapping, JSON.stringify(rawMapping));
  const plan = cli(root, ['import', 'plan', source, '--mapping', mapping]);
  const planFile = await input(root, 'plan', plan.data);
  expect(write(root, ['import', 'apply', '--input', planFile]).data.changed).toContain('tables/경제/불러오기/imported.yaml');
  expect(cli(root, ['read', 'imported/one/label']).data).toEqual({ value: '001', present: true });

  const revision = cli(root, ['validate']).revision;
  for (const path of ['../escape', '/absolute', 'a\\b', 'assets', 'CON', '경제//bad']) {
    const rejected = write(root, ['folder', 'create', path], 2);
    expect(rejected.revision).toBe(revision);
    expect(rejected.data).toMatchObject({ applied: false, changed: [] });
  }
  expect(cli(root, ['folder', 'create', 'new', '--expect-revision', revision], 2).error?.code).toBe('TARGET_REQUIRED');
  expect(cli(root, ['folder', 'create', 'new', '--target', 'base'], 2).error?.code).toBe('REVISION_REQUIRED');
  expect(cli(root, ['folder', 'create', 'new', '--target', 'base', '--expect-revision', 'stale'], 2).error?.code).toBe('STALE_REVISION');
  cli(root, ['folder', 'list', '--dry-run'], 2);
  write(root, ['move', 'schema', 'items', '--folder', '경제'], 2);
  write(root, ['move', 'table', 'items'], 2);
  const update = await input(root, 'not-create', { op: 'update', table: 'items', key: 'currency_gold', values: { name: 'changed' } });
  write(root, ['edit', '--folder', '경제', '--input', update], 2);
  const sourceDoc = join(root, 'duplicate.md');
  await writeFile(sourceDoc, '# duplicate');
  write(root, ['document', 'create', 'IMPORTED', '--folder', '경제', '--input', sourceDoc], 2);
  expect(cli(root, ['validate']).revision).toBe(revision);
  await mkdir(join(root, 'tables/보관'), { recursive: true });
  await writeFile(join(root, 'tables/보관/unmanaged.txt'), 'keep');
  write(root, ['folder', 'delete', '보관'], 2);
  expect(await readFile(join(root, 'tables/보관/unmanaged.txt'), 'utf8')).toBe('keep');
}, process.platform === 'win32' ? 120_000 : 60_000);
