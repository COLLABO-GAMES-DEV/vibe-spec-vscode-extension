import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyFolderEdit } from '../src/folders.js';
import { initProject, loadProject } from '../src/project.js';
import { listFolders } from '../src/resources.js';
import type { FolderOperation } from '../src/folder-types.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-domains-')); roots.push(root);
  await initProject(root);
  return root;
}
async function put(root: string, path: string, source: string) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), source);
}
async function edit(root: string, operation: FolderOperation) {
  return applyFolderEdit(root, (await loadProject(root)).revision, operation);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('creates both physical sides and markers, rejects stale reads including empty directory changes', async () => {
  const root = await fixture(), before = await loadProject(root);
  const result = await applyFolderEdit(root, before.revision, { op: 'folder-create', path: '경제/상점' });
  expect(listFolders(result.project)).toEqual(['경제', '경제/상점']);
  for (const side of ['tables', 'documents']) for (const folder of ['경제', '경제/상점']) {
    expect(await readFile(join(root, side, folder, '.gitkeep'), 'utf8')).toBe('');
  }
  expect(result.project.revision).not.toBe(before.revision);
  await expect(applyFolderEdit(root, before.revision, { op: 'folder-create', path: 'stale' }))
    .rejects.toMatchObject({ code: 'STALE_REVISION' });
  const current = await loadProject(root);
  await mkdir(join(root, 'tables/manual'));
  await expect(applyFolderEdit(root, current.revision, { op: 'folder-create', path: 'new' }))
    .rejects.toMatchObject({ code: 'STALE_REVISION' });
});

it('renames and moves the complete logical subtree without changing YAML, Markdown, references or schemas', async () => {
  const root = await fixture();
  const schema = 'primary_key: key\ncolumns:\n  key: {type: string}\n  note: {type: text}\n';
  const table = '\uFEFF# exact YAML\r\nschema: shared\r\nrows:\r\n  - key: "a"\r\n    note: "[Guide](Guide/Heading)"\r\n';
  const document = '\uFEFF# Heading\r\n\r\n[Item](items/a)\r\n\r\n![picture](assets/image.png)\r\n';
  await put(root, 'schemas/shared.yaml', schema);
  await put(root, 'tables/economy/deep/items.yaml', table);
  await put(root, 'documents/economy/Guide.md', document);
  await put(root, 'documents/assets/image.png', 'image bytes');
  await mkdir(join(root, 'tables/economy/empty'));
  await edit(root, { op: 'folder-create', path: 'archive' });
  const renamed = await edit(root, { op: 'folder-rename', path: 'economy', name: 'shop' });
  expect(renamed.project.sources.get('tables/shop/deep/items.yaml')).toBe(table);
  for (const side of ['tables', 'documents']) await expect(lstat(join(root, side, 'economy'))).rejects.toMatchObject({ code: 'ENOENT' });
  const moved = await edit(root, { op: 'folder-move', path: 'shop', folder: 'archive' });
  expect(await readFile(join(root, 'tables/archive/shop/deep/items.yaml'))).toEqual(Buffer.from(table));
  expect(await readFile(join(root, 'documents/archive/shop/Guide.md'))).toEqual(Buffer.from(document));
  expect(await readFile(join(root, 'schemas/shared.yaml'), 'utf8')).toBe(schema);
  expect(moved.changed.some(path => path.startsWith('schemas/'))).toBe(false);
  expect(moved.diagnostics).toEqual([]);
  expect(listFolders(moved.project)).toContain('archive/shop/empty');
  for (const side of ['tables', 'documents']) {
    expect(await readFile(join(root, side, 'archive/shop/empty/.gitkeep'), 'utf8')).toBe('');
    await expect(lstat(join(root, side, 'shop'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('moves resources to a domain or root and preserves the source domain after its last resource moves', async () => {
  const root = await fixture();
  await put(root, 'schemas/shared.yaml', 'primary_key: key\ncolumns:\n  key: {type: string}\n');
  const table = 'schema: shared\r\nrows: []\r\n', document = '# Hello\r\n[table](items)\r\n';
  await put(root, 'tables/one/items.yaml', table);
  await put(root, 'documents/one/Guide.md', document);
  await edit(root, { op: 'folder-create', path: 'two' });
  await edit(root, { op: 'resource-move', kind: 'table', name: 'items', folder: 'two' });
  const moved = await edit(root, { op: 'resource-move', kind: 'document', name: 'Guide', folder: '' });
  expect(await readFile(join(root, 'tables/two/items.yaml'), 'utf8')).toBe(table);
  expect(await readFile(join(root, 'documents/Guide.md'), 'utf8')).toBe(document);
  expect(listFolders(moved.project)).toEqual(['one', 'two']);
  expect(await readdir(join(root, 'tables/one'))).toEqual(['.gitkeep']);
  expect(await readdir(join(root, 'documents/one'))).toEqual(['.gitkeep']);
});

it('deletes only a domain empty on both sides, ignoring markers but counting empty subfolders', async () => {
  const root = await fixture();
  await edit(root, { op: 'folder-create', path: 'parent/child' });
  await expect(edit(root, { op: 'folder-delete', path: 'parent' })).rejects.toMatchObject({ code: 'FOLDER_NOT_EMPTY' });
  await edit(root, { op: 'folder-delete', path: 'parent/child' });
  await put(root, 'documents/parent/notes.txt', 'unknown');
  await expect(edit(root, { op: 'folder-delete', path: 'parent' })).rejects.toMatchObject({ code: 'FOLDER_NOT_EMPTY' });
  expect(await readFile(join(root, 'documents/parent/notes.txt'), 'utf8')).toBe('unknown');
  await rm(join(root, 'documents/parent/notes.txt'));
  const deleted = await edit(root, { op: 'folder-delete', path: 'parent' });
  expect(listFolders(deleted.project)).toEqual([]);
  for (const side of ['tables', 'documents']) await expect(lstat(join(root, side, 'parent'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('recognizes and removes an unmarked empty domain existing on only one side', async () => {
  const root = await fixture();
  await mkdir(join(root, 'tables/manual'));
  const result = await edit(root, { op: 'folder-delete', path: 'manual' });
  expect(listFolders(result.project)).toEqual([]);
  await expect(lstat(join(root, 'tables/manual'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves an unmarked source parent when its last child domain is removed', async () => {
  const root = await fixture();
  await mkdir(join(root, 'tables/manual/child'), { recursive: true });
  const result = await edit(root, { op: 'folder-delete', path: 'manual/child' });
  expect(listFolders(result.project)).toEqual(['manual']);
  for (const side of ['tables', 'documents']) {
    expect(await readFile(join(root, side, 'manual/.gitkeep'), 'utf8')).toBe('');
  }
});

it('refuses unknown files anywhere in a moved subtree without writing destinations', async () => {
  const root = await fixture();
  await edit(root, { op: 'folder-create', path: 'source/deep' });
  await put(root, 'documents/source/deep/notes.txt', 'do not lose');
  const before = await loadProject(root);
  await expect(applyFolderEdit(root, before.revision, { op: 'folder-rename', path: 'source', name: 'target' }))
    .rejects.toMatchObject({ code: 'FILE_UNSUPPORTED' });
  expect((await loadProject(root)).revision).toBe(before.revision);
  expect(await readFile(join(root, 'documents/source/deep/notes.txt'), 'utf8')).toBe('do not lose');
  await expect(lstat(join(root, 'tables/target'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses occupied domains, physical files, cross-root case collisions and case-only renames', async () => {
  const root = await fixture();
  await edit(root, { op: 'folder-create', path: 'Source' });
  await mkdir(join(root, 'documents/Taken'));
  await expect(edit(root, { op: 'folder-rename', path: 'Source', name: 'Taken' })).rejects.toMatchObject({ code: 'NAME_EXISTS' });
  await expect(edit(root, { op: 'folder-create', path: 'taken/child' })).rejects.toMatchObject({ code: 'NAME_EXISTS' });
  await expect(edit(root, { op: 'folder-rename', path: 'Source', name: 'source' }))
    .rejects.toMatchObject({ code: 'NAME_EXISTS', message: expect.stringContaining('Source_2') });
  await put(root, 'tables/occupied', 'unknown');
  await expect(edit(root, { op: 'folder-rename', path: 'Source', name: 'occupied' })).rejects.toMatchObject({ code: 'NAME_EXISTS' });
});

it.each(['assets', 'ASSETS/child', 'a/CON', 'trailing.', 'a/../b', '/absolute', 'back\\slash', 'a//b'])
  ('rejects unsafe or reserved folder path %s', async path => {
    const root = await fixture();
    await expect(edit(root, { op: 'folder-create', path })).rejects.toMatchObject({ code: 'NAME_INVALID' });
  });

it('rejects child-of-self moves and leaves a dry-run completely read-only', async () => {
  const root = await fixture();
  await edit(root, { op: 'folder-create', path: 'parent/child' });
  await expect(edit(root, { op: 'folder-move', path: 'parent', folder: 'parent/child' })).rejects.toMatchObject({ code: 'FOLDER_SELF' });
  const before = await loadProject(root);
  const preview = await applyFolderEdit(root, before.revision, { op: 'folder-rename', path: 'parent', name: 'renamed' }, { dryRun: true });
  expect(listFolders(preview.planned)).toEqual(['renamed', 'renamed/child']);
  expect((await loadProject(root)).revision).toBe(before.revision);
  await expect(lstat(join(root, 'tables/renamed'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects symlinks in the source subtree and destination ancestors', async () => {
  const root = await fixture(), outside = await fixture();
  await edit(root, { op: 'folder-create', path: 'source' });
  const before = await loadProject(root);
  await symlink(outside, join(root, 'tables/source/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(applyFolderEdit(root, before.revision, { op: 'folder-rename', path: 'source', name: 'target' }))
    .rejects.toMatchObject({ code: 'FILE_UNSUPPORTED' });
  await rm(join(root, 'tables/source/link'));
  await symlink(outside, join(root, 'documents/target'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(applyFolderEdit(root, before.revision, { op: 'folder-create', path: 'target/child' }))
    .rejects.toMatchObject({ code: 'FILE_UNSUPPORTED' });
  expect((await loadProject(outside)).files.size).toBe(0);
});
