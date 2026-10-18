import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { applyImport, inspectImport, planImport } from '../src/import.js';
import type { ImportMapping } from '../src/import-types.js';
import { exportMarkdown } from '../src/export.js';
import { applyFolderEdit } from '../src/folders.js';
import { getGitStatus, resolveProject, saveProject } from '../src/git.js';
import { initProject, loadProject, readPath } from '../src/project.js';

let sandbox: string;
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const schema = 'primary_key: key\ncolumns:\n  key: {type: string}\n  name: {type: text}\n  note: {type: text}\n';
const table = (name = 'Base', note = 'Base note') => 'schema: shared\nrows:\n  - key: "a"\n    name: "' + name + '"\n    note: "' + note + '"\n';
async function put(root: string, path: string, source: string | Buffer) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), source);
}
beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vibe-domain-integrations-'));
  const config = join(sandbox, 'gitconfig');
  await writeFile(config, '[user]\n name = Domain Test\n email = domain@example.invalid\n[commit]\n gpgsign = false\n[init]\n defaultBranch = main\n[core]\n autocrlf = false\n[credential]\n helper =\n');
  vi.stubEnv('GIT_CONFIG_GLOBAL', config); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(sandbox, { recursive: true, force: true }); });
async function fixture() {
  const root = join(sandbox, 'project');
  await initProject(root);
  await put(root, 'schemas/common/shared.yaml', schema);
  return root;
}
async function csv(root: string, source = 'Key,Name,Note\na,Alpha,note\n') {
  const file = join(sandbox, 'source.csv');
  await writeFile(file, source);
  const inspection = await inspectImport(file);
  const mapping: ImportMapping = { table: 'items', schema: 'shared', folder: '경제/상점',
    sheet: inspection.sheets[0]!.name, header_row: 1, data_start_row: 2,
    columns: { A: 'key', B: 'name', C: 'note' }, numeric: 'stored' };
  return { inspection, mapping, project: await loadProject(root) };
}

it('imports into nested tables using an existing nested schema and appends by the same global table name', async () => {
  const root = await fixture(), first = await csv(root);
  const plan = planImport(first.project, first.inspection, first.mapping);
  expect(plan.canApply).toBe(true);
  expect(plan.files).toEqual(['tables/경제/상점/items.yaml']);
  const applied = await applyImport(root, plan.revision, plan);
  expect(applied.diagnostics).toEqual([]);
  expect(readPath(applied.project, 'items/a/name')).toEqual({ value: 'Alpha', present: true });
  expect(await readFile(join(root, 'schemas/common/shared.yaml'), 'utf8')).toBe(schema);
  await expect(readFile(join(root, 'schemas/shared.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  const next = await csv(root, 'Key,Name,Note\nb,Beta,next\n');
  const appended = planImport(next.project, next.inspection, next.mapping);
  expect(appended.canApply).toBe(true);
  const result = await applyImport(root, appended.revision, appended);
  expect(readPath(result.project, 'items/b/name')).toEqual({ value: 'Beta', present: true });
  const duplicate = planImport(result.project, next.inspection, next.mapping);
  expect(duplicate.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_KEY_DUPLICATE' }));
});

it('blocks global table/document collisions and folder spelling collisions without relocating existing tables', async () => {
  const root = await fixture(), f = await csv(root);
  await put(root, 'tables/other/Items.yaml', table());
  let project = await loadProject(root);
  expect(planImport(project, f.inspection, f.mapping).issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_NAME_EXISTS' }));
  expect(planImport(project, f.inspection, { ...f.mapping, table: 'Items' }).canApply).toBe(false);
  await put(root, 'documents/docs/Guide.md', '# Guide\n');
  project = await loadProject(root);
  expect(planImport(project, f.inspection, { ...f.mapping, table: 'guide' }).canApply).toBe(false);
  expect(planImport(project, f.inspection, { ...f.mapping, table: 'new', folder: 'Other' }).canApply).toBe(false);
  await put(root, 'schemas/second/SHARED.yaml', schema);
  expect(planImport(await loadProject(root), f.inspection, { ...f.mapping, table: 'new' }).canApply).toBe(false);
});

it('keeps new schemas flat and persists the chosen domain in exact-number import provenance', async () => {
  const root = await fixture(), file = join(sandbox, 'source.xlsx');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Key'], [1]]), 'Data');
  const zip = XLSX.CFB.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  XLSX.CFB.utils.cfb_add(zip, '/xl/worksheets/sheet1.xml', Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Key</t></is></c></row>' +
    '<row r="2"><c r="A2" t="n"><v>900719925474099312345.0</v></c></row></sheetData></worksheet>'));
  await writeFile(file, XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' }) as Buffer);
  const project = await loadProject(root), inspection = await inspectImport(file);
  const mapping: ImportMapping = { table: 'levels', schema: 'levels', folder: 'game/balance', sheet: 'Data',
    header_row: 1, data_start_row: 2, columns: { A: 'key' }, numeric: 'stored',
    definition: { primary_key: 'key', columns: { key: { type: 'integer' } } } };
  const plan = planImport(project, inspection, mapping);
  expect(plan.files).toContain('schemas/levels.yaml');
  expect(plan.files).toContain('tables/game/balance/levels.yaml');
  expect(plan.normalizations).toEqual([{ cell: 'A2', column: 'key', raw: '900719925474099312345.0', value: '900719925474099312345' }]);
  const result = await applyImport(root, plan.revision, plan);
  const provenance = JSON.parse(await readFile(join(root, plan.provenanceFile!), 'utf8'));
  expect(provenance.mapping.folder).toBe('game/balance');
  expect(readPath(result.project, 'levels/900719925474099312345/key')).toEqual({ value: '900719925474099312345', present: true });
});

it('exports table subfolders with global names and cleans only its own stale nested output after a move', async () => {
  const root = await fixture();
  await put(root, 'tables/economy/deep/items.yaml', table());
  let project = await loadProject(root);
  const initial = await exportMarkdown(project);
  expect(initial.files).toEqual(['economy/deep/items.md']);
  const source = await readFile(join(initial.directory, initial.files[0]!), 'utf8');
  expect(source).toContain('# items\n');
  expect(source).toContain('Schema: shared');
  expect(source).toContain('| a | Base | Base note |');
  await put(initial.directory, 'economy/deep/human.md', '# Keep this\n');
  await applyFolderEdit(root, project.revision, { op: 'folder-rename', path: 'economy', name: 'archive' });
  project = await loadProject(root);
  const exported = await exportMarkdown(project);
  expect(exported.files).toEqual(['archive/deep/items.md']);
  await expect(readFile(join(initial.directory, 'economy/deep/items.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(initial.directory, 'economy/deep/human.md'), 'utf8')).toBe('# Keep this\n');
  expect((await loadProject(root)).revision).toBe(project.revision);
});

it('rejects nested export parent symlinks and case collisions without overwriting outside files', async () => {
  const root = await fixture();
  await put(root, 'tables/economy/items.yaml', table());
  const project = await loadProject(root), output = join(sandbox, 'output'), outside = join(sandbox, 'outside');
  await mkdir(output); await mkdir(outside);
  await symlink(outside, join(output, 'economy'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(exportMarkdown(project, output)).rejects.toMatchObject({ code: 'EXPORT_CONFLICT' });
  await expect(readFile(join(outside, 'items.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(join(output, 'economy'));
  await mkdir(join(output, 'Economy'));
  await expect(exportMarkdown(project, output)).rejects.toMatchObject({ code: 'EXPORT_CONFLICT' });
});

it.each(['items.md', '.gitignore'])('preflights an export folder colliding with the output file %s', async folder => {
  const root = await fixture();
  await put(root, 'tables/items.yaml', table());
  await put(root, 'tables/' + folder + '/other.yaml', table());
  const output = join(sandbox, 'output');
  await expect(exportMarkdown(await loadProject(root), output)).rejects.toMatchObject({ code: 'EXPORT_NAME' });
  await expect(readFile(join(output, 'items.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects ambiguous global table names before attempting to render nested exports', async () => {
  const root = await fixture();
  await put(root, 'tables/one/items.yaml', table());
  await put(root, 'tables/two/Items.yaml', table());
  await expect(exportMarkdown(await loadProject(root))).rejects.toMatchObject({ code: 'EXPORT_NAME' });
});

it('Git saves recursive resources, domain markers and attributes, detects marker changes, and preserves nested Markdown bytes', async () => {
  const root = await fixture();
  const document = '\uFEFF# Exact\r\n\r\nText\r\n';
  await put(root, 'documents/economy/Guide.md', document);
  await put(root, 'documents/assets2/deep/Notes.md', '# Domain with an asset-like name\n');
  await put(root, 'tables/economy/items.yaml', table());
  const project = await loadProject(root);
  await applyFolderEdit(root, project.revision, { op: 'folder-create', path: 'empty/deep' });
  const before = await getGitStatus(root);
  expect(before.changes).toEqual(expect.arrayContaining(['schemas/common/shared.yaml', 'tables/economy/items.yaml',
    'documents/economy/Guide.md', 'tables/empty/deep/.gitkeep', 'documents/empty/deep/.gitkeep', '.gitattributes']));
  await saveProject(root, 'Nested domains', before.revision);
  expect(git(root, 'show', 'HEAD:documents/economy/Guide.md')).toBe(document);
  expect(git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('documents/empty/deep/.gitkeep');
  expect(git(root, 'show', 'HEAD:documents/assets2/deep/Notes.md')).toContain('# Domain');
  expect((await getGitStatus(root)).changes).toEqual([]);
  const saved = await getGitStatus(root);
  await writeFile(join(root, 'tables/empty/deep/.gitkeep'), 'marker change');
  await expect(saveProject(root, 'Stale marker', saved.revision)).rejects.toMatchObject({ code: 'STALE_REVISION' });
});

it.each([false, true])('merges nested tables using the schema path in each Git tree (conflicting row: %s)', async conflict => {
  const root = await fixture(), file = 'tables/economy/items.yaml';
  await put(root, file, table());
  await saveProject(root, 'Base');
  git(root, 'checkout', '-b', 'incoming');
  await put(root, file, conflict ? table('Theirs') : table('Base', 'Their note'));
  await saveProject(root, 'Incoming');
  git(root, 'checkout', 'main');
  await mkdir(join(root, 'schemas/renamed'));
  await rename(join(root, 'schemas/common/shared.yaml'), join(root, 'schemas/renamed/shared.yaml'));
  await put(root, file, table('Ours'));
  await saveProject(root, 'Local schema relocation and row edit');
  expect(() => git(root, 'merge', '--no-commit', 'incoming')).toThrow();
  const status = await getGitStatus(root);
  expect(status.mergeInProgress).toBe(true);
  expect(status.conflicts).toHaveLength(conflict ? 1 : 0);
  if (conflict) expect(status.conflicts[0]).toMatchObject({ kind: 'row', table: 'items', key: 'a', file });
  const result = await resolveProject(root, status.revision, conflict ? [{ file, key: 'a', choice: 'ours' }] : []);
  expect(result.completed).toBe(true);
  expect(result.diagnostics).toEqual([]);
  const project = await loadProject(root);
  expect(readPath(project, 'items/a/name')).toEqual({ value: 'Ours', present: true });
  expect(readPath(project, 'items/a/note')).toEqual({ value: conflict ? 'Base note' : 'Their note', present: true });
});

it('does not choose an arbitrary nested schema when a Git tree has a case-colliding basename', async () => {
  const root = await fixture(), file = 'tables/economy/items.yaml';
  await put(root, file, table());
  await saveProject(root, 'Base');
  git(root, 'checkout', '-b', 'incoming');
  await put(root, file, table('Theirs'));
  await put(root, 'schemas/duplicate/SHARED.yaml', schema);
  await saveProject(root, 'Ambiguous schema');
  git(root, 'checkout', 'main');
  await put(root, file, table('Ours'));
  await saveProject(root, 'Local');
  expect(() => git(root, 'merge', '--no-commit', 'incoming')).toThrow();
  expect((await getGitStatus(root)).conflicts).toContainEqual(expect.objectContaining({ kind: 'file', file, managed: true }));
});
