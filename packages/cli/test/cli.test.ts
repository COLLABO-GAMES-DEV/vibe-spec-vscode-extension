import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../core/test/fixtures/project/', import.meta.url));
const roots: string[] = [];
interface Reply {
  ok: boolean;
  revision: string | null;
  data: unknown;
  diagnostics: { code: string; file: string; path: string; message: string }[];
  error?: { code: string; message: string };
}
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-cli-'));
  roots.push(root);
  return root;
}
async function planning() {
  const root = await temp();
  await cp(fixture, root, { recursive: true });
  return root;
}
function run(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd, encoding: 'utf8', timeout: 10_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return result;
}
function json(args: string[], cwd: string) {
  const result = run([...args, '--json'], cwd);
  expect(result.stderr).toBe('');
  const reply = JSON.parse(result.stdout) as Reply;
  expect(reply).toHaveProperty('ok');
  expect(reply).toHaveProperty('revision');
  expect(reply).toHaveProperty('data');
  expect(Array.isArray(reply.diagnostics)).toBe(true);
  return { status: result.status, reply };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('actual CLI processes', () => {
  it('initializes an empty planning folder without domain data or future packages', async () => {
    const parent = await temp();
    const root = join(parent, 'planning');
    const { status, reply } = json(['init', 'planning'], parent);
    expect(status).toBe(0);
    expect(reply).toMatchObject({ ok: true, data: { root: expect.any(String) }, diagnostics: [] });
    const initializedRoot = (reply.data as { root: string }).root;
    expect(isAbsolute(initializedRoot)).toBe(true);
    expect(await realpath(initializedRoot)).toBe(await realpath(root));
    expect(reply.revision).toMatch(/^[a-f0-9]{64}$/);
    expect((await readdir(root)).sort()).toEqual([
      '.agents', '.gitattributes', '.gitignore', '.vibe-spec.json', 'AGENTS.md', 'schemas', 'tables',
    ]);
    expect(JSON.parse(await readFile(join(root, '.vibe-spec.json'), 'utf8')))
      .toEqual({ planning_root: '.' });
    expect(await readdir(join(root, 'tables'))).toEqual([]);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('vibe validate --json');
    expect(json(['validate'], root)).toEqual({
      status: 0, reply: { ok: true, revision: reply.revision, data: null, diagnostics: [] },
    });
    expect(json(['init', root], parent)).toMatchObject({
      status: 2, reply: { ok: false, error: { code: 'DIRECTORY_NOT_EMPTY' } },
    });
  });

  it('allows an existing Git repository and never overwrites a populated folder', async () => {
    const root = await temp();
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    expect(json(['init', root], root).status).toBe(0);
    const occupied = await temp();
    await writeFile(join(occupied, 'keep.txt'), 'keep');
    expect(json(['init', occupied], occupied).status).toBe(2);
    expect(await readFile(join(occupied, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await readdir(occupied)).toEqual(['keep.txt']);
  });

  it('resolves a relative planning_root from a parent configuration', async () => {
    const parent = await temp();
    await cp(fixture, join(parent, 'planning'), { recursive: true });
    await writeFile(join(parent, '.vibe-spec.json'), '{"planning_root":"./planning"}\n');
    const nested = join(parent, 'src', 'nested');
    await mkdir(nested, { recursive: true });
    const result = json(['read', 'items/currency_gold/name'], nested);
    expect(result).toMatchObject({ status: 0, reply: { data: { value: '골드', present: true } } });
  });

  it('reads table/schema, row, column and cell by path while preserving numeric strings', async () => {
    const root = await planning();
    const options = ['--project', root];
    const table = json(['read', 'offers', ...options], root);
    expect(table.status).toBe(0);
    expect(table.reply.data).toMatchObject({ schema: { primary_key: 'sku' }, table: { schema: 'offers' } });
    const row = json(['read', 'offers/bundle', ...options], root);
    expect(row.reply.data).toMatchObject({
      price: '+001.2300E+0002', count: '900719925474099312345', available: true,
    });
    expect(json(['read', 'offers/*/currency', ...options], root).reply.data).toEqual([
      { key: 'bundle', value: 'currency_gold', present: true },
      { key: 'starter', value: null, present: true },
    ]);
    expect(json(['read', 'offers/starter/price', ...options], root).reply.data)
      .toEqual({ value: '-0.000', present: true });
    expect(json(['read', 'items/missing', ...options], root)).toMatchObject({
      status: 2, reply: { ok: false, error: { code: 'PATH_NOT_FOUND' } },
    });
  });

  it.each([
    ['duplicate Key', '"currency_gold"', '"consumable_potion"', 'KEY_DUPLICATE'],
    ['enum', 'kind: "currency"', 'kind: "other"', 'VALUE_TYPE_OR_RANGE'],
    ['required value', '    name: "골드"\n', '', 'VALUE_REQUIRED'],
  ])('reports %s errors as structured diagnostics and exit 1', async (_label, from, to, code) => {
    const root = await planning();
    const path = join(root, 'tables/items.yaml');
    await writeFile(path, (await readFile(path, 'utf8')).replace(from, to));
    const result = json(['validate', '--project', root], root);
    expect(result).toMatchObject({ status: 1, reply: { ok: false } });
    expect(result.reply.diagnostics).toContainEqual(expect.objectContaining({ code, file: 'tables/items.yaml' }));
    const reading = json(['read', 'offers', '--project', root], root);
    expect(reading.status).toBe(1);
    expect(reading.reply.data).toHaveProperty('table');
  });

  it('finds a broken Key reference and keeps it visible in read output', async () => {
    const root = await planning();
    const path = join(root, 'tables/offers.yaml');
    await writeFile(path, (await readFile(path, 'utf8')).replace('"currency_gold"', '"items/currency_gold"'));
    const result = json(['read', 'offers/bundle/currency', '--project', root], root);
    expect(result.status).toBe(1);
    expect(result.reply.data).toEqual({ value: 'items/currency_gold', present: true });
    expect(result.reply.diagnostics).toContainEqual(expect.objectContaining({
      code: 'REF_MISSING', path: 'offers/bundle/currency',
    }));
  });

  it('prints core filename diagnostics and name suggestions in JSON and plain output', async () => {
    const root = await planning();
    // These full filenames are legal on Windows, but their resource names end
    // in a forbidden dot/space. No impossible Windows fixture is needed.
    await cp(join(root, 'schemas/items.yaml'), join(root, 'schemas/schema..yaml'));
    await cp(join(root, 'tables/items.yaml'), join(root, 'tables/table .yaml'));
    const validation = json(['validate', '--project', root], root);
    expect(validation.status).toBe(1);
    const errors = validation.reply.diagnostics.filter(item => item.code === 'NAME_INVALID');
    expect(errors.map(item => item.file).sort()).toEqual(['schemas/schema..yaml', 'tables/table .yaml']);
    const plain = run(['validate', '--project', root], root);
    expect(plain.status).toBe(1);
    for (const error of errors) {
      expect(error.message).toMatch(/이름 제안: .+$/);
      expect(plain.stderr).toContain(error.file + ' ' + error.path + ': NAME_INVALID: ' + error.message);
    }
    const reading = json(['read', 'items', '--project', root], root);
    expect(reading.status).toBe(1);
    expect(reading.reply.diagnostics).toEqual(validation.reply.diagnostics);
  });

  it('reports schema and YAML errors without polluting JSON stdout', async () => {
    const root = await planning();
    const path = join(root, 'schemas/items.yaml');
    await writeFile(path, 'primary_key: [code, name]\ncolumns: {}\n');
    const invalidSchema = json(['validate', '--project', root], root);
    expect(invalidSchema.status).toBe(1);
    expect(invalidSchema.reply.diagnostics.some(d => d.code === 'SCHEMA_SHAPE')).toBe(true);
    await writeFile(path, 'primary_key: code\nprimary_key: other\n');
    const invalidYaml = json(['validate', '--project', root], root);
    expect(invalidYaml.status).toBe(1);
    expect(invalidYaml.reply.diagnostics.some(d => d.code === 'YAML_SYNTAX')).toBe(true);
    const before = await readFile(join(root, 'tables/items.yaml'), 'utf8');
    expect(json(['fmt', '--project', root], root).status).toBe(2);
    expect(await readFile(join(root, 'tables/items.yaml'), 'utf8')).toBe(before);
  });

  it('checks without writing, formats twice identically, and never rewrites numeric values', async () => {
    const root = await planning();
    const path = join(root, 'tables/offers.yaml');
    const original = await readFile(path, 'utf8');
    const flags = ['--project', root];
    const check = json(['fmt', '--check', ...flags], root);
    expect(check.status).toBe(1);
    expect(check.reply.data).toHaveProperty('changed');
    expect(await readFile(path, 'utf8')).toBe(original);
    const first = json(['fmt', ...flags], root);
    expect(first.status).toBe(0);
    expect(first.reply.revision).not.toBe(check.reply.revision);
    const formatted = await readFile(path, 'utf8');
    for (const number of ['+001.2300E+0002', '-0.000', '900719925474099312345', '001']) {
      expect(formatted).toContain('"' + number + '"');
    }
    const second = json(['fmt', ...flags], root);
    expect(second).toMatchObject({ status: 0, reply: {
      revision: first.reply.revision, data: { changed: [] }, diagnostics: [],
    } });
    expect(await readFile(path, 'utf8')).toBe(formatted);
    expect(json(['fmt', '--check', ...flags], root).status).toBe(0);
  });

  it('formats bare numbers and retains flow row order without a JS Number conversion', async () => {
    const root = await planning();
    const path = join(root, 'tables/offers.yaml');
    await writeFile(path, 'schema: offers\nrows: [{sku: z, count: 900719925474099312345, available: true}, {sku: a, available: false}]\n');
    const result = json(['fmt', '--project', root], root);
    expect(result.status).toBe(0);
    const output = await readFile(path, 'utf8');
    expect(output).toContain('    count: "900719925474099312345"\n');
    expect(output.indexOf('sku: "z"')).toBeLessThan(output.indexOf('sku: "a"'));
  });

  it('reports remaining validation errors after applying formatting', async () => {
    const root = await planning();
    const path = join(root, 'tables/offers.yaml');
    await writeFile(path, (await readFile(path, 'utf8')).replace('"currency_gold"', '"missing"'));
    const result = json(['fmt', '--project', root], root);
    expect(result.status).toBe(1);
    expect(result.reply.diagnostics.some(d => d.code === 'REF_MISSING')).toBe(true);
    expect(await readFile(path, 'utf8')).toContain('schema: "offers"');
    expect(json(['fmt', '--project', root], root).reply.data).toEqual({ changed: [] });
  });

  it('does not replace files or remove another local writer’s lock', async () => {
    const root = await planning();
    const path = join(root, 'tables/offers.yaml');
    const original = await readFile(path, 'utf8');
    await writeFile(join(root, '.vibe-spec.lock'), 'other');
    expect(json(['fmt', '--project', root], root)).toMatchObject({
      status: 2, reply: { error: { code: 'PROJECT_LOCKED' } },
    });
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readFile(join(root, '.vibe-spec.lock'), 'utf8')).toBe('other');
  });

  it.each([['edit'], ['rename'], ['save'], ['import'], ['read'], ['validate', 'extra'],
    ['validate', '--check'], ['validate', '--unknown']])('rejects unsupported or incomplete arguments: %j', async (...args) => {
    const root = await temp();
    const result = json(args, root);
    expect(result.status).toBe(2);
    expect(result.reply.ok).toBe(false);
    expect(result.reply.error).toBeDefined();
  });

  it('prints help, plain validation output and configuration errors', async () => {
    const root = await planning();
    expect(run(['--help'], root).stdout).toContain('vibe fmt');
    expect(json(['--help'], root)).toMatchObject({ status: 0, reply: { data: { usage: expect.any(String) } } });
    expect(run(['validate', '--project', root], root).stdout).toBe('Valid.\n');
    await writeFile(join(root, '.vibe-spec.json'), '{broken');
    expect(json(['validate'], root)).toMatchObject({
      status: 2, reply: { error: { code: 'CONFIG_INVALID' } },
    });
  });
});
