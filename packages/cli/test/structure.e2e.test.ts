import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic, Table, TableSchema } from '@vibe-spec/core';
import { suggestResourceName } from '@vibe-spec/core/names';
import { afterEach, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const roots: string[] = [];
interface Reply<T = unknown> {
  ok: boolean;
  revision: string | null;
  data: T;
  diagnostics: Diagnostic[];
  error?: { code: string; message: string };
}
function cli<T = unknown>(root: string, args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  const reply = JSON.parse(result.stdout) as Reply<T>;
  expect(reply).toMatchObject({ ok: expect.any(Boolean), diagnostics: expect.any(Array) });
  expect(reply).toHaveProperty('data');
  expect(reply).toHaveProperty('revision');
  return { status: result.status, reply };
}
async function planning(seed = true) {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-cli-structure-'));
  roots.push(directory);
  const root = join(directory, 'planning');
  expect(cli(directory, ['init', root]).status).toBe(0);
  if (seed) {
    await writeFile(join(root, 'schemas/inventory.yaml'), `primary_key: LegacyKey
columns:
  LegacyKey:
    type: string
    label: "Key"
  label:
    type: text
  price:
    type: decimal
  quantity:
    type: integer
  LegacyNote:
    type: text
unique:
  - [label, price]
  - [price]
  - [quantity]
`);
    const source = `schema: inventory
rows:
  - LegacyKey: "alpha"
    label: "Alpha"
    price: "+001.2300E+0002"
    quantity: "900719925474099312345678901234567890"
    LegacyNote: "001"
  - LegacyKey: "beta"
    label: "Beta"
    price: "-0.000"
    quantity: "001"
    LegacyNote: "00042.0000"
`;
    await writeFile(join(root, 'tables/inventory.yaml'), source);
    await writeFile(join(root, 'tables/archive.yaml'), source);
    expect(cli(root, ['fmt']).status).toBe(0);
  }
  return root;
}
function revision(root: string): string {
  const result = cli(root, ['validate']);
  expect(result.reply.revision).toMatch(/^[a-f0-9]{64}$/);
  return result.reply.revision!;
}
// Write the operation JSON literally so numeric spellings reach the CLI unchanged.
async function edit(root: string, input: string, expected = revision(root), command = 'edit') {
  const path = join(root, 'operation.json');
  await writeFile(path, input);
  return cli(root, [command, '--input', path, '--expect-revision', expected]);
}
function rename(root: string, kind: string, path: string, to: string) {
  return cli(root, ['rename', kind, path, '--to', to, '--expect-revision', revision(root)]);
}
function table(root: string, name: string) {
  const result = cli<{ schema: TableSchema; table: Table }>(root, ['read', name]);
  expect(result.status).not.toBe(2);
  return result.reply.data;
}
async function sources(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const directory of ['schemas', 'tables']) {
    for (const name of (await readdir(join(root, directory))).sort()) {
      files[directory + '/' + name] = await readFile(join(root, directory, name), 'utf8');
    }
  }
  return files;
}
function verify(root: string, diagnosticCodes: string[] = []) {
  const status = diagnosticCodes.length ? 1 : 0;
  const validation = cli(root, ['validate']);
  expect(validation.status).toBe(status);
  expect([...new Set(validation.reply.diagnostics.map(item => item.code))].sort())
    .toEqual([...diagnosticCodes].sort());
  // Structure/rename may preserve noncanonical source; fmt is an explicit operation.
  expect(cli(root, ['fmt']).status).toBe(status);
  expect(cli(root, ['fmt', '--check'])).toMatchObject({
    status, reply: { data: { changed: [] } },
  });
}

it.each(['a'.repeat(250), '가'.repeat(83) + 'a'])('creates and edits a table at the portable filename byte limit (%#)', async name => {
  const root = await planning(false);
  expect((await edit(root, JSON.stringify({ op: 'table-create', table: name,
    key: { code: 'key', label: '코드' } }))).status).toBe(0);
  expect((await edit(root, JSON.stringify({ op: 'column-add', table: name,
    column: 'value', definition: { type: 'decimal' } }))).status).toBe(0);
  expect((await edit(root, JSON.stringify({ op: 'create', table: name,
    row: { key: 'a', value: '12.5000' } }))).status).toBe(0);
  expect((await edit(root, JSON.stringify({ op: 'update', table: name,
    key: 'a', values: { value: '0.005' } }))).status).toBe(0);
  expect(table(root, name).table.rows).toEqual([{ key: 'a', value: '0.005' }]);
  verify(root);
  expect(await readdir(join(root, 'tables'))).toEqual([name + '.yaml']);
  expect(await readdir(join(root, 'schemas'))).toEqual([name + '.yaml']);
}, 30_000);

async function refused(root: string, input: string, code?: string) {
  const before = await sources(root);
  const expected = revision(root);
  const result = await edit(root, input, expected);
  expect(result).toMatchObject({ status: 2, reply: {
    ok: false, revision: expected, data: { applied: false, changed: [] },
    error: code ? { code } : { code: expect.any(String) },
  } });
  expect(await sources(root)).toEqual(before);
  return result;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('structure edits through actual CLI processes', () => {
  it.each(['CON', 'lpt1.log', 'bad:name', 'bad\\name', 'ending.', 'ending '])(
    'reports the core filename error and suggestion for %s without creating or renaming files', async name => {
      const root = await planning();
      const expected = await sources(root);
      const created = await refused(root, JSON.stringify({
        op: 'table-create', table: name, key: { code: 'id', label: 'Key' },
      }), 'NAME_INVALID');
      expect(created.reply.error?.message).toContain('이름 제안: ' + suggestResourceName(name));
      for (const kind of ['table', 'schema']) {
        const result = rename(root, kind, 'inventory', name);
        expect(result).toMatchObject({ status: 2, reply: {
          data: { applied: false, changed: [] }, error: { code: 'NAME_INVALID' },
        } });
        expect(result.reply.error?.message).toContain('이름 제안: ' + suggestResourceName(name));
      }
      expect(await sources(root)).toEqual(expected);
    },
  );

  it('reports case-insensitive create and rename collisions with a usable core suggestion', async () => {
    const root = await planning();
    expect((await edit(root, '{"op":"table-create","table":"other","key":{"code":"id","label":"Key"}}')).status).toBe(0);
    const before = await sources(root);
    const creation = await refused(root, '{"op":"table-create","table":"INVENTORY","key":{"code":"id","label":"Key"}}', 'NAME_EXISTS');
    expect(creation.reply.error?.message).toContain('이름 제안: INVENTORY_2');
    for (const [kind, name] of [['table', 'ARCHIVE'], ['schema', 'OTHER']] as const) {
      const result = rename(root, kind, 'inventory', name);
      expect(result).toMatchObject({ status: 2, reply: {
        data: { applied: false, changed: [] }, error: { code: 'NAME_EXISTS' },
      } });
      expect(result.reply.error?.message).toContain('이름 제안: ' + name + '_2');
    }
    expect(await sources(root)).toEqual(before);
  });

  it('creates an empty table and its sole Key schema, rejecting duplicate and invalid names', async () => {
    const root = await planning(false);
    const operation = '{"op":"table-create","table":"보상 표","key":{"code":"id_2","label":"Key / 코드"}}';
    expect(await edit(root, operation)).toMatchObject({ status: 0, reply: {
      ok: true, data: { applied: true, changed: ['schemas/보상 표.yaml', 'tables/보상 표.yaml'] }, diagnostics: [],
    } });
    expect(table(root, '보상 표')).toEqual({
      schema: { primary_key: 'id_2', columns: { id_2: { type: 'string', label: 'Key / 코드' } } },
      table: { schema: '보상 표', rows: [] },
    });
    await refused(root, operation, 'NAME_EXISTS');
    await refused(root, '{"op":"table-create","table":"nested/table","key":{"code":"id","label":"Key"}}');
    await refused(root, '{"op":"table-create","table":"","key":{"code":"id","label":"Key"}}');
    verify(root);
  });

  it('adds a required shared column without filling rows or blocking on value diagnostics', async () => {
    const root = await planning();
    const before = await sources(root);
    const result = await edit(root, `{
      "op":"column-add","table":"inventory","column":"amount_2",
      "definition":{"type":"decimal","label":"Amount / 수량","required":true,"minimum":"-0.000"},
      "position":{"anchor":"price","side":"before"}
    }`);
    expect(result).toMatchObject({ status: 1, reply: {
      ok: false, data: { applied: true, changed: ['schemas/inventory.yaml'] },
    } });
    expect(result.reply.error).toBeUndefined();
    expect(result.reply.diagnostics.map(item => item.path).sort()).toEqual([
      'archive/alpha/amount_2', 'archive/beta/amount_2',
      'inventory/alpha/amount_2', 'inventory/beta/amount_2',
    ]);
    for (const name of ['inventory', 'archive']) {
      const read = table(root, name);
      expect(read.schema.columns.amount_2).toEqual({
        type: 'decimal', label: 'Amount / 수량', required: true, minimum: '-0.000',
      });
      expect(Object.keys(read.schema.columns)).toEqual(['LegacyKey', 'label', 'amount_2', 'price', 'quantity', 'LegacyNote']);
      expect(read.table.rows.every(row => !Object.hasOwn(row, 'amount_2'))).toBe(true);
      expect(await readFile(join(root, 'tables/' + name + '.yaml'), 'utf8')).toBe(before['tables/' + name + '.yaml']);
    }
    verify(root, ['VALUE_REQUIRED']);
    expect(await edit(root, '{"op":"column-update","table":"archive","column":"amount_2","changes":{"required":false}}').then(result => result.status)).toBe(0);
    verify(root);
  });

  it('changes type and label without converting existing values, including legacy uppercase fields', async () => {
    const root = await planning();
    const before = await sources(root);
    expect(await edit(root, '{"op":"column-update","table":"inventory","column":"price","changes":{"type":"integer","label":"Count / 개수"}}'))
      .toMatchObject({ status: 1, reply: { data: { applied: true, changed: ['schemas/inventory.yaml'] } } });
    for (const name of ['inventory', 'archive']) {
      expect(table(root, name).schema.columns.price).toEqual({ type: 'integer', label: 'Count / 개수' });
      expect(table(root, name).table.rows.map(row => row.price)).toEqual(['+001.2300E+0002', '-0.000']);
    }
    verify(root, ['VALUE_TYPE_OR_RANGE']);
    expect(await edit(root, '{"op":"column-update","table":"archive","column":"price","changes":{"type":"text"}}'))
      .toMatchObject({ status: 0, reply: { data: { applied: true } } });
    expect(await edit(root, '{"op":"column-update","table":"inventory","column":"LegacyNote","changes":{"label":"Legacy / 메모"}}'))
      .toMatchObject({ status: 0, reply: { data: { applied: true } } });
    for (const name of ['inventory', 'archive']) {
      expect(table(root, name).schema.columns.LegacyNote?.label).toBe('Legacy / 메모');
      expect(await readFile(join(root, 'tables/' + name + '.yaml'), 'utf8')).toBe(before['tables/' + name + '.yaml']);
    }
    verify(root);
  });

  it('moves shared schema columns on either side of anchors while keeping row bytes identical', async () => {
    const root = await planning();
    const before = await sources(root);
    expect(await edit(root, '{"op":"column-move","table":"inventory","column":"LegacyNote","position":{"anchor":"LegacyKey","side":"before"}}'))
      .toMatchObject({ status: 0, reply: { data: { changed: ['schemas/inventory.yaml'] } } });
    expect(Object.keys(table(root, 'archive').schema.columns)).toEqual(['LegacyNote', 'LegacyKey', 'label', 'price', 'quantity']);
    expect(await edit(root, '{"op":"column-move","table":"archive","column":"LegacyKey","position":{"anchor":"price","side":"after"}}'))
      .toMatchObject({ status: 0, reply: { data: { changed: ['schemas/inventory.yaml'] } } });
    for (const name of ['inventory', 'archive']) {
      const read = table(root, name);
      expect(Object.keys(read.schema.columns)).toEqual(['LegacyNote', 'label', 'price', 'LegacyKey', 'quantity']);
      expect(read.schema.primary_key).toBe('LegacyKey');
      expect(await readFile(join(root, 'tables/' + name + '.yaml'), 'utf8')).toBe(before['tables/' + name + '.yaml']);
    }
    expect(cli(root, ['fmt', '--check'])).toMatchObject({ status: 0, reply: { data: { changed: [] } } });
    verify(root);
    for (const name of ['inventory', 'archive']) {
      expect(await readFile(join(root, 'tables/' + name + '.yaml'), 'utf8')).toBe(before['tables/' + name + '.yaml']);
    }
  });

  it('renames shared columns through the existing command, updating row fields, unique and primary_key', async () => {
    const root = await planning();
    expect(rename(root, 'column', 'inventory/*/price', 'unit_price').status).toBe(0);
    expect(rename(root, 'column', 'archive/*/LegacyKey', 'id').status).toBe(0);
    for (const name of ['inventory', 'archive']) {
      const read = table(root, name);
      expect(read.schema.primary_key).toBe('id');
      expect(read.schema.unique).toEqual([['label', 'unit_price'], ['unit_price'], ['quantity']]);
      expect(read.schema.columns).not.toHaveProperty('price');
      expect(read.schema.columns).not.toHaveProperty('LegacyKey');
      expect(read.table.rows.map(row => row.unit_price)).toEqual(['+001.2300E+0002', '-0.000']);
      expect(read.table.rows.map(row => row.id)).toEqual(['alpha', 'beta']);
      expect(read.table.rows.every(row => !Object.hasOwn(row, 'price') && !Object.hasOwn(row, 'LegacyKey'))).toBe(true);
      expect(cli(root, ['read', name + '/alpha/unit_price']).reply.data).toEqual({ value: '+001.2300E+0002', present: true });
    }
    verify(root);
  });

  it('protects the Key column and removes deleted data plus entire affected unique constraints', async () => {
    const root = await planning();
    await refused(root, '{"op":"column-delete","table":"inventory","column":"LegacyKey"}', 'KEY_COLUMN_REQUIRED');
    expect(await edit(root, '{"op":"column-delete","table":"inventory","column":"price"}'))
      .toMatchObject({ status: 0, reply: { data: { applied: true, changed: expect.arrayContaining([
        'schemas/inventory.yaml', 'tables/inventory.yaml', 'tables/archive.yaml',
      ]) } } });
    for (const name of ['inventory', 'archive']) {
      const read = table(root, name);
      expect(read.schema.columns).not.toHaveProperty('price');
      expect(read.schema.unique).toEqual([['quantity']]);
      expect(read.table.rows.every(row => !Object.hasOwn(row, 'price'))).toBe(true);
      expect(read.table.rows.map(row => row.quantity)).toEqual(['900719925474099312345678901234567890', '001']);
      expect(read.table.rows.map(row => row.LegacyNote)).toEqual(['001', '00042.0000']);
    }
    verify(root);
  });

  it.each([
    '{"op":"column-add","table":"inventory","column":"NewCode","definition":{"type":"text"}}',
    '{"op":"column-add","table":"inventory","column":"new-code","definition":{"type":"text"}}',
    '{"op":"column-add","table":"inventory","column":"새열","definition":{"type":"text"}}',
    '{"op":"table-create","table":"new","key":{"code":"NewKey","label":"Key"}}',
    '{"op":"table-create","table":"new","key":{"code":"key-code","label":"Key"}}',
  ])('rejects invalid new column or Key codes through core: %s', async operation => {
    const root = await planning();
    await refused(root, operation, 'INVALID_COLUMN_CODE');
    verify(root);
  });

  it.each([
    '{"op":"column-add","table":"inventory","column":"price","definition":{"type":"text"}}',
    '{"op":"column-add","table":"inventory","column":"extra","definition":{"type":"unknown"}}',
    '{"op":"column-add","table":"inventory","column":"extra","definition":{"type":"decimal","minimum":0.1}}',
    '{"op":"column-update","table":"inventory","column":"price","changes":{"minimum":0.1}}',
    '{"op":"column-move","table":"inventory","column":"price","position":{"anchor":"missing","side":"before"}}',
    '{"op":"column-move","table":"inventory","column":"price","position":{"anchor":"label","side":"middle"}}',
    '[{"op":"update","table":"inventory","key":"alpha","values":{"LegacyNote":"0002"}}]',
    'null',
  ])('rejects invalid single edits without writing any source: %s', async operation => {
    const root = await planning();
    await refused(root, operation);
    verify(root);
  });

  it('keeps row create/update/delete on edit and multiple row changes on apply', async () => {
    const root = await planning();
    expect(await edit(root, `{
      "op":"create","table":"inventory","row":{"LegacyKey":"gamma","price":"00042.0000",
      "quantity":"900719925474099312345678901234567891","LegacyNote":"+000.123456789012345678900E+0002"}
    }`)).toMatchObject({ status: 0, reply: { data: { applied: true } } });
    expect(await edit(root, '{"op":"update","table":"inventory","key":"gamma","values":{"price":"00043.0000"}}'))
      .toMatchObject({ status: 0, reply: { data: { applied: true } } });
    expect(cli(root, ['read', 'inventory/gamma']).reply.data).toMatchObject({
      price: '00043.0000', quantity: '900719925474099312345678901234567891', LegacyNote: '+000.123456789012345678900E+0002',
    });
    expect(await edit(root, `[
      {"op":"update","table":"inventory","key":"alpha","values":{"LegacyNote":"0003.0000"}},
      {"op":"update","table":"archive","key":"beta","values":{"LegacyNote":"-0.000"}}
    ]`, revision(root), 'apply')).toMatchObject({ status: 0, reply: { data: { applied: true } } });
    expect(cli(root, ['read', 'inventory/alpha/LegacyNote']).reply.data).toEqual({ value: '0003.0000', present: true });
    expect(cli(root, ['read', 'archive/beta/LegacyNote']).reply.data).toEqual({ value: '-0.000', present: true });
    expect(await edit(root, '{"op":"delete","table":"inventory","key":"gamma"}'))
      .toMatchObject({ status: 0, reply: { data: { applied: true } } });
    expect(cli(root, ['read', 'inventory/gamma']).reply.error?.code).toBe('PATH_NOT_FOUND');
    const before = await sources(root);
    expect(await edit(root, '{"op":"update","table":"inventory","key":"alpha","values":{"LegacyNote":"0004"}}', revision(root), 'apply'))
      .toMatchObject({ status: 2, reply: { data: { applied: false }, error: { code: 'INVALID_EDIT' } } });
    expect(await edit(root, '[{"op":"column-delete","table":"inventory","column":"LegacyNote"}]', revision(root), 'apply'))
      .toMatchObject({ status: 2, reply: { data: { applied: false }, error: { code: 'INVALID_EDIT' } } });
    expect(await sources(root)).toEqual(before);
    verify(root);
  });

  it('renames table ref declarations and rejects deletion even when the referring table has no rows', async () => {
    const root = await planning();
    expect(await edit(root, '{"op":"table-create","table":"links","key":{"code":"id","label":"Key"}}'))
      .toMatchObject({ status: 0 });
    expect(await edit(root, '{"op":"column-add","table":"links","column":"target","definition":{"type":"ref","table":"inventory"}}'))
      .toMatchObject({ status: 0 });
    expect(await edit(root, '{"op":"create","table":"links","row":{"id":"link","target":"alpha"}}'))
      .toMatchObject({ status: 0 });
    expect(rename(root, 'table', 'inventory', 'goods').status).toBe(0);
    expect(table(root, 'goods').table.schema).toBe('inventory');
    expect(table(root, 'links').schema.columns.target).toEqual({ type: 'ref', table: 'goods' });
    expect(cli(root, ['read', 'links/link/target']).reply.data).toEqual({ value: 'alpha', present: true });
    expect((await readdir(join(root, 'tables'))).sort()).toEqual(['archive.yaml', 'goods.yaml', 'links.yaml']);
    verify(root);
    await refused(root, '{"op":"table-delete","table":"goods"}', 'DELETE_RESTRICTED');
    expect(await edit(root, '{"op":"delete","table":"links","key":"link"}')).toMatchObject({ status: 0 });
    expect(table(root, 'links').table.rows).toEqual([]);
    // No on_delete restriction is declared: a schema reference itself protects a table.
    await refused(root, '{"op":"table-delete","table":"goods"}', 'DELETE_RESTRICTED');
    verify(root);
  }, 60_000); // This scenario intentionally launches over 25 real CLI processes.

  it('removes a table with its exclusive schema while preserving a schema still used by another table', async () => {
    const root = await planning();
    expect(await edit(root, '{"op":"table-create","table":"scratch","key":{"code":"id","label":"Key"}}'))
      .toMatchObject({ status: 0 });
    const before = await sources(root);
    expect(await edit(root, '{"op":"table-delete","table":"scratch"}')).toMatchObject({ status: 0, reply: {
      data: { applied: true, changed: ['schemas/scratch.yaml', 'tables/scratch.yaml'] },
    } });
    expect(await sources(root)).toEqual(Object.fromEntries(Object.entries(before)
      .filter(([path]) => path !== 'schemas/scratch.yaml' && path !== 'tables/scratch.yaml')));
    expect(await edit(root, '{"op":"table-delete","table":"inventory"}')).toMatchObject({ status: 0, reply: {
      data: { applied: true, changed: ['tables/inventory.yaml'] },
    } });
    expect(await readFile(join(root, 'schemas/inventory.yaml'), 'utf8')).toBe(before['schemas/inventory.yaml']);
    expect(await readFile(join(root, 'tables/archive.yaml'), 'utf8')).toBe(before['tables/archive.yaml']);
    verify(root);
    expect(await edit(root, '{"op":"table-delete","table":"archive"}')).toMatchObject({ status: 0, reply: {
      data: { applied: true, changed: ['schemas/inventory.yaml', 'tables/archive.yaml'] },
    } });
    expect(await sources(root)).toEqual({});
    verify(root);
  });

  it('does not overwrite a duplicate table filename even when its YAML cannot be parsed', async () => {
    const root = await planning();
    const broken = 'schema: [unterminated\n';
    await writeFile(join(root, 'tables/occupied.yaml'), broken);
    await refused(root, '{"op":"table-create","table":"occupied","key":{"code":"id","label":"Key"}}', 'NAME_EXISTS');
    const before = await sources(root);
    expect(rename(root, 'table', 'inventory', 'occupied')).toMatchObject({ status: 2, reply: {
      data: { applied: false, changed: [] }, error: { code: 'NAME_EXISTS' },
    } });
    expect(await sources(root)).toEqual(before);
    expect(cli(root, ['validate']).reply.diagnostics).toContainEqual(expect.objectContaining({
      code: 'YAML_SYNTAX', file: 'tables/occupied.yaml',
    }));
    await rm(join(root, 'tables/occupied.yaml'));
    verify(root);
  });

  it('preserves an occupied malformed schema when allocating a schema for a new table', async () => {
    const root = await planning(false);
    const broken = 'primary_key: id\nprimary_key: duplicate\n';
    await writeFile(join(root, 'schemas/rewards.yaml'), broken);
    const result = await edit(root, '{"op":"table-create","table":"rewards","key":{"code":"id","label":"Key"}}');
    expect(result).toMatchObject({ status: 1, reply: { data: { applied: true } } });
    expect(await readFile(join(root, 'schemas/rewards.yaml'), 'utf8')).toBe(broken);
    const created = table(root, 'rewards');
    expect(created.table.schema).not.toBe('rewards');
    expect(created.schema).toEqual({ primary_key: 'id', columns: { id: { type: 'string', label: 'Key' } } });
    expect(created.table.rows).toEqual([]);
    await rm(join(root, 'schemas/rewards.yaml'));
    verify(root);
  });

  it('rejects a stale structure revision after another CLI process changes a row', async () => {
    const root = await planning();
    const stale = revision(root);
    const changed = await edit(root, '{"op":"update","table":"archive","key":"alpha","values":{"LegacyNote":"0000002"}}', stale);
    expect(changed.status).toBe(0);
    expect(changed.reply.revision).not.toBe(stale);
    const before = await sources(root);
    expect(await edit(root, '{"op":"column-delete","table":"inventory","column":"LegacyNote"}', stale))
      .toMatchObject({ status: 2, reply: {
        revision: changed.reply.revision, data: { applied: false, changed: [] }, error: { code: 'STALE_REVISION' },
      } });
    expect(await sources(root)).toEqual(before);
    expect(cli(root, ['read', 'archive/alpha/LegacyNote']).reply.data).toEqual({ value: '0000002', present: true });
    verify(root);
  });
});
