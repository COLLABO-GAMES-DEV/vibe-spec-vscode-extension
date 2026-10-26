import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { applyEdits, renameResource } from '../src/editing.js';
import { applyStructureEdit, inspectStructure } from '../src/structure.js';
import { createDocument, deleteDocument, documentDiagnostics, editDocument, getDocumentView, listDocuments } from '../src/documents.js';
import { documentSources } from '../src/document-references.js';
import { ScreenHistory } from '../src/history.js';
import { loadProject, readPath } from '../src/project.js';
import { whereUsed } from '../src/usage.js';

const roots: string[] = [];
const items = 'tables/economy/shop/items.yaml';
const offers = 'tables/store/offers.yaml';
const schema = 'schemas/shared/core/items.yaml';
const doc = 'documents/economy/shop/guide.md';
const links = 'documents/help/links.md';
const markdown = '\uFEFF# Economy\r\n\r\n  Paragraph 😀  \r\n\r\n[price](offers/bundle/price) [gold](items/currency_gold)\r\n\r\n![image](assets/pixel.png)';
async function fixture(extra: Record<string, string | Uint8Array> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-domain-editing-')); roots.push(root);
  await cp(fileURLToPath(new URL('./fixtures/project/', import.meta.url)), root, { recursive: true });
  for (const [from, to] of [['tables/items.yaml', items], ['tables/offers.yaml', offers],
    ['schemas/items.yaml', schema], ['schemas/offers.yaml', 'schemas/shared/offers.yaml']]) {
    await mkdir(dirname(join(root, to!)), { recursive: true });
    await rename(join(root, from!), join(root, to!));
  }
  for (const [file, source] of Object.entries({ '.gitattributes': '* text=auto eol=lf\ndocuments/*.md -text\ndocuments/**/*.md -text\ndocuments/assets/* -text\n', [doc]: markdown,
    [links]: '[section](guide/Economy) [column](items/*/name)\n',
    'documents/assets/pixel.png': new Uint8Array([1, 2, 3]), ...extra })) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), source);
  }
  return loadProject(root);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('edits nested rows and renames Keys with folder-free references and history', async () => {
  const project = await fixture();
  const history = new ScreenHistory();
  const operations = [{ op: 'update' as const, table: 'items', key: 'currency_gold', values: { note: 'changed' } }];
  const edited = await applyEdits(project.root, project.revision, operations);
  expect(edited.changed).toEqual([items]);
  history.recordCells(edited, operations);
  const undone = await history.undo(project.root, edited.project.revision);
  expect(readPath(undone.project, 'items/currency_gold/note')).toMatchObject({ value: '001' });
  const redone = await history.redo(project.root, undone.project.revision);
  expect(readPath(redone.project, 'items/currency_gold/note')).toMatchObject({ value: 'changed' });
  const renamed = await renameResource(project.root, redone.project.revision, 'key', 'items/currency_gold', 'gold');
  expect(renamed.changed).toEqual(expect.arrayContaining([items, offers, doc]));
  expect(readPath(renamed.project, 'offers/bundle/currency')).toMatchObject({ value: 'gold' });
  expect(renamed.project.sources.get(doc)).toBe(markdown.replace('items/currency_gold', 'items/gold'));
  history.recordRename(renamed, 'items', 'currency_gold', 'gold');
  const restored = await history.undo(project.root, renamed.project.revision);
  expect(restored.project.sources.get(doc)).toBe(markdown);
  const repeated = await history.redo(project.root, restored.project.revision);
  expect(readPath(repeated.project, 'items/gold')).toHaveProperty('code', 'gold');
});

it('renames tables and schemas inside their current folders, preserving moved bytes', async () => {
  let project = await fixture();
  for (const file of [items, schema]) {
    await writeFile(join(project.root, file), project.sources.get(file)!.replace(/\n/g, '\r\n'));
  }
  project = await loadProject(project.root);
  const renamed = await renameResource(project.root, project.revision, 'table', 'items', 'goods');
  expect(renamed.project.sources.get('tables/economy/shop/goods.yaml')).toBe(project.sources.get(items));
  expect(renamed.project.sources.has(items)).toBe(false);
  expect(renamed.project.sources.get(doc)).toBe(markdown.replace('items/currency_gold', 'goods/currency_gold'));
  expect(renamed.project.sources.get('schemas/shared/offers.yaml')).toContain('table: "goods"');
  const changed = await renameResource(project.root, renamed.project.revision, 'schema', 'items', 'shared-items');
  expect(changed.project.sources.get('schemas/shared/core/shared-items.yaml')).toBe(project.sources.get(schema));
  expect(changed.project.sources.has(schema)).toBe(false);
  expect(readPath(changed.project, 'goods/currency_gold')).toHaveProperty('code', 'currency_gold');
});

it('finds globally shared nested schemas for column renames, structure previews and history', async () => {
  let project = await fixture();
  await mkdir(join(project.root, 'tables/other'), { recursive: true });
  await writeFile(join(project.root, 'tables/other/stock.yaml'), project.sources.get(items)!);
  project = await loadProject(project.root);
  const preview = await inspectStructure(project, { op: 'column-delete', table: 'items', column: 'name' });
  expect(preview.tables).toEqual(['items', 'stock']);
  expect(preview.files).toEqual([schema, items, 'tables/other/stock.yaml'].sort());
  const renamed = await renameResource(project.root, project.revision, 'column', 'items/*/name', 'title');
  expect(readPath(renamed.project, 'stock/currency_gold')).toHaveProperty('title', '골드');
  expect(renamed.project.sources.get(links)).toContain('items/*/title');
  const history = new ScreenHistory(); history.recordStructure(renamed);
  const undone = await history.undo(project.root, renamed.project.revision);
  expect(undone.project.sources).toEqual(project.sources);
  const redone = await history.redo(project.root, undone.project.revision);
  expect(redone.project.sources).toEqual(renamed.project.sources);
});

it('guards structure undo when another nested table uses a newly added shared column', async () => {
  const project = await fixture();
  const added = await applyStructureEdit(project.root, project.revision,
    { op: 'column-add', table: 'items', column: 'extra', definition: { type: 'text' } });
  const history = new ScreenHistory(); history.recordStructure(added);
  await mkdir(join(project.root, 'tables/external'), { recursive: true });
  await writeFile(join(project.root, 'tables/external/stock.yaml'), 'schema: items\nrows:\n  - code: x\n    name: Stock\n    extra: used\n');
  const current = await loadProject(project.root);
  await expect(history.undo(project.root, current.revision)).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
});

it('edits and renames nested documents and headings without reprinting Markdown', async () => {
  const project = await fixture();
  const view = getDocumentView(project, 'guide');
  expect(view.links.find(link => link.kind === 'image')?.resolved).toBe(true);
  const paragraph = view.blocks.find(block => block.kind === 'paragraph' && block.markdown.includes('Paragraph'))!;
  const edited = await editDocument(project.root, project.revision, 'guide',
    [{ op: 'replace', block: paragraph.index, markdown: paragraph.markdown.replace('Paragraph', 'Changed') }]);
  expect(edited.changed).toEqual([doc]);
  expect(edited.project.sources.get(doc)).toBe(markdown.replace('Paragraph', 'Changed'));
  const heading = await renameResource(project.root, edited.project.revision, 'heading', 'guide/Economy', 'Market');
  expect(heading.project.sources.get(doc)).toBe(markdown.replace('Paragraph', 'Changed').replace('# Economy', '# Market'));
  expect(heading.project.sources.get(links)).toContain('guide/Market');
  const renamed = await renameResource(project.root, heading.project.revision, 'document', 'guide', 'manual');
  const destination = 'documents/economy/shop/manual.md';
  expect(await readFile(join(project.root, destination))).toEqual(Buffer.from(heading.project.sources.get(doc)!));
  expect(renamed.project.sources.has(doc)).toBe(false);
  expect(renamed.project.sources.get(links)).toContain('manual/Market');
  const deleted = await deleteDocument(project.root, renamed.project.revision, 'manual');
  expect(deleted.changed).toEqual([destination]);
});

it('reports nested physical paths for document sources, usage and parser/link diagnostics', async () => {
  const project = await fixture({ 'documents/help/broken.md': '# A\n\n# A\n\n[missing](absent)\n\n<b>raw</b>' });
  expect(documentSources(project)).toContainEqual(['guide', doc, markdown]);
  const diagnostics = documentDiagnostics(project).filter(item => item.file === 'documents/help/broken.md');
  expect(diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['DOCUMENT_PATH_DUPLICATE', 'DOCUMENT_LINK_MISSING', 'DOCUMENT_RAW']));
  expect(getDocumentView(project, 'broken').diagnostics.every(item => item.file === 'documents/help/broken.md')).toBe(true);
  const used = await whereUsed(project, 'items/currency_gold');
  expect(used.references).toEqual(expect.arrayContaining([expect.objectContaining({ file: doc }), expect.objectContaining({ file: offers })]));
  expect(used.candidates.some(item => item.file === doc)).toBe(false);
  const column = await whereUsed(project, 'items/*/code');
  expect(column.references).toContainEqual(expect.objectContaining({ file: schema, path: 'primary_key' }));
  const heading = await whereUsed(project, 'guide/Economy');
  expect(heading.references).toContainEqual(expect.objectContaining({ file: links }));
  expect(heading.candidates.some(item => item.file === links)).toBe(false);
});

it('creates resources in a folder, keeps new schemas at root and rejects global name collisions', async () => {
  const project = await fixture({ 'schemas/archive/new.yaml': 'primary_key: id\ncolumns:\n  id:\n    type: string\n' });
  const created = await applyStructureEdit(project.root, project.revision,
    { op: 'table-create', table: 'new', folder: 'economy/deep', key: { code: 'id', label: 'ID' } });
  expect(created.changed).toEqual(['schemas/new_2.yaml', 'tables/economy/deep/new.yaml']);
  const document = await createDocument(project.root, created.project.revision, 'notes', markdown, { folder: 'help/deep' });
  expect(document.changed).toEqual(['documents/help/deep/notes.md']);
  expect(document.project.sources.get('documents/help/deep/notes.md')).toBe(markdown);
  for (const name of ['ITEMS', 'GUIDE', 'NOTES']) {
    await expect(createDocument(project.root, document.project.revision, name, '', { folder: 'elsewhere' })).rejects.toMatchObject({ code: 'NAME_EXISTS' });
    await expect(applyStructureEdit(project.root, document.project.revision,
      { op: 'table-create', table: name, folder: 'elsewhere', key: { code: 'id', label: '' } })).rejects.toMatchObject({ code: 'NAME_EXISTS' });
  }
  await expect(renameResource(project.root, document.project.revision, 'table', 'items', 'GUIDE')).rejects.toMatchObject({ code: 'NAME_EXISTS' });
  await expect(renameResource(project.root, document.project.revision, 'document', 'guide', 'ITEMS')).rejects.toMatchObject({ code: 'NAME_EXISTS' });
  await expect(renameResource(project.root, document.project.revision, 'schema', 'items', 'NEW')).rejects.toMatchObject({ code: 'NAME_EXISTS' });
});

it('lists and diagnoses ambiguous nested documents while refusing reads', async () => {
  const project = await fixture({
    'documents/elsewhere/GUIDE.md': '# Duplicate\n\n# Duplicate\n\n[missing](absent)',
    'documents/elsewhere/items.md': '# Table collision',
  });
  expect(() => documentDiagnostics(project)).not.toThrow();
  expect(documentDiagnostics(project)).toContainEqual(expect.objectContaining({
    code: 'DOCUMENT_PATH_DUPLICATE', file: 'documents/elsewhere/GUIDE.md',
  }));
  expect(listDocuments(project)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'guide', errors: expect.any(Number) }),
    expect.objectContaining({ name: 'GUIDE', errors: expect.any(Number) }),
  ]));
  expect(listDocuments(project).filter(item => ['guide', 'GUIDE', 'items'].includes(item.name)).every(item => item.errors > 0)).toBe(true);
  expect(() => getDocumentView(project, 'guide')).toThrow();
  expect(() => getDocumentView(project, 'items')).toThrow();
});
