import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic, Usage } from '@vibe-spec/core';
import type { SpreadsheetSource } from '../../core/src/source-types.js';
import { afterEach, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const fixtures = fileURLToPath(new URL('../../core/test/fixtures/', import.meta.url));
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const { parse } = require('yaml') as { parse: (source: string) => unknown };
const roots: string[] = [];
interface Reply<T = unknown> {
  ok: boolean;
  revision: string | null;
  data: T;
  diagnostics: Diagnostic[];
  error?: { code: string; message: string };
}
interface Preview {
  applied: false;
  changed: string[];
  planned: string[];
  preview: Record<string, string | null>;
  candidates: Usage[];
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
  const directory = await mkdtemp(join(tmpdir(), 'vibe-cli-source-e2e-'));
  roots.push(directory);
  return directory;
}
async function setup(existing = false) {
  const directory = await temp();
  const root = join(directory, 'planning');
  expect(cli(directory, ['init', root]).status).toBe(0);
  if (existing) await cp(join(fixtures, 'project'), root, { recursive: true });
  return { directory, root };
}
function revision(root: string) {
  const result = cli(root, ['validate']);
  expect(result).toMatchObject({ status: 0, reply: { diagnostics: [], revision: expect.any(String) } });
  return result.reply.revision!;
}
async function snapshot(root: string): Promise<Record<string, Buffer | null>> {
  const files: Record<string, Buffer | null> = {};
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isDirectory()) {
      files[item.name + '/'] = null;
      for (const [file, bytes] of Object.entries(await snapshot(join(root, item.name)))) {
        files[item.name + '/' + file] = bytes;
      }
    } else files[item.name] = await readFile(join(root, item.name));
  }
  return files;
}
async function unchanged(root: string, before: Awaited<ReturnType<typeof snapshot>>, expected: string) {
  expect(await snapshot(root)).toEqual(before);
  expect(await readdir(root)).not.toContain('.vibe-spec.lock');
  expect(revision(root)).toBe(expected);
}
async function input(directory: string, operation: unknown) {
  const file = join(directory, 'operation.json');
  await writeFile(file, JSON.stringify(operation));
  return file;
}
function mutation<T = unknown>(root: string, file: string, expected: string, command: 'edit' | 'apply' = 'edit', dryRun = false) {
  return cli<T>(root, [command, '--input', file, '--expect-revision', expected, ...(dryRun ? ['--dry-run'] : [])]);
}
function checkPreview(data: Preview, files: string[]) {
  expect(data).toEqual({ applied: false, changed: [], planned: expect.any(Array),
    preview: expect.any(Object), candidates: [] });
  expect([...data.planned].sort()).toEqual([...files].sort());
  expect(Object.keys(data.preview).sort()).toEqual([...files].sort());
}
async function matchesPreview(root: string, preview: Preview) {
  const files = await snapshot(root);
  for (const [file, source] of Object.entries(preview.preview)) {
    if (source === null) expect(Object.hasOwn(files, file)).toBe(false);
    else expect(await readFile(join(root, file), 'utf8')).toBe(source);
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('source migration through actual CLI processes', () => {
  it('inspects CSV and XLSX outside a planning repository with original coordinates, literals and hashes', async () => {
    const directory = await temp();
    const csv = '\n,Key,Count,Price,Note\n,0001,900719925474099312345678901234567890,00042.0000,"line 1\nline 2"\n' +
      ',0002,+00042,-0.000,  padded  \n';
    await writeFile(join(directory, 'literal.csv'), csv);
    await cp(join(fixtures, 'import/items.xlsx'), join(directory, 'items.xlsx'));
    const before = await snapshot(directory);
    for (const [name, format] of [['literal.csv', 'csv'], ['items.xlsx', 'xlsx']] as const) {
      const file = join(directory, name);
      // Relative input must resolve from the process cwd, without --project or init.
      const result = cli<SpreadsheetSource>(directory, ['source', 'inspect', name]);
      expect(result).toMatchObject({ status: 0, reply: {
        ok: true, revision: null, diagnostics: [], data: {
          kind: 'spreadsheet', format, file: expect.any(String),
          sourceHash: createHash('sha256').update(await readFile(file)).digest('hex'), issues: expect.any(Array),
        },
      } });
      expect(isAbsolute(result.reply.data.file)).toBe(true);
      expect(await realpath(result.reply.data.file)).toBe(await realpath(file));
      expect(result.reply.data.sheets).toHaveLength(1);
      const sheet = result.reply.data.sheets[0]!;
      expect(sheet.columns).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect(sheet.cells.B2?.raw).toBe('Key');
      if (format === 'csv') {
        expect(sheet).toMatchObject({ name: 'literal', rowCount: 4, merges: [] });
        expect(sheet.cells.A1).toEqual({ raw: '', type: 'string' });
        expect(sheet.cells.A3).toEqual({ raw: '', type: 'string' });
        for (const [cell, raw] of Object.entries({ B3: '0001', C3: '900719925474099312345678901234567890',
          D3: '00042.0000', E3: 'line 1\nline 2', B4: '0002', C4: '+00042', D4: '-0.000', E4: '  padded  ' })) {
          expect(sheet.cells[cell]).toEqual({ raw, type: 'string' });
        }
      } else {
        expect(sheet).toMatchObject({ name: 'Synthetic Items', rowCount: 147 });
        expect(sheet.cells.B3?.raw).toBe('sample_item_001');
        expect(sheet.cells.B145?.raw).toBe('sample_item_143');
        expect(sheet.cells.C145?.raw).toBe('합성 아이템 143');
        expect(sheet.cells.D145?.raw).toBe('합성 설명 143입니다.');
        expect(sheet.cells.B147?.raw).toBe('sample_item_145');
      }
    }
    expect(await snapshot(directory)).toEqual(before);
  });

  it('delivers the linked import skill and previews table creation, column addition and deletion before applying', async () => {
    const { directory, root } = await setup();
    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
    const target = [...agents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
      .map(match => match[1]!).find(path => path.endsWith('/vibe-import/SKILL.md'));
    expect(target).toBe('.agents/skills/vibe-import/SKILL.md');
    const skillFile = join(root, target!);
    expect(relative(root, skillFile).split('\\').join('/')).toBe('.agents/skills/vibe-import/SKILL.md');
    const skill = await readFile(skillFile, 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
    expect(frontmatter).not.toBeNull();
    expect(parse(frontmatter![1]!)).toMatchObject({ name: 'vibe-import', description: expect.stringMatching(/\S/) });
    expect(skill.slice(frontmatter![0].length).trim().length).toBeGreaterThan(0);

    const operations = [
      { op: 'table-create', table: 'notes', key: { code: 'id', label: 'Key' } },
      { op: 'column-add', table: 'notes', column: 'body', definition: { type: 'text' } },
      { op: 'table-delete', table: 'notes' },
    ];
    for (const operation of operations) {
      const expected = revision(root), before = await snapshot(root);
      const file = await input(directory, operation);
      const preview = mutation<Preview>(root, file, expected, 'edit', true);
      expect(preview).toMatchObject({ status: 0, reply: { ok: true, revision: expected, diagnostics: [] } });
      const files = operation.op === 'column-add' ? ['schemas/notes.yaml'] : ['schemas/notes.yaml', 'tables/notes.yaml'];
      checkPreview(preview.reply.data, files);
      if (operation.op === 'table-delete') {
        expect(preview.reply.data.preview).toEqual({ 'schemas/notes.yaml': null, 'tables/notes.yaml': null });
      } else {
        expect(parse(preview.reply.data.preview['schemas/notes.yaml']!)).toEqual({ primary_key: 'id', columns: {
          id: { type: 'string', label: 'Key' }, ...(operation.op === 'column-add' ? { body: { type: 'text' } } : {}),
        } });
        if (operation.op === 'table-create') {
          expect(parse(preview.reply.data.preview['tables/notes.yaml']!)).toEqual({ schema: 'notes', rows: [] });
        }
      }
      await unchanged(root, before, expected);
      // Reuse the exact input and revision; only remove --dry-run.
      const applied = mutation(root, file, expected);
      expect(applied).toMatchObject({ status: 0, reply: { ok: true, diagnostics: [] } });
      expect(applied.reply.data).toEqual({ applied: true, changed: preview.reply.data.planned, candidates: [] });
      expect(applied.reply.revision).not.toBe(expected);
      await matchesPreview(root, preview.reply.data);
    }
  }, 60_000);

  it('validates planned bulk rows, leaves current files and revision intact, and preserves the real apply response', async () => {
    const { directory, root } = await setup(true);
    const expected = revision(root), before = await snapshot(root);
    const rows = {
      items: { code: 'currency_new', name: 'New currency', kind: 'undeclared', note: '001' },
      offers: { sku: 'new', currency: 'currency_new', price: '00042.0000', count: '1.5', available: true },
    };
    const file = await input(directory, Object.entries(rows).map(([table, row]) => ({ op: 'create', table, row })));
    const preview = mutation<Preview>(root, file, expected, 'apply', true);
    expect(preview).toMatchObject({ status: 1, reply: { ok: false, revision: expected } });
    expect(preview.reply.error).toBeUndefined();
    checkPreview(preview.reply.data, ['tables/items.yaml', 'tables/offers.yaml']);
    expect(preview.reply.diagnostics.map(({ code, file, path }) => ({ code, file, path }))).toEqual([
      { code: 'VALUE_TYPE_OR_RANGE', file: 'tables/items.yaml', path: 'items/currency_new/kind' },
      { code: 'VALUE_TYPE_OR_RANGE', file: 'tables/offers.yaml', path: 'offers/new/count' },
    ]);
    for (const [table, row] of Object.entries(rows)) {
      expect(parse(preview.reply.data.preview[`tables/${table}.yaml`]!)).toMatchObject({
        schema: table, rows: expect.arrayContaining([row]),
      });
    }
    await unchanged(root, before, expected);
    const applied = mutation(root, file, expected, 'apply');
    expect(applied).toMatchObject({ status: 1, reply: { ok: false, diagnostics: preview.reply.diagnostics } });
    expect(applied.reply.data).toEqual({ applied: true, changed: preview.reply.data.planned, candidates: [] });
    expect(applied.reply.revision).not.toBe(expected);
    await matchesPreview(root, preview.reply.data);
    expect(cli(root, ['read', 'items/currency_new']).reply.data).toEqual(rows.items);
    expect(cli(root, ['read', 'offers/new']).reply.data).toEqual(rows.offers);
  });

  it('rejects stale revisions, restricted row/table deletion and unsupported dry-run commands without writing', async () => {
    const { directory, root } = await setup(true);
    const stale = revision(root);
    const update = await input(directory, { op: 'update', table: 'items', key: 'currency_gold', values: { note: '0002' } });
    const changed = mutation(root, update, stale);
    expect(changed.status).toBe(0);
    const expected = revision(root), before = await snapshot(root);
    expect(expected).not.toBe(stale);
    for (const command of ['edit', 'apply'] as const) {
      const operation = { op: 'delete', table: 'items', key: 'currency_gold' };
      const file = await input(directory, command === 'apply' ? [operation] : operation);
      for (const [supplied, code] of [[stale, 'STALE_REVISION'], [expected, 'DELETE_RESTRICTED']]) {
        expect(mutation(root, file, supplied!, command, true)).toMatchObject({ status: 2, reply: {
          ok: false, revision: expected, data: { applied: false, changed: [] }, error: { code },
        } });
        await unchanged(root, before, expected);
      }
    }
    const deletion = await input(directory, { op: 'table-delete', table: 'items' });
    expect(mutation(root, deletion, expected, 'edit', true)).toMatchObject({ status: 2, reply: {
      ok: false, revision: expected, data: { applied: false, changed: [] }, error: { code: 'DELETE_RESTRICTED' },
    } });
    for (const args of [['fmt'], ['read', 'items'], ['source', 'inspect', join(fixtures, 'import/items.csv')]]) {
      expect(cli(root, [...args, '--dry-run'])).toMatchObject({ status: 2, reply: {
        ok: false, error: { code: 'INVALID_ARGUMENT' },
      } });
    }
    await unchanged(root, before, expected);
  }, 60_000);

  it('preserves long LF text and numeric strings through create, read, validate and repeated formatting', async () => {
    const { directory, root } = await setup(true);
    const column = await input(directory, { op: 'column-add', table: 'offers', column: 'note', definition: { type: 'text' } });
    expect(mutation(root, column, revision(root)).status).toBe(0);
    const row = {
      sku: 'multiline', currency: 'currency_gold', available: true,
      count: '900719925474099312345678901234567890', price: '+000.1234567890123456789012345678900E+0002',
      note: '긴 본문과 숫자 00042.0000을 그대로 보존합니다. '.repeat(8) + '\n둘째 줄\n\n"인용"과 \\경로\t탭\n',
    };
    const file = await input(directory, { op: 'create', table: 'offers', row });
    expect(mutation(root, file, revision(root))).toMatchObject({ status: 0, reply: { data: { applied: true } } });
    const read = () => {
      expect(cli(root, ['read', 'offers/multiline'])).toMatchObject({ status: 0, reply: { data: row } });
      expect(cli(root, ['validate'])).toMatchObject({ status: 0, reply: { diagnostics: [] } });
    };
    read();
    const addSpare = await input(directory, { op: 'column-add', table: 'offers', column: 'spare', definition: { type: 'text' } });
    expect(mutation(root, addSpare, revision(root)).status).toBe(0);
    const setSpare = await input(directory, { op: 'update', table: 'offers', key: 'multiline', values: { spare: 'temporary' } });
    expect(mutation(root, setSpare, revision(root)).status).toBe(0);
    const removeSpare = await input(directory, { op: 'column-delete', table: 'offers', column: 'spare' });
    expect(mutation(root, removeSpare, revision(root))).toMatchObject({ status: 0, reply: { diagnostics: [] } });
    read();
    expect(cli(root, ['fmt']).status).toBe(0);
    read();
    const formatted = await snapshot(root), expected = revision(root);
    expect(cli(root, ['fmt'])).toMatchObject({ status: 0, reply: { revision: expected, data: { changed: [] } } });
    expect(cli(root, ['fmt', '--check'])).toMatchObject({ status: 0, reply: { revision: expected, data: { changed: [] } } });
    read();
    await unchanged(root, formatted, expected);
  }, 60_000);
});
