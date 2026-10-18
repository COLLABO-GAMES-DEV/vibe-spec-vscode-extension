import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic, PlanView, Table, Usages } from '@vibe-spec/core';
import { afterEach, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const roots: string[] = [];
interface Reply<T> { revision: string; data: T; diagnostics: Diagnostic[]; error?: { code: string } }
function cli<T = unknown>(root: string, args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args, ...(args[0] === 'init' ? [] : ['--project', root]), '--json'], {
    cwd: root, encoding: 'utf8', timeout: process.platform === 'win32' ? 60_000 : 15_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return { status: result.status, reply: JSON.parse(result.stdout) as Reply<T> };
}
function revision(root: string) {
  const result = cli(root, ['validate']);
  expect(result.status).toBe(0);
  expect(result.reply.revision).toMatch(/^[a-f0-9]{64}$/);
  return result.reply.revision;
}
async function input(root: string, value: unknown) {
  const file = join(root, 'input.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}
async function write(root: string, command: string[], value: unknown) {
  return cli(root, [...command, '--input', await input(root, value), '--expect-revision', revision(root)]);
}
async function snapshot(root: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isDirectory()) {
      for (const [path, source] of Object.entries(await snapshot(join(root, item.name)))) files[item.name + '/' + path] = source;
    } else files[item.name] = await readFile(join(root, item.name));
  }
  return files;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-cli-integer-keys-')); roots.push(root);
  expect(cli(root, ['init', root])).toMatchObject({ status: 0 });
  await writeFile(join(root, 'schemas/levels.yaml'), 'primary_key: level\ncolumns:\n  level:\n    type: integer\n  note:\n    type: text\n');
  await writeFile(join(root, 'tables/levels.yaml'), 'schema: "levels"\nrows:\n' + ['10', '2', '1', '001'].map(key => `  - level: "${key}"\n    note: "Level ${key}"\n`).join(''));
  await writeFile(join(root, 'schemas/quests.yaml'), 'primary_key: key\ncolumns:\n  key:\n    type: string\n  level:\n    type: ref\n    table: levels\n    on_delete: restrict\n');
  await writeFile(join(root, 'tables/quests.yaml'), 'schema: "quests"\nrows:\n  - key: "first"\n    level: "1"\n');
  await mkdir(join(root, 'documents'));
  await writeFile(join(root, 'documents/guide.md'), '# Levels\n\n[Level](levels/1) and [note](levels/1/note).\n');
  return root;
}
function keys(root: string, target?: string) {
  const result = cli<{ table: Table }>(root, ['read', 'levels', ...(target ? ['--target', target] : [])]);
  expect(result.status).toBe(0);
  return result.reply.data.table.rows.map(row => row.level);
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('real Node CLI keeps integer Key order/bytes through fmt and dry-run, then renames refs and A/B paths', {
  timeout: process.platform === 'win32' ? 120_000 : 60_000,
}, async () => {
  const root = await fixture();
  expect(keys(root)).toEqual(['10', '2', '1', '001']);
  expect(cli(root, ['read', 'levels/001']).reply.data).toEqual({ level: '001', note: 'Level 001' });
  const tableBefore = await readFile(join(root, 'tables/levels.yaml'));
  expect(cli(root, ['fmt']).status).toBe(0);
  expect(await readFile(join(root, 'tables/levels.yaml'))).toEqual(tableBefore);
  const formatted = await snapshot(root);
  expect(cli(root, ['fmt', '--check'])).toMatchObject({ status: 0, reply: { data: { changed: [] } } });
  expect(cli(root, ['fmt'])).toMatchObject({ status: 0, reply: { data: { changed: [] } } });
  expect(await snapshot(root)).toEqual(formatted);

  expect(await write(root, ['plan', 'create', 'review'], { title: 'Levels', status: 'review' })).toMatchObject({ status: 0 });
  for (const variant of ['A', 'B']) {
    expect(await write(root, ['plan', 'variant', 'review/' + variant], {
      set: { 'levels/1/note': variant + ' original 1', 'quests/first/level': '1' },
      sources: [{ raw: '1', path: 'levels/1' }],
    })).toMatchObject({ status: 0 });
  }
  const used = cli<Usages>(root, ['where-used', 'levels/1']);
  expect(used.status).toBe(0);
  for (const file of ['tables/quests.yaml', 'documents/guide.md', 'plans/review/A.yaml', 'plans/review/B.yaml']) {
    expect(used.reply.data.references).toEqual(expect.arrayContaining([expect.objectContaining({ file })]));
  }
  expect(cli<Usages>(root, ['where-used', 'levels/001']).reply.data.references).toEqual([]);

  const expected = revision(root);
  const rename = ['rename', 'key', 'levels/1', '--to', '3', '--target', 'base', '--expect-revision', expected];
  const before = await snapshot(root);
  const preview = cli<{ applied: boolean; planned: string[]; preview: Record<string, string> }>(root, [...rename, '--dry-run']);
  expect(preview.reply.error).toBeUndefined();
  expect(preview).toMatchObject({ status: 0, reply: { revision: expected, data: { applied: false } } });
  expect(preview.reply.data.planned).toEqual(expect.arrayContaining([
    'tables/levels.yaml', 'tables/quests.yaml', 'documents/guide.md', 'plans/review/A.yaml', 'plans/review/B.yaml',
  ]));
  expect(preview.reply.data.preview['tables/levels.yaml']).toBe(tableBefore.toString().replace('level: "1"', 'level: "3"'));
  expect(await snapshot(root)).toEqual(before);
  expect(revision(root)).toBe(expected);
  expect(cli(root, rename)).toMatchObject({ status: 0, reply: { data: { applied: true } } });
  expect(keys(root)).toEqual(['10', '2', '3', '001']);
  expect(cli(root, ['read', 'quests/first/level']).reply.data).toEqual({ present: true, value: '3' });
  expect(cli(root, ['read', 'levels/1']).reply.error?.code).toBe('PATH_NOT_FOUND');
  expect(await readFile(join(root, 'documents/guide.md'), 'utf8')).toBe('# Levels\n\n[Level](levels/3) and [note](levels/3/note).\n');
  const plan = cli<PlanView>(root, ['plan', 'read', 'review']);
  expect(plan.status).toBe(0);
  for (const variant of ['A', 'B']) {
    expect(plan.reply.data.variants[variant]).toMatchObject({
      set: { 'levels/3/note': variant + ' original 1', 'quests/first/level': '3' },
      base_values: { 'levels/3/note': 'Level 1', 'quests/first/level': '3' },
      sources: [{ raw: '1', path: 'levels/1' }],
    });
    expect(plan.reply.data.variants[variant]!.set).not.toHaveProperty('levels/1/note');
    expect(keys(root, 'review/' + variant)).toEqual(['10', '2', '3', '001']);
    expect(cli(root, ['read', 'levels/3/note', '--target', 'review/' + variant]).reply.data)
      .toEqual({ present: true, value: variant + ' original 1' });
  }
  const after = await snapshot(root);
  expect(cli(root, ['fmt'])).toMatchObject({ status: 0, reply: { data: { changed: [] } } });
  expect(await snapshot(root)).toEqual(after);
});
