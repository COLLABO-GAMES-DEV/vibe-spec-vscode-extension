import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cell, Diagnostic, ImportInspection, ImportMapping, ImportPlan, TableSchema } from '@vibe-spec/core';
import { afterEach, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const fixtures = fileURLToPath(new URL('../../core/test/fixtures/', import.meta.url));
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const { parse } = require('csv-parse/sync') as { parse: (source: string) => string[][] };
const roots: string[] = [];
interface Reply<T = unknown> {
  ok: boolean;
  revision: string | null;
  data: T;
  diagnostics: Diagnostic[];
  error?: { code: string; message: string };
}
function cli<T = unknown>(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args, '--json'], {
    cwd, encoding: 'utf8', timeout: 10_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  const reply = JSON.parse(result.stdout) as Reply<T>;
  expect(reply).toMatchObject({ ok: expect.any(Boolean), diagnostics: expect.any(Array) });
  expect(reply).toHaveProperty('revision');
  expect(reply).toHaveProperty('data');
  return { status: result.status, reply };
}
async function temp() {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-cli-import-'));
  roots.push(directory);
  return directory;
}
async function setup(existing = false) {
  const directory = await temp();
  const root = join(directory, 'planning');
  if (existing) await cp(join(fixtures, 'project'), root, { recursive: true });
  else expect(cli(directory, ['init', root]).status).toBe(0);
  return { directory, root };
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      for (const [file, source] of Object.entries(await snapshot(join(root, entry.name)))) {
        files[entry.name + '/' + file] = source;
      }
    } else files[entry.name] = await readFile(join(root, entry.name), 'utf8');
  }
  return files;
}
const itemDefinition: TableSchema = {
  primary_key: 'key',
  columns: {
    key: { type: 'string' }, source: { type: 'string' },
    lore: { type: 'string' }, note: { type: 'string' },
  },
};
function itemMapping(sheet: string): ImportMapping {
  return {
    table: 'items', schema: 'items', definition: itemDefinition, sheet,
    header_row: 2, data_start_row: 3, numeric: 'stored',
    columns: { B: 'key', C: 'source', D: 'lore', E: 'note' },
  };
}
async function plan(directory: string, root: string, file: string, mapping: ImportMapping, bom = false) {
  const input = join(directory, 'mapping.json');
  await writeFile(input, (bom ? '\uFEFF' : '') + JSON.stringify(mapping));
  return cli<ImportPlan>(directory, ['import', 'plan', file, '--mapping', input, '--project', root]);
}
async function apply(directory: string, root: string, preview: Reply<ImportPlan>, wrapped = true,
  revision = preview.revision!, bom = false) {
  const input = join(directory, 'plan.json');
  await writeFile(input, (bom ? '\uFEFF' : '') + JSON.stringify(wrapped ? preview : preview.data));
  return cli(directory, ['import', 'apply', '--input', input, '--expect-revision', revision, '--project', root]);
}
async function itemPlan() {
  const state = await setup();
  const file = join(state.directory, 'items.csv');
  await cp(join(fixtures, 'import/items.csv'), file);
  const preview = await plan(state.directory, state.root, file, itemMapping('items'));
  expect(preview.status).toBe(0);
  expect(preview.reply.data.canApply).toBe(true);
  return { ...state, file, preview: preview.reply };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('import through actual CLI processes', () => {
  it('accepts UTF-8 BOM mapping and plan files in Windows PowerShell format', async () => {
    const { directory, root } = await setup();
    const file = join(directory, 'items.csv');
    await cp(join(fixtures, 'import/items.csv'), file);
    const preview = await plan(directory, root, file, itemMapping('items'), true);
    expect(preview.status).toBe(0);
    expect(await apply(directory, root, preview.reply, true, preview.reply.revision!, true))
      .toMatchObject({ status: 0, reply: { ok: true, data: { applied: true }, diagnostics: [] } });
    expect(cli(directory, ['read', 'items', '--project', root]).status).toBe(0);
  });

  it.each(['csv', 'xlsx'] as const)('imports all 145 %s fixture rows from B2 without changing their text', async format => {
    const directory = await temp();
    const file = join(directory, 'items.' + format);
    await cp(join(fixtures, 'import/items.' + format), file);
    const original = await readFile(file);
    // Inspection is useful before a planning repository exists.
    const inspection = cli<ImportInspection>(directory, ['import', 'inspect', file]);
    expect(inspection).toMatchObject({ status: 0, reply: {
      ok: true, revision: null, diagnostics: [], data: { format, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    } });
    expect(inspection.reply.data.sheets).toHaveLength(1);
    const sheet = inspection.reply.data.sheets[0]!;
    expect(sheet.name).toBe(format === 'xlsx' ? 'Synthetic Items' : 'items');
    expect(sheet).toMatchObject({ header_row: 2, start_column: 'B', data_start_row: 3, rowCount: 147 });
    expect(sheet.cells.B2?.raw).toBe('Key');
    expect(sheet.cells.C2?.raw).toBe('Source');
    expect(sheet.cells.B3?.raw).toBe('sample_item_001');
    expect(sheet.cells.B147?.raw).toBe('sample_item_145');
    expect(await readdir(directory)).toEqual(['items.' + format]);

    const root = join(directory, 'planning');
    const initialized = cli(directory, ['init', root]);
    expect(initialized.status).toBe(0);
    const before = await snapshot(root);
    const preview = await plan(directory, root, file, itemMapping(sheet.name));
    expect(preview).toMatchObject({ status: 0, reply: {
      ok: true, revision: initialized.reply.revision, diagnostics: [],
      data: { canApply: true, revision: initialized.reply.revision, sourceHash: inspection.reply.data.sourceHash },
    } });
    expect(preview.reply.data.files.sort()).toEqual(['schemas/items.yaml', 'tables/items.yaml']);
    expect(preview.reply.data.rows.map(row => row.sourceRow)).toEqual(Array.from({ length: 145 }, (_, i) => i + 3));
    expect(await snapshot(root)).toEqual(before);

    // The CSV parser is an independent text oracle for both synthetic formats.
    const expected = parse(await readFile(join(fixtures, 'import/items.csv'), 'utf8')).slice(2)
      .map(row => ({ key: row[1]!, source: row[2]!, lore: row[3]!, note: row[4]! }));
    function checkRows(rows: Record<string, Cell>[]) {
      expect(rows).toHaveLength(145);
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(expect.arrayContaining(['key', 'source', 'lore']));
      const normalized = rows.map(row => {
        expect(Object.keys(row).every(column => Object.hasOwn(itemDefinition.columns, column))).toBe(true);
        return { key: row.key, source: row.source, lore: row.lore ?? '', note: row.note ?? '' };
      });
      expect(normalized.sort((a, b) => String(a.key).localeCompare(String(b.key))))
        .toEqual([...expected].sort((a, b) => a.key.localeCompare(b.key)));
    }
    checkRows(preview.reply.data.rows.map(row => row.values));
    // Exercise both the complete JSON reply and the bare plan input contracts.
    const applied = await apply(directory, root, preview.reply, format === 'csv');
    expect(applied).toMatchObject({ status: 0, reply: { ok: true, data: {
      applied: true, changed: expect.arrayContaining(['schemas/items.yaml', 'tables/items.yaml']),
    }, diagnostics: [] } });
    expect(applied.reply.revision).not.toBe(preview.reply.revision);
    expect(applied.reply.data).not.toHaveProperty('partial');
    const read = cli<{ schema: TableSchema; table: { schema: string; rows: Record<string, Cell>[] } }>(directory,
      ['read', 'items', '--project', root]);
    expect(read.status).toBe(0);
    expect(read.reply.data.schema).toEqual(itemDefinition);
    expect(read.reply.data.table.schema).toBe('items');
    checkRows(read.reply.data.table.rows);
    expect(cli(directory, ['validate', '--project', root]).status).toBe(0);
    expect(cli(directory, ['fmt', '--check', '--project', root]).status).toBe(0);
    expect(await readFile(file)).toEqual(original);
  });

  it('preserves numeric literals, internal empty cells and raw reference Keys in a user-defined schema', async () => {
    const { directory, root } = await setup(true);
    const file = join(directory, 'prices.csv');
    const numbers = [
      ['long', '900719925474099312345678901234567890', '+000.1234567890123456789012345678900E+0002'],
      ['zero', '0000', '-0.000'],
      ['signed', '+00042', '00042.0000'],
      ['negative', '-00042', '-001.2300e-0002'],
    ];
    await writeFile(file, ',,,,,,\n,SKU,Currency,Count,Price,Note,After\n' +
      numbers.map(([key, count, price]) => `,${key},currency_gold,${count},${price},,tail`).join('\n') + '\n');
    const mapping: ImportMapping = {
      table: 'prices', schema: 'prices', sheet: 'prices', header_row: 2, data_start_row: 3,
      numeric: 'stored', columns: { B: 'sku', C: 'currency', D: 'count', E: 'price', F: 'note', G: 'after' },
      definition: { primary_key: 'sku', columns: {
        sku: { type: 'string' }, currency: { type: 'ref', table: 'items' }, count: { type: 'integer' },
        price: { type: 'decimal' }, note: { type: 'text' }, after: { type: 'string' },
      } },
    };
    const before = await snapshot(root);
    const preview = await plan(directory, root, file, mapping);
    expect(preview.status).toBe(0);
    expect(await snapshot(root)).toEqual(before);
    expect((await apply(directory, root, preview.reply)).status).toBe(0);
    const output = await readFile(join(root, 'tables/prices.yaml'), 'utf8');
    for (const [sku, count, price] of numbers) {
      const result = cli<Record<string, Cell>>(directory, ['read', 'prices/' + sku, '--project', root]);
      expect(result).toMatchObject({ status: 0, reply: { data: { sku, currency: 'currency_gold', count, price, after: 'tail' } } });
      expect(result.reply.data.note ?? '').toBe('');
      expect(output).toContain(JSON.stringify(count));
      expect(output).toContain(JSON.stringify(price));
    }
    for (const file of ['schemas/items.yaml', 'tables/items.yaml', 'schemas/offers.yaml', 'tables/offers.yaml']) {
      expect(await readFile(join(root, file), 'utf8')).toBe(before[file]);
    }
    expect(cli(directory, ['validate', '--project', root]).status).toBe(0);
  });

  it('appends TSV rows using an existing schema and refuses a repeat import of the same Keys', async () => {
    const { directory, root } = await setup(true);
    const file = join(directory, 'extra.tsv');
    await writeFile(file, '\t\t\t\t\n\tKey\tName\tKind\tNote\n\tcurrency_new\t새 재화\tcurrency\t001\n');
    const mapping: ImportMapping = {
      table: 'items', schema: 'items', sheet: 'extra', numeric: 'stored', header_row: 2, data_start_row: 3,
      columns: { B: 'code', C: 'name', D: 'kind', E: 'note' },
    };
    const schema = await readFile(join(root, 'schemas/items.yaml'), 'utf8');
    const oldRows = cli<{ table: { rows: Record<string, Cell>[] } }>(directory, ['read', 'items', '--project', root])
      .reply.data.table.rows;
    const before = await snapshot(root);
    const preview = await plan(directory, root, file, mapping);
    expect(preview).toMatchObject({ status: 0, reply: { data: { canApply: true, files: ['tables/items.yaml'] } } });
    expect(await snapshot(root)).toEqual(before);
    expect(await apply(directory, root, preview.reply)).toMatchObject({ status: 0, reply: {
      data: { applied: true, changed: ['tables/items.yaml'] }, diagnostics: [],
    } });
    const rows = cli<{ table: { rows: Record<string, Cell>[] } }>(directory, ['read', 'items', '--project', root])
      .reply.data.table.rows;
    expect(rows).toHaveLength(oldRows.length + 1);
    expect(rows).toEqual(expect.arrayContaining([...oldRows,
      { code: 'currency_new', name: '새 재화', kind: 'currency', note: '001' }]));
    expect(await readFile(join(root, 'schemas/items.yaml'), 'utf8')).toBe(schema);
    const applied = await snapshot(root);
    const repeated = await plan(directory, root, file, mapping);
    expect(repeated).toMatchObject({ status: 1, reply: { ok: false, data: { canApply: false } } });
    expect(repeated.reply.data.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_KEY_DUPLICATE' }));
    expect(await apply(directory, root, repeated.reply)).toMatchObject({ status: 2, reply: {
      data: { applied: false, changed: [] }, error: { code: 'IMPORT_BLOCKED' },
    } });
    expect(await snapshot(root)).toEqual(applied);
  });

  it.each([
    ['duplicate', ',same,First,,\n,same,Second,,\n'],
    ['empty', ',,Missing Key,,\n'],
  ])('returns exit 1 and a non-applicable preview for a %s Key without writing', async (_label, rows) => {
    const { directory, root } = await setup();
    const file = join(directory, 'items.csv');
    await writeFile(file, ',,,,\n,Key,Source,Lore,Note\n' + rows);
    const before = await snapshot(root);
    const preview = await plan(directory, root, file, itemMapping('items'));
    expect(preview).toMatchObject({ status: 1, reply: { ok: false, data: { canApply: false } } });
    expect(preview.reply.error).toBeUndefined();
    expect(preview.reply.diagnostics).toEqual(preview.reply.data.diagnostics);
    expect(preview.reply.data.issues.some(issue => issue.severity === 'error') || preview.reply.diagnostics.length > 0).toBe(true);
    expect(await snapshot(root)).toEqual(before);
    expect(await apply(directory, root, preview.reply)).toMatchObject({ status: 2, reply: {
      ok: false, data: { applied: false, changed: [] }, error: { code: expect.any(String) },
    } });
    expect(await snapshot(root)).toEqual(before);
  });

  it('forwards reference diagnostics from the planned project before any files exist', async () => {
    const { directory, root } = await setup(true);
    const file = join(directory, 'links.csv');
    await writeFile(file, ',,,,\n,Key,Source,Lore,Note\n,first,missing_target,,\n');
    const mapping = itemMapping('links');
    mapping.table = mapping.schema = 'links';
    mapping.definition = { primary_key: 'key', columns: {
      ...itemDefinition.columns, source: { type: 'ref', table: 'items' },
    } };
    const before = await snapshot(root);
    const preview = await plan(directory, root, file, mapping);
    expect(preview.status).toBe(1);
    expect(preview.reply.diagnostics).toEqual(preview.reply.data.diagnostics);
    expect(preview.reply.diagnostics).toContainEqual(expect.objectContaining({
      code: 'REF_MISSING', path: 'links/first/source',
    }));
    expect(await snapshot(root)).toEqual(before);
  });

  it.each(['old', 'current'] as const)('refuses a stale plan with the %s caller revision', async expected => {
    const { directory, root, preview } = await itemPlan();
    await writeFile(join(root, 'schemas/other.yaml'), 'primary_key: id\ncolumns:\n  id:\n    type: string\n');
    const current = cli(directory, ['validate', '--project', root]);
    expect(current.status).toBe(0);
    expect(current.reply.revision).not.toBe(preview.revision);
    const before = await snapshot(root);
    const result = await apply(directory, root, preview, true, expected === 'old' ? preview.revision! : current.reply.revision!);
    expect(result).toMatchObject({ status: 2, reply: {
      revision: current.reply.revision, data: { applied: false, changed: [] },
      error: { code: expected === 'old' ? 'STALE_REVISION' : expect.any(String) },
    } });
    expect(await snapshot(root)).toEqual(before);
  });

  it('refuses changed source bytes even when the caller supplies the unchanged project revision', async () => {
    const { directory, root, file, preview } = await itemPlan();
    await writeFile(file, (await readFile(file, 'utf8')).replace('합성 아이템 001', '변경된 합성 아이템 001'));
    const before = await snapshot(root);
    const result = await apply(directory, root, preview);
    expect(result).toMatchObject({ status: 2, reply: {
      ok: false, revision: preview.revision, data: { applied: false, changed: [] }, error: { code: 'IMPORT_SOURCE_CHANGED' },
    } });
    expect(await snapshot(root)).toEqual(before);
  });

  it('keeps another writer’s lock and rejects apply without writing', async () => {
    const { directory, root, preview } = await itemPlan();
    await writeFile(join(root, '.vibe-spec.lock'), 'other writer');
    const before = await snapshot(root);
    expect(await apply(directory, root, preview)).toMatchObject({ status: 2, reply: {
      data: { applied: false, changed: [] }, error: { code: 'PROJECT_LOCKED' },
    } });
    expect(await snapshot(root)).toEqual(before);
  });

  it('reports the files already written and the current revision after a partial apply failure', async () => {
    const { directory, root, preview } = await itemPlan();
    const blocked = join(root, 'tables/items.yaml.vibe-tmp');
    await writeFile(blocked, 'other temporary file');
    const result = await apply(directory, root, preview);
    expect(result).toMatchObject({ status: 2, reply: {
      ok: false, data: { applied: true, partial: true, changed: ['schemas/items.yaml'] }, error: { code: 'WRITE_FAILED' },
    } });
    expect(result.reply.revision).not.toBe(preview.revision);
    expect(result.reply.revision).toBe(cli(directory, ['validate', '--project', root]).reply.revision);
    expect(await readdir(join(root, 'tables'))).toEqual(['items.yaml.vibe-tmp']);
    expect(await readFile(blocked, 'utf8')).toBe('other temporary file');
    expect(await readdir(root)).not.toContain('.vibe-spec.lock');
  });

  it('requires an expected revision and reports malformed plan JSON using the write failure envelope', async () => {
    const { directory, root, preview } = await itemPlan();
    const input = join(directory, 'plan.json');
    await writeFile(input, JSON.stringify(preview));
    const before = await snapshot(root);
    expect(cli(directory, ['import', 'apply', '--input', input, '--project', root])).toMatchObject({ status: 2, reply: {
      data: { applied: false, changed: [] }, error: { code: 'REVISION_REQUIRED' },
    } });
    await writeFile(input, '{broken');
    expect(cli(directory, ['import', 'apply', '--input', input, '--project', root, '--expect-revision', preview.revision!]))
      .toMatchObject({ status: 2, reply: { ok: false, data: { applied: false, changed: [] }, error: { code: 'COMMAND_FAILED' } } });
    expect(await snapshot(root)).toEqual(before);
  });

  it.each([
    ['import'], ['import', 'unknown'], ['import', 'inspect'], ['import', 'plan'],
    ['import', 'apply', 'extra'], ['import', 'inspect', 'items.csv', '--check'],
    ['import', 'inspect', 'items.csv', '--mapping', 'mapping.json'],
  ])('rejects incomplete or unsupported import arguments: %j', async (...args) => {
    const directory = await temp();
    expect(cli(directory, args)).toMatchObject({ status: 2, reply: {
      ok: false, revision: null, error: { code: 'INVALID_ARGUMENT' },
    } });
  });
});
