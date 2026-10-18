import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
async function planning() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-cli-writes-'));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  return root;
}
function cli(root: string, args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args, '--project', root, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return { status: result.status, reply: JSON.parse(result.stdout) as Reply };
}
function revision(root: string): string {
  const result = cli(root, ['read', 'items']);
  expect(result.reply.revision).toMatch(/^[a-f0-9]{64}$/);
  return result.reply.revision!;
}
async function edit(root: string, operation: unknown, expected = revision(root), command = 'edit') {
  const input = join(root, 'request.json');
  await writeFile(input, JSON.stringify(operation));
  return cli(root, [command, '--input', input, '--expect-revision', expected]);
}
function rename(root: string, kind: string, path: string, to: string) {
  return cli(root, ['rename', kind, path, '--to', to, '--expect-revision', revision(root)]);
}
async function sources(root: string) {
  const files = (await Promise.all(['schemas', 'tables'].map(async directory =>
    (await readdir(join(root, directory))).map(name => directory + '/' + name)))).flat().sort();
  return Promise.all(files.map(async file => [file, await readFile(join(root, file), 'utf8')] as const));
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('CLI writes in real planning repositories', () => {
  it('reads legacy CRLF unchanged, writes edited YAML as LF, and formats the remaining sources without changing numbers', async () => {
    const root = await planning();
    for (const [file, source] of await sources(root)) {
      await writeFile(join(root, file), source.replace(/\r?\n/g, '\r\n'));
    }
    const before = await sources(root);
    expect(cli(root, ['read', 'offers/bundle']).reply.data).toMatchObject({
      price: '+001.2300E+0002', count: '900719925474099312345',
    });
    expect(await sources(root)).toEqual(before);
    expect((await edit(root, { op: 'update', table: 'offers', key: 'bundle', values: { price: '+000.45000e+001' } })).status).toBe(0);
    const originalOffers = before.find(([file]) => file === 'tables/offers.yaml')![1]!;
    expect(await readFile(join(root, 'tables/offers.yaml'), 'utf8'))
      .toBe(originalOffers.replace('"+001.2300E+0002"', '"+000.45000e+001"').replace(/\r\n/g, '\n'));
    expect(await readFile(join(root, 'tables/items.yaml'), 'utf8'))
      .toBe(before.find(([file]) => file === 'tables/items.yaml')![1]);
    expect(cli(root, ['fmt']).status).toBe(0);
    for (const [file, source] of await sources(root)) expect(source, file).not.toContain('\r');
    expect(cli(root, ['read', 'offers/bundle']).reply.data).toMatchObject({
      price: '+000.45000e+001', count: '900719925474099312345',
    });
    expect(cli(root, ['read', 'offers/starter']).reply.data).toMatchObject({ price: '-0.000', count: '001' });
    expect(cli(root, ['fmt', '--check'])).toMatchObject({ status: 0, reply: { data: { changed: [] } } });
  });

  it('creates, updates and deletes rows while preserving numeric strings', async () => {
    const root = await planning();
    const number = '+000.1234567890123456789012345678900E+0002';
    expect(await edit(root, { op: 'create', table: 'offers', row: {
      sku: 'new', currency: 'currency_gold', price: number,
      count: '900719925474099312345678901234567890', available: true,
    } })).toMatchObject({ status: 0, reply: { ok: true, data: { applied: true }, diagnostics: [] } });
    expect(cli(root, ['read', 'offers/new']).reply.data).toMatchObject({
      price: number, count: '900719925474099312345678901234567890',
    });
    expect(await edit(root, { op: 'update', table: 'offers', key: 'new', values: {
      price: '00042.0000', available: false,
    } })).toMatchObject({ status: 0, reply: { data: { applied: true, changed: ['tables/offers.yaml'] } } });
    expect(cli(root, ['read', 'offers/new/price']).reply.data).toEqual({ value: '00042.0000', present: true });
    expect(await edit(root, { op: 'delete', table: 'offers', key: 'new' })).toMatchObject({
      status: 0, reply: { data: { applied: true } },
    });
    expect(cli(root, ['read', 'offers/new']).reply.error?.code).toBe('PATH_NOT_FOUND');
  });

  it('changes only the edited cell line and leaves neighboring raw values and comments intact', async () => {
    const root = await planning();
    const file = join(root, 'tables/offers.yaml');
    const before = (await readFile(file, 'utf8')).replace('price: "+001.2300E+0002"', 'price: "+001.2300E+0002" # keep');
    await writeFile(file, before);
    const next = '+0008.120000E+0002';
    expect((await edit(root, { op: 'update', table: 'offers', key: 'bundle', values: { price: next } })).status).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(before.replace('"+001.2300E+0002"', JSON.stringify(next)));
  });

  it('applies a related batch and checks deletion protection against surviving references', async () => {
    const root = await planning();
    const result = await edit(root, [
      { op: 'delete', table: 'items', key: 'currency_gold' },
      { op: 'create', table: 'items', row: { code: 'currency_coin', name: '코인', kind: 'currency' } },
      { op: 'update', table: 'offers', key: 'bundle', values: { currency: 'currency_coin' } },
    ], revision(root), 'apply');
    expect(result).toMatchObject({ status: 0, reply: { data: { applied: true }, diagnostics: [] } });
    expect(cli(root, ['read', 'offers/bundle/currency']).reply.data).toEqual({ value: 'currency_coin', present: true });
    expect(cli(root, ['read', 'items/currency_gold']).status).toBe(2);
  });

  it('refuses a restricted deletion and writes nothing', async () => {
    const root = await planning();
    const before = await sources(root);
    const result = await edit(root, { op: 'delete', table: 'items', key: 'currency_gold' });
    expect(result).toMatchObject({ status: 2, reply: {
      ok: false, data: { applied: false }, error: { code: 'DELETE_RESTRICTED' },
    } });
    expect(result.reply.diagnostics).toContainEqual(expect.objectContaining({ path: 'offers/bundle/currency' }));
    expect(await sources(root)).toEqual(before);
  });

  it('allows an undeclared deletion guard and reports the remaining dangling reference after writing', async () => {
    const root = await planning();
    const file = join(root, 'schemas/offers.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('    on_delete: restrict\n', ''));
    const result = await edit(root, { op: 'delete', table: 'items', key: 'currency_gold' });
    expect(result).toMatchObject({ status: 1, reply: { ok: false, data: { applied: true } } });
    expect(result.reply.error).toBeUndefined();
    expect(result.reply.diagnostics).toContainEqual(expect.objectContaining({
      code: 'REF_MISSING', path: 'offers/bundle/currency',
    }));
    expect(cli(root, ['read', 'items/currency_gold']).status).toBe(2);
  });

  it('can delete a protected target and its referring row in the same batch', async () => {
    const root = await planning();
    const result = await edit(root, [
      { op: 'delete', table: 'items', key: 'currency_gold' },
      { op: 'delete', table: 'offers', key: 'bundle' },
    ], revision(root), 'apply');
    expect(result).toMatchObject({ status: 0, reply: { data: { applied: true }, diagnostics: [] } });
    expect(cli(root, ['read', 'offers/bundle']).status).toBe(2);
  });

  it('persists invalid enum, type and range content with diagnostics instead of an approval gate', async () => {
    const root = await planning();
    const result = await edit(root, [
      { op: 'update', table: 'items', key: 'currency_gold', values: { kind: 'unknown' } },
      { op: 'update', table: 'offers', key: 'bundle', values: { price: '-0001.00', available: 'true' } },
    ], revision(root), 'apply');
    expect(result).toMatchObject({ status: 1, reply: { data: { applied: true } } });
    expect(result.reply.error).toBeUndefined();
    expect(result.reply.diagnostics.map(item => item.path)).toEqual(expect.arrayContaining([
      'items/currency_gold/kind', 'offers/bundle/price', 'offers/bundle/available',
    ]));
    expect(cli(root, ['read', 'offers/bundle']).reply.data).toMatchObject({ price: '-0001.00', available: 'true' });
  });

  it('renames a Key and declared references but returns unchanged memo and document candidates', async () => {
    const root = await planning();
    const tableFile = join(root, 'tables/items.yaml');
    await writeFile(tableFile, (await readFile(tableFile, 'utf8')).replace('note: "001"', 'note: "currency_gold remains in prose"'));
    const prose = '# 메모\ncurrency_gold 보상 확인\n';
    await writeFile(join(root, 'notes.md'), prose);
    const result = rename(root, 'key', 'items/currency_gold', 'currency_coin');
    expect(result).toMatchObject({ status: 0, reply: { data: {
      applied: true, candidates: expect.arrayContaining([
        expect.objectContaining({ file: 'tables/items.yaml', path: 'items/currency_gold/note' }),
        expect.objectContaining({ file: 'notes.md', line: 2 }),
      ]),
    } } });
    expect(cli(root, ['read', 'offers/bundle/currency']).reply.data).toEqual({ value: 'currency_coin', present: true });
    expect(cli(root, ['read', 'items/currency_coin']).reply.data).toMatchObject({
      code: 'currency_coin', note: 'currency_gold remains in prose',
    });
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(prose);
    expect(cli(root, ['read', 'items/currency_gold']).status).toBe(2);
  });

  it('where-used reports structured references and free text without changing any source', async () => {
    const root = await planning();
    const file = join(root, 'tables/items.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('note: "001"', 'note: "currency_gold"'));
    await writeFile(join(root, 'notes.txt'), 'currency_gold is mentioned here\n');
    const before = await sources(root);
    const result = cli(root, ['where-used', 'items/currency_gold']);
    expect(result).toMatchObject({ status: 0, reply: { data: {
      references: [expect.objectContaining({ file: 'tables/offers.yaml', path: 'offers/bundle/currency' })],
      candidates: expect.arrayContaining([
        expect.objectContaining({ file: 'tables/items.yaml', path: 'items/currency_gold/note' }),
        expect.objectContaining({ file: 'notes.txt', line: 1 }),
      ]),
    } } });
    expect(await sources(root)).toEqual(before);
  });

  it('renames a table file and ref declarations while retaining its schema name and Key-only cells', async () => {
    const root = await planning();
    expect(rename(root, 'table', 'items', 'goods')).toMatchObject({ status: 0, reply: { data: { applied: true } } });
    expect((await readdir(join(root, 'tables'))).sort()).toEqual(['goods.yaml', 'offers.yaml']);
    expect(cli(root, ['read', 'goods']).reply.data).toMatchObject({ table: { schema: 'items' } });
    expect(cli(root, ['read', 'offers']).reply.data).toMatchObject({
      schema: { columns: { currency: { table: 'goods' } } },
    });
    expect(cli(root, ['read', 'offers/bundle/currency']).reply.data).toEqual({ value: 'currency_gold', present: true });
    expect(cli(root, ['validate']).status).toBe(0);
  });

  it('renames shared-schema columns including unique declarations and the primary_key declaration', async () => {
    const root = await planning();
    await cp(join(root, 'tables/items.yaml'), join(root, 'tables/alternate.yaml'));
    const file = join(root, 'schemas/items.yaml');
    await writeFile(file, (await readFile(file, 'utf8')) + 'unique:\n  - ["name"]\n');
    expect(rename(root, 'column', 'items/*/name', 'source').status).toBe(0);
    for (const name of ['items', 'alternate']) {
      const result = cli(root, ['read', name]);
      expect(result.reply.data).toMatchObject({ schema: { unique: [['source']] } });
      expect(cli(root, ['read', name + '/currency_gold/source']).reply.data).toEqual({ value: '골드', present: true });
      expect(cli(root, ['read', name + '/currency_gold/name']).status).toBe(2);
    }
    expect(rename(root, 'column', 'items/*/code', 'key').status).toBe(0);
    expect(cli(root, ['read', 'items']).reply.data).toMatchObject({ schema: { primary_key: 'key' } });
    expect(cli(root, ['read', 'alternate/currency_gold']).reply.data).toMatchObject({ key: 'currency_gold' });
    expect(cli(root, ['validate']).status).toBe(0);
  });

  it('rejects a stale revision after another CLI process changes the same cell', async () => {
    const root = await planning();
    const old = revision(root);
    const first = await edit(root, { op: 'update', table: 'items', key: 'currency_gold', values: { name: '다른 프로세스' } }, old);
    expect(first.status).toBe(0);
    expect(first.reply.revision).not.toBe(old);
    const afterFirst = await sources(root);
    const second = await edit(root, { op: 'update', table: 'items', key: 'currency_gold', values: { name: '오래된 화면' } }, old);
    expect(second).toMatchObject({ status: 2, reply: {
      data: { applied: false }, error: { code: 'STALE_REVISION' }, revision: first.reply.revision,
    } });
    expect(await sources(root)).toEqual(afterFirst);
    expect(cli(root, ['read', 'items/currency_gold/name']).reply.data).toEqual({ value: '다른 프로세스', present: true });
  });

  it('rejects a stale batch after an external writer edits a different file', async () => {
    const root = await planning();
    const old = revision(root);
    const file = join(root, 'tables/offers.yaml');
    const external = (await readFile(file, 'utf8')).replace('count: "001"', 'count: "0002"');
    await writeFile(file, external);
    const before = await sources(root);
    const result = await edit(root, [
      { op: 'update', table: 'items', key: 'currency_gold', values: { name: '덮어쓰기 금지' } },
    ], old, 'apply');
    expect(result).toMatchObject({ status: 2, reply: { data: { applied: false }, error: { code: 'STALE_REVISION' } } });
    expect(await sources(root)).toEqual(before);
  });

  it('refuses a held writer lock without changing files or removing the other lock', async () => {
    const root = await planning();
    const before = await sources(root);
    await writeFile(join(root, '.vibe-spec.lock'), 'other writer');
    expect(await edit(root, { op: 'update', table: 'items', key: 'currency_gold', values: { name: '대기 중' } })).toMatchObject({
      status: 2, reply: { data: { applied: false }, error: { code: 'PROJECT_LOCKED' } },
    });
    expect(await sources(root)).toEqual(before);
    expect(await readFile(join(root, '.vibe-spec.lock'), 'utf8')).toBe('other writer');
  });

  it.each([
    ['key', 'items/currency_gold', 'consumable_potion'],
    ['table', 'items', 'offers'],
    ['column', 'items/*/name', 'note'],
  ])('refuses colliding %s names without modifying sources', async (kind, path, to) => {
    const root = await planning();
    const before = await sources(root);
    expect(rename(root, kind, path, to)).toMatchObject({ status: 2, reply: {
      data: { applied: false }, error: { code: 'NAME_EXISTS' },
    } });
    expect(await sources(root)).toEqual(before);
  });

  it.each([
    [{ op: 'update', table: 'offers', key: 'bundle', values: { price: 0.1 } }, 'INVALID_EDIT'],
    [{ op: 'update', table: 'items', key: 'currency_gold', values: { code: 'currency_coin' } }, 'RENAME_REQUIRED'],
    [{ op: 'update', table: 'items', key: 'currency_gold', values: { missing: 'value' } }, 'COLUMN_UNKNOWN'],
    [{ op: 'create', table: 'items', row: { code: 'currency_gold', name: '중복' } }, 'NAME_EXISTS'],
  ])('refuses malformed or ambiguous operations without a partial write: %j', async (operation, code) => {
    const root = await planning();
    const before = await sources(root);
    expect(await edit(root, operation)).toMatchObject({ status: 2, reply: {
      data: { applied: false }, error: { code },
    } });
    expect(await sources(root)).toEqual(before);
  });

  it('requires an explicit expected revision before writing', async () => {
    const root = await planning();
    const input = join(root, 'request.json');
    await writeFile(input, JSON.stringify({ op: 'delete', table: 'items', key: 'consumable_potion' }));
    const before = await sources(root);
    expect(cli(root, ['edit', '--input', input])).toMatchObject({ status: 2, reply: {
      data: { applied: false }, error: { code: 'REVISION_REQUIRED' },
    } });
    expect(await sources(root)).toEqual(before);
  });
});
