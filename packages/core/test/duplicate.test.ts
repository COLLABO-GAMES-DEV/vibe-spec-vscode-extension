import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { applyEdits, applyFolderEdit, applyStructureEdit, createDocument, duplicateResource, formattedSources,
  getDocumentView, initProject, loadProject, readPath, renameResource, resourceFile, saveDocumentSnapshots,
  validateProject, whereUsed, writeChanges } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-duplicate-')); roots.push(root);
  await initProject(root);
  await cp(fileURLToPath(new URL('./fixtures/project', import.meta.url)), root, { recursive: true });
  return loadProject(root);
}

it('duplicates a nested table with its own schema, exact decimals, row order and original reference targets', async () => {
  let p = await fixture();
  p = (await applyFolderEdit(p.root, p.revision, { op: 'folder-create', path: './economy~1shop' })).project;
  p = (await applyFolderEdit(p.root, p.revision, { op: 'resource-move', kind: 'table', name: 'offers', folder: './economy~1shop' })).project;
  const oldTable = resourceFile(p, 'table', 'offers')!, oldSchema = resourceFile(p, 'schema', 'offers')!;
  const source = p.sources.get(oldTable)!, schema = p.sources.get(oldSchema)!;
  const before = new Map(p.sources);
  const preview = await duplicateResource(p.root, p.revision, 'table', 'offers', 'offers_B', { dryRun: true });
  expect(preview.changed).toHaveLength(2);
  expect((await loadProject(p.root)).revision).toBe(p.revision);
  p = (await duplicateResource(p.root, p.revision, 'table', 'offers', 'offers_B')).project;
  expect(p.sources.get(resourceFile(p, 'table', 'offers_B')!)).toBe(source.replace('schema: offers', 'schema: "offers_B"'));
  expect(p.sources.get(resourceFile(p, 'schema', 'offers_B')!)).toBe(schema);
  for (const [file, bytes] of before) expect(p.sources.get(file)).toBe(bytes);
  expect(readPath(p, 'offers_B/bundle/price')).toEqual(readPath(p, 'offers/bundle/price'));
  expect(readPath(p, 'offers_B/bundle/currency')).toEqual({ value: 'currency_gold', present: true });
  p = (await applyStructureEdit(p.root, p.revision, { op: 'column-update', table: 'offers_B', column: 'price', changes: { label: 'Free value' } })).project;
  expect(p.sources.get(oldSchema)).toBe(schema);
  p = (await applyEdits(p.root, p.revision, [{ op: 'update', table: 'offers_B', key: 'bundle', values: { price: '000.5000' } }])).project;
  expect(p.sources.get(oldTable)).toBe(source);
  expect((await whereUsed(p, 'items/currency_gold')).references.some(item => item.file === resourceFile(p, 'table', 'offers_B'))).toBe(true);
  await expect(applyEdits(p.root, p.revision, [{ op: 'delete', table: 'items', key: 'currency_gold' }])).rejects.toMatchObject({ code: 'DELETE_RESTRICTED' });
  expect(validateProject(p)).toEqual([]);
});

it('copies BOM/CRLF Markdown exactly with names, raw blocks, images and self links untouched; edits are independent', async () => {
  let p = await fixture();
  const source = '\uFEFF# A/B\r\n\r\n<!-- name: raw/name -->\r\nOriginal  \r\n\r\n[Self](./guide/A~1B) [Value](offers/bundle/price)\r\n\r\n<aside>raw</aside>\r\n\r\n![asset](assets/sample.png)';
  p = (await createDocument(p.root, p.revision, 'guide', source, { folder: './docs~1review' })).project;
  await mkdir(join(p.root, 'documents/assets'), { recursive: true });
  await writeFile(join(p.root, 'documents/assets/sample.png'), Buffer.from([1, 2, 3]));
  p = await loadProject(p.root);
  const originalFile = resourceFile(p, 'document', 'guide')!;
  p = (await duplicateResource(p.root, p.revision, 'document', 'guide', 'guide_B')).project;
  const copyFile = resourceFile(p, 'document', 'guide_B')!;
  expect(copyFile.slice(0, copyFile.lastIndexOf('/'))).toBe(originalFile.slice(0, originalFile.lastIndexOf('/')));
  expect(await readFile(join(p.root, copyFile))).toEqual(Buffer.from(source));
  const view = getDocumentView(p, 'guide_B');
  expect(view.links.every(link => link.resolved)).toBe(true);
  expect((await saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide_B', blocks: view.blocks.map(b => ({ original: b.index })) }])).changed).toEqual([]);
  p = (await saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide_B', blocks: view.blocks.map(b => b.index === 1
    ? { original: b.index, markdown: b.markdown.replace('Original', 'Changed') } : { original: b.index }) }])).project;
  expect(p.sources.get(copyFile)).toBe(source.replace('Original', 'Changed'));
  expect(p.sources.get(originalFile)).toBe(source);
  expect(p.assets?.size).toBe(1);
});

it.each(['items', 'ITEMS', 'offers', 'CON', '../outside', 'bad/name'])('refuses duplicate destination %s without touching files', async to => {
  const p = await fixture();
  await expect(duplicateResource(p.root, p.revision, 'table', 'items', to)).rejects.toBeDefined();
  expect((await loadProject(p.root)).revision).toBe(p.revision);
});

it('rejects document/table/schema collisions and stale source revisions, and reports ordinary validation errors', async () => {
  let p = await fixture();
  p = (await createDocument(p.root, p.revision, 'occupied', '# Text')).project;
  await expect(duplicateResource(p.root, p.revision, 'table', 'items', 'OCCUPIED')).rejects.toMatchObject({ code: 'NAME_EXISTS' });
  await expect(duplicateResource(p.root, p.revision, 'document', 'occupied', 'ITEMS')).rejects.toMatchObject({ code: 'NAME_EXISTS' });
  const old = p.revision;
  p = (await applyEdits(p.root, p.revision, [{ op: 'update', table: 'items', key: 'currency_gold', values: { kind: 'not-enum' } }])).project;
  await expect(duplicateResource(p.root, old, 'table', 'items', 'copy')).rejects.toMatchObject({ code: 'STALE_REVISION' });
  const result = await duplicateResource(p.root, p.revision, 'table', 'items', 'copy');
  expect(result.changed).toContain('tables/copy.yaml');
  expect(result.diagnostics.some(d => d.file === 'tables/copy.yaml')).toBe(true);
  expect(resourceFile(result.project, 'table', 'copy')).toBeDefined();
});

it('ignores but preserves old plan bytes during read, validation, fmt, edits and rename', async () => {
  let p = await fixture();
  await mkdir(join(p.root, 'plans/review'), { recursive: true });
  const old = Buffer.from('unreadable: [\r\nraw: "items/currency_gold"\r\n');
  await writeFile(join(p.root, 'plans/review/A.yaml'), old);
  const withLegacy = await loadProject(p.root);
  expect(withLegacy.revision).toBe(p.revision);
  expect(validateProject(withLegacy)).toEqual([]);
  expect([...formattedSources(withLegacy).keys()].some(file => file.startsWith('plans/'))).toBe(false);
  await writeChanges(withLegacy, formattedSources(withLegacy));
  p = await loadProject(p.root);
  p = (await renameResource(p.root, p.revision, 'key', 'items/currency_gold', 'coin/blue')).project;
  p = (await duplicateResource(p.root, p.revision, 'table', 'items', 'items_B')).project;
  expect(await readFile(join(p.root, 'plans/review/A.yaml'))).toEqual(old);
  expect(validateProject(p)).toEqual([]);
});
