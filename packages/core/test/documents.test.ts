import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/document-parser.js';
import { createDocument, deleteDocument, documentDiagnostics, editDocument, getDocumentView, listDocuments, readDocumentPath, renameDocument } from '../src/documents.js';
import { documentUsages, renameDocumentLinks } from '../src/document-references.js';
import { formattedSources, loadProject, readPath, writeChanges } from '../src/project.js';
import { applyEdits, renameResource } from '../src/editing.js';
import { createPlan, readVariant, writeVariant } from '../src/plans.js';
import { validateProject } from '../src/validation.js';
import type { DocumentOperation } from '../src/document-types.js';

const folders: string[] = [];
const fixture = fileURLToPath(new URL('./fixtures/project/', import.meta.url));
async function project(files: Record<string, string | Uint8Array> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-documents-')); folders.push(root);
  await cp(fixture, root, { recursive: true });
  await writeFile(join(root, '.gitattributes'), '* text=auto eol=lf\ndocuments/*.md -text\ndocuments/assets/* -text\n');
  for (const [file, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), source);
  }
  return loadProject(root);
}
afterEach(async () => { await Promise.all(folders.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('Markdown source model', () => {
  it('keeps BOM, UTF-16 offsets, CRLF, gaps, nested compound blocks and the missing final newline', () => {
    const source = '\uFEFF  # 한글 😀\r\n \r\n<!-- name: 이름표 -->\r\n문단  \r\n\r\n- [x] 첫째\r\n  - 둘째\r\n\r\n> 인용\r\n>\r\n> - 목록\r\n\r\n| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\n```js\r\nconst a = 1;\r\n```\r\n\r\n---\r\n\r\n끝';
    const parsed = parseMarkdown('문서', source);
    expect(parsed.source).toBe(source);
    expect(parsed.blocks.map(block => block.kind)).toEqual(['heading', 'paragraph', 'list', 'blockquote', 'table', 'code', 'thematicBreak', 'paragraph']);
    expect(parsed.blocks[0]).toMatchObject({ start: source.indexOf('#'), end: source.indexOf('\r\n'), path: '문서/한글 😀' });
    expect(parsed.blocks[1]).toMatchObject({ path: '문서/한글 😀/이름표', markdown: '<!-- name: 이름표 -->\r\n문단  ' });
    expect(parsed.blocks[2]!.markdown).toContain('  - 둘째');
    let reconstructed = '', previous = 0;
    for (const block of parsed.blocks) {
      expect(source.slice(block.start, block.end)).toBe(block.markdown);
      reconstructed += source.slice(previous, block.start) + block.markdown;
      previous = block.end;
    }
    expect(reconstructed + source.slice(previous)).toBe(source);
    expect(parsed.diagnostics).toEqual([]);
  });

  it('uses displayed heading text and real parents when levels skip', () => {
    const parsed = parseMarkdown('guide', '# **경제**\n\n### `획득`\n\n<!-- name: 지급 -->\n설명\n\n## 소비\n\n# 기타');
    expect(parsed.blocks.map(block => block.path)).toEqual(['guide/경제', 'guide/경제/획득', 'guide/경제/획득/지급', 'guide/경제/소비', 'guide/기타']);
    const invalid = parseMarkdown('guide', '# A\n\n## B\n\n<!-- name: B -->\ntext\n\n## B\n\n# bad/name\n\n<!-- name: dangling -->');
    expect(invalid.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['DOCUMENT_PATH_DUPLICATE', 'DOCUMENT_NAME_INVALID', 'DOCUMENT_TAG_ORPHAN']));
    expect(parseMarkdown('guide', 'First\r\nsecond\r\n=====').blocks[0]!.path).toBe('guide/First second');
    const doubleBom = '\uFEFF\uFEFFcontent';
    const block = parseMarkdown('guide', doubleBom).blocks[0]!;
    expect(doubleBom.slice(block.start, block.end)).toBe(block.markdown);
    expect(block.markdown).toBe('\uFEFFcontent');
  });

  it.each([
    '<b>HTML</b>', '- item with <i>HTML</i>', '$x + y$', '$$\nx + y\n$$',
    '| a | b |\n| --- |\n| x | y |', '| a | b |\n| - | - |\n| x |',
    '| a | b |\n| :- | -: |\n| x | y |', 'body ![image](assets/x.png)',
    '[label](guide "title")', '![image](assets/x.png "caption")',
    '```js title="sample"\ncode\n```', '`two\nlines`',
    '[ref][id]\n\n[id]: guide', 'footnote[^one]\n\n[^one]: note',
  ])('keeps unsupported descendants in raw mode: %s', source => {
    const parsed = parseMarkdown('guide', source);
    expect(parsed.blocks[0]!.editable).toBe(false);
    expect(parsed.blocks[0]!.kind).toBe('raw');
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_RAW', severity: 'warning' }));
    expect(parsed.source).toBe(source);
  });

  it('keeps an entire HTML container opaque, including its Markdown children', () => {
    const aside = '<aside>\n\n**Callout**\n\n# not a public heading\n\n- item\n\n<div>\nnested\n</div>\n\n</aside>';
    const parsed = parseMarkdown('guide', '# Public\n\n' + aside + '\n\nAfter');
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[1]).toMatchObject({ kind: 'raw', markdown: aside, editable: false });
    expect(parsed.blocks[1]!.path).toBeUndefined();
    expect(parseMarkdown('guide', '`$formula$`').blocks[0]!.editable).toBe(true);
  });

  it('finds exact inline, escaped, balanced, angled and reference destination spans', () => {
    const source = '\uFEFF😀 [nested **label**](doc/one(two(three))/end "title")\r\n' +
      '[a `]` label](doc/escaped\\(name\\)) [angle](<doc/space name>)\r\n' +
      '[full][Ref] [Ref][] [Ref] ![image][pic] [literal](doc/a&amp;b)\r\n\r\n' +
      '[Ref]:\r\n  <doc/space name>\r\n  "definition title"\r\n\r\n[pic]: assets/image.png\r\n\r\n' +
      '> [quote][q]\r\n>\r\n> [q]:\r\n>   doc/quote\r\n';
    const parsed = parseMarkdown('guide', source);
    expect(parsed.links.map(link => source.slice(link.start, link.end))).toEqual([
      'doc/one(two(three))/end', 'doc/escaped\\(name\\)', 'doc/space name',
      'doc/space name', 'doc/space name', 'doc/space name', 'assets/image.png', 'doc/a&amp;b', 'doc/quote',
    ]);
    expect(parsed.links[1]!.path).toBe('doc/escaped(name)');
    expect(parsed.links[6]!.kind).toBe('image');
    expect(parsed.links[7]!.path).toBe('doc/a&b');
    expect(parseMarkdown('guide', '<https://example.com> https://example.com <a@example.com>').links.map(link => link.kind))
      .toEqual(['external', 'external', 'external']);
    const image = '![alt `]` code](assets/a.png)';
    const imageLink = parseMarkdown('guide', image).links[0]!;
    expect(image.slice(imageLink.start, imageLink.end)).toBe('assets/a.png');
  });
});

describe('document reading and diagnostics', () => {
  it('reads exact sections/tags and resolves table values without recursive document links', async () => {
    const source = '# Economy\r\n\r\n### Earn\r\n\r\n<!-- name: amount -->\r\nBody\r\n\r\n[price](offers/bundle/price) [self](economy/Economy/Earn) [other](other)\r\n\r\n## Spend\r\nEnd';
    const p = await project({ 'documents/economy.md': source, 'documents/other.md': '[cycle](economy)' });
    expect(readPath(p, 'economy')).toBe(source);
    expect(readDocumentPath(p, 'economy/Economy/Earn')).toBe(source.slice(source.indexOf('###'), source.indexOf('## Spend')));
    expect(readDocumentPath(p, 'economy/Economy/Earn/amount')).toBe('<!-- name: amount -->\r\nBody');
    const view = getDocumentView(p, 'economy');
    expect(view.revision).toBe(p.revision);
    expect(view.links.map(link => link.resolved)).toEqual([true, true, true]);
    expect(view.links[0]!.value).toBe('+001.2300E+0002');
    expect(documentDiagnostics(p)).toEqual([]);
    expect(listDocuments(p)).toEqual([{ name: 'economy', errors: 0, warnings: 0 }, { name: 'other', errors: 0, warnings: 0 }]);
  });

  it('does not truncate sections at headings inside opaque HTML groups', async () => {
    const section = '# Public\n\n<aside>\n\n# Private\n\n</aside>\n\nEnd\n\n';
    const p = await project({ 'documents/guide.md': section + '# Next' });
    expect(readDocumentPath(p, 'guide/Public')).toBe(section);
    expect(() => readDocumentPath(p, 'guide/Private')).toThrow();
  });

  it('rejects duplicate/slash heading paths and their descendants while retaining whole source access', async () => {
    const source = '# bad/name\n\n## child\n\n# same\n\n## child\n\n# same';
    const p = await project({ 'documents/guide.md': source });
    for (const path of ['guide/bad/name', 'guide/bad/name/child', 'guide/same', 'guide/same/child']) {
      expect(() => readDocumentPath(p, path)).toThrow();
    }
    expect(readDocumentPath(p, 'guide')).toBe(source);
    expect(listDocuments(p)[0]!.errors).toBe(2);
  });

  it('reports broken resources, missing images, traversal and remote image limitations', async () => {
    const p = await project({ 'documents/guide.md': '[missing](items/absent/name)\n\n![ok](assets/a.png)\n\n![missing](assets/missing.png)\n\n![bad](assets/%2e%2e/secret.png)\n\n![remote](https://example.com/a.png)',
      'documents/assets/a.png': new Uint8Array([137, 80, 78, 71]) });
    const view = getDocumentView(p, 'guide');
    expect(view.links.map(link => link.resolved)).toEqual([false, true, false, false, false]);
    expect(view.diagnostics.map(item => item.code)).toEqual(['DOCUMENT_LINK_MISSING', 'DOCUMENT_IMAGE_MISSING', 'DOCUMENT_IMAGE_PATH', 'DOCUMENT_IMAGE_EXTERNAL']);
    expect(listDocuments(p)[0]).toMatchObject({ errors: 3, warnings: 1 });
  });

  it('validates baseline document links against each table variant', async () => {
    let p = await project({ 'documents/guide.md': '[row](items/consumable_potion/name)' });
    p = (await createPlan(p.root, p.revision, 'alternative', { title: 'Alternative', status: 'review' })).project;
    p = (await writeVariant(p.root, p.revision, 'alternative', 'A', { remove: ['items/consumable_potion'] })).project;
    expect(documentDiagnostics(p)).toEqual([]);
    expect(documentDiagnostics(readVariant(p, 'alternative', 'A'))).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_LINK_MISSING' }));
    expect(validateProject(p)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_LINK_MISSING' }));
  });
});

describe('document writes preserve source', () => {
  it('does not write for unchanged replacements, empty operations, same-name renames or fmt', async () => {
    const source = '\uFEFF# 한글 😀\r\n\r\n문단  \r\n\n끝';
    const p = await project({ 'documents/guide.md': source });
    const bytes = await readFile(join(p.root, 'documents/guide.md'));
    const parsed = getDocumentView(p, 'guide');
    const result = await editDocument(p.root, p.revision, 'guide', parsed.blocks.map(block => ({ op: 'replace', block: block.index, markdown: block.markdown })));
    expect(result.changed).toEqual([]);
    expect(result.project.revision).toBe(p.revision);
    expect((await editDocument(p.root, p.revision, 'guide', [])).changed).toEqual([]);
    expect((await renameDocument(p.root, p.revision, 'document', 'guide', 'guide')).changed).toEqual([]);
    expect(formattedSources(p).has('documents/guide.md')).toBe(false);
    await writeChanges(p, formattedSources(p));
    expect(await readFile(join(p.root, 'documents/guide.md'))).toEqual(bytes);
  });

  it('splices one changed block while every byte outside it stays unchanged', async () => {
    const source = '\uFEFF  # Heading 😀\r\n\r\n첫 문단  \r\n\r\n\tcode\r\n\r\n끝';
    const p = await project({ 'documents/guide.md': source });
    const block = getDocumentView(p, 'guide').blocks[1]!;
    const result = await editDocument(p.root, p.revision, 'guide', [{ op: 'replace', block: 1, markdown: '바뀐 😀 문단\n다음 줄' }]);
    const expected = source.slice(0, block.start) + '바뀐 😀 문단\n다음 줄' + source.slice(block.end);
    expect(result.project.sources.get('documents/guide.md')).toBe(expected);
    expect(await readFile(join(p.root, 'documents/guide.md'))).toEqual(Buffer.from(expected));
    expect(result.changed).toEqual(['documents/guide.md']);
  });

  it('applies all batch indices to the opening revision and preserves insertion/deletion gaps', async () => {
    const source = '\uFEFF  # H\r\n\r\nfirst\r\n\r\nsecond\r\n';
    const p = await project({ 'documents/guide.md': source });
    const result = await editDocument(p.root, p.revision, 'guide', [
      { op: 'insert', before: 0, markdown: '# New' }, { op: 'replace', block: 1, markdown: 'changed' }, { op: 'delete', block: 2 },
    ]);
    expect(result.project.sources.get('documents/guide.md')).toBe('\uFEFF# New\n\n  # H\r\n\r\nchanged\r\n\r\n\r\n');
    const append = await editDocument(result.project.root, result.project.revision, 'guide', [{ op: 'insert', before: 3, markdown: 'last' }]);
    expect(append.project.sources.get('documents/guide.md')).toBe('\uFEFF# New\n\n  # H\r\n\r\nchanged\n\nlast\r\n\r\n\r\n');
  });

  it.each([
    [{ op: 'replace', block: 0, markdown: '# A' }, { op: 'delete', block: 0 }],
    [{ op: 'insert', before: 0, markdown: 'A' }, { op: 'insert', before: 0, markdown: 'B' }],
    [{ op: 'delete', block: -1 }], [{ op: 'insert', before: 7, markdown: 'text' }],
    [{ op: 'replace', block: 0, markdown: 123 }], [{ op: 'insert', before: 0, markdown: '  ' }],
  ].map(operations => ({ operations })))('refuses invalid/overlapping batches without writing: $operations', async ({ operations }) => {
    const p = await project({ 'documents/guide.md': '# H\n\nBody' });
    await expect(editDocument(p.root, p.revision, 'guide', operations as unknown as DocumentOperation[])).rejects.toThrow();
    expect((await loadProject(p.root)).sources).toEqual(p.sources);
  });

  it('rejects replacements that absorb an untouched neighboring block', async () => {
    const p = await project({ 'documents/guide.md': '# H\nBody\n\nLast' });
    await expect(editDocument(p.root, p.revision, 'guide', [{ op: 'replace', block: 0, markdown: 'paragraph' }]))
      .rejects.toMatchObject({ code: 'DOCUMENT_BOUNDARY' });
    await expect(editDocument(p.root, p.revision, 'guide', [{ op: 'insert', before: 0, markdown: '```' }]))
      .rejects.toMatchObject({ code: 'DOCUMENT_BOUNDARY' });
    expect((await loadProject(p.root)).sources).toEqual(p.sources);
  });

  it('dry-runs create/edit/delete and rejects stale revisions even on no-op requests', async () => {
    let p = await project();
    const dryCreate = await createDocument(p.root, p.revision, 'guide', '# Original', { dryRun: true });
    expect(dryCreate.planned.sources.get('documents/guide.md')).toBe('# Original');
    expect((await loadProject(p.root)).revision).toBe(p.revision);
    p = (await createDocument(p.root, p.revision, 'guide', '# Original')).project;
    const dryEdit = await editDocument(p.root, p.revision, 'guide', [{ op: 'replace', block: 0, markdown: '# New' }], { dryRun: true });
    expect(dryEdit.planned.sources.get('documents/guide.md')).toBe('# New');
    expect((await deleteDocument(p.root, p.revision, 'guide', { dryRun: true })).planned.sources.has('documents/guide.md')).toBe(false);
    await writeFile(join(p.root, 'documents/guide.md'), '# External');
    await expect(editDocument(p.root, p.revision, 'guide', [])).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(renameDocument(p.root, p.revision, 'document', 'guide', 'guide')).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(await readFile(join(p.root, 'documents/guide.md'), 'utf8')).toBe('# External');
  });

  it('enforces the portable shared namespace and preserves supplied source bytes', async () => {
    let p = await project();
    for (const name of ['items', 'ITEMS', '../outside', 'CON', 'bad/name']) {
      await expect(createDocument(p.root, p.revision, name, '# Source')).rejects.toThrow();
    }
    const source = '\uFEFF# 새 문서\r\n\r\n끝  ';
    p = (await createDocument(p.root, p.revision, '한글', source)).project;
    expect(p.sources.get('documents/한글.md')).toBe(source);
    await expect(createDocument(p.root, p.revision, '한글'.normalize('NFD'), source)).rejects.toMatchObject({ code: 'NAME_EXISTS' });
    expect(p.files.has('documents/한글.md')).toBe(false);
  });

  it('permits deletion and reports broken links without introducing undeclared row protection', async () => {
    let p = await project({ 'documents/guide.md': '# H', 'documents/links.md': '[doc](guide/H) [row](items/consumable_potion)' });
    const removed = await deleteDocument(p.root, p.revision, 'guide'); p = removed.project;
    expect(removed.diagnostics).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_LINK_MISSING', target: 'guide/H' }));
    const row = await applyEdits(p.root, p.revision, [{ op: 'delete', table: 'items', key: 'consumable_potion' }]);
    expect(row.diagnostics).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_LINK_MISSING', target: 'items/consumable_potion' }));
  });
});

describe('document references and renames', () => {
  it('separates prose/code candidates from structured destinations, including a shared line', async () => {
    const p = await project({ 'documents/guide.md': '[link](items/currency_gold/name) mentions currency_gold\n\n`items/currency_gold`\n\nhttps://example.com/currency_gold\n' });
    const used = documentUsages(p, 'items/currency_gold');
    expect(used.references).toHaveLength(1);
    expect(used.references[0]).toMatchObject({ line: 1, file: 'documents/guide.md' });
    expect(used.candidates.map(item => item.line)).toEqual([1, 3]);
    expect(documentUsages(p, 'items/*/name').references).toHaveLength(1);
  });

  it('renames only target destination segments, preserving titles, escapes, references and evidence', async () => {
    const source = '[a](items/currency_gold/name "currency_gold title") [b](items/currency_gold_bonus/name)\r\n' +
      '[c][r] [d](items&#47;currency_gold&#47;name) [e](items%2Fcurrency_gold%2Fname)\r\n\r\n' +
      '[r]: <items/currency_gold/name> \'keep title\'\r\n\r\n`items/currency_gold` and currency_gold prose';
    const p = await project({ 'documents/guide.md': source, 'plans/review/_plan.yaml': 'title: Review\nstatus: review\nsources:\n  - raw: "items/currency_gold"\n' });
    const changes = renameDocumentLinks(p, 'key', 'items/currency_gold', 'new (coin)');
    const expected = source.replace('items/currency_gold/name "', 'items/new%20%28coin%29/name "')
      .replace('items&#47;currency_gold&#47;', 'items&#47;new%20%28coin%29&#47;')
      .replace('items%2Fcurrency_gold%2F', 'items%2Fnew%20%28coin%29%2F')
      .replace('<items/currency_gold/name>', '<items/new %28coin%29/name>');
    expect(changes.get('documents/guide.md')).toBe(expected);
    expect([...changes.keys()]).toEqual(['documents/guide.md']);
    expect(parseMarkdown('guide', expected).links.filter(link => link.path === 'items/new (coin)/name')).toHaveLength(4);
  });

  it('renames unused and duplicate definitions while references continue to use the first definition', async () => {
    const source = '[r]\n\n[r]: items/currency_gold/name\n\n[r]: items/currency_gold/note\n\n[unused]: items/currency_gold';
    const p = await project({ 'documents/guide.md': source });
    expect(getDocumentView(p, 'guide').links[0]!.value).toBe('골드');
    expect(renameDocumentLinks(p, 'key', 'items/currency_gold', 'coin').get('documents/guide.md')).toBe(source.replaceAll('items/currency_gold', 'items/coin'));
  });

  it('updates links for table, key and shared-schema column renames through the parent API', async () => {
    const other = await readFile(join(fixture, 'tables/items.yaml'), 'utf8');
    let p = await project({ 'tables/other-items.yaml': other,
      'documents/guide.md': '[a](items/currency_gold/name) [b](other-items/currency_gold/name) [all](items/*/name)' });
    p = (await renameResource(p.root, p.revision, 'column', 'items/*/name', 'label')).project;
    expect(p.sources.get('documents/guide.md')).toBe('[a](items/currency_gold/label) [b](other-items/currency_gold/label) [all](items/*/label)');
    p = (await renameResource(p.root, p.revision, 'key', 'items/currency_gold', 'coin')).project;
    p = (await renameResource(p.root, p.revision, 'table', 'items', 'catalog')).project;
    expect(p.sources.get('documents/guide.md')).toBe('[a](catalog/coin/label) [b](other-items/currency_gold/label) [all](catalog/*/label)');
    expect(documentDiagnostics(p)).toEqual([]);
  });

  it('renames document, formatted heading and tag declarations with their descendant destinations', async () => {
    const source = '\uFEFF  # **Old**  ###\r\n\r\n### Child\r\n\r\n<!--  name:  tag   -->\r\nBody Old tag\r\n\r\n[self](guide/Old/Child/tag "Old")';
    let p = await project({ 'documents/guide.md': source, 'documents/links.md': '[section](guide/Old/Child) [tag](guide/Old/Child/tag)' });
    const heading = await renameDocument(p.root, p.revision, 'heading', 'guide/Old', 'New'); p = heading.project;
    expect(p.sources.get('documents/guide.md')).toBe(source.replace('**Old**', '**New**').replace('(guide/Old/', '(guide/New/'));
    expect(p.sources.get('documents/links.md')).toBe('[section](guide/New/Child) [tag](guide/New/Child/tag)');
    expect(heading.candidates.some(item => item.text.includes('Body Old tag'))).toBe(true);
    p = (await renameDocument(p.root, p.revision, 'tag', 'guide/New/Child/tag', 'reward')).project;
    expect(p.sources.get('documents/guide.md')).toContain('<!--  name:  reward   -->\r\nBody Old tag');
    p = (await renameDocument(p.root, p.revision, 'document', 'guide', 'rules')).project;
    expect(p.sources.has('documents/guide.md')).toBe(false);
    expect(p.sources.get('documents/rules.md')).toContain('[self](rules/New/Child/reward "Old")');
    expect(p.sources.get('documents/links.md')).toBe('[section](rules/New/Child) [tag](rules/New/Child/reward)');
    expect(documentDiagnostics(p).filter(item => item.severity !== 'warning')).toEqual([]);
  });

  it('renames heading destinations when a visual replacement changes displayed text', async () => {
    let p = await project({ 'documents/guide.md': '# Old\n\n### Child\n\n[self](guide/Old/Child)',
      'documents/links.md': '[heading][ref]\n\n[ref]: guide/Old/Child "keep"' });
    p = (await editDocument(p.root, p.revision, 'guide', [{ op: 'replace', block: 0, markdown: '# **New**' }])).project;
    expect(p.sources.get('documents/guide.md')).toBe('# **New**\n\n### Child\n\n[self](guide/New/Child)');
    expect(p.sources.get('documents/links.md')).toBe('[heading][ref]\n\n[ref]: guide/New/Child "keep"');
  });

  it('preserves a heading link and code delimiters when renaming a single displayed name', async () => {
    let p = await project({ 'documents/guide.md': '# [**Old**](guide/Old "title")\n\n## ``Child``' });
    p = (await renameDocument(p.root, p.revision, 'heading', 'guide/Old', 'New')).project;
    p = (await renameDocument(p.root, p.revision, 'heading', 'guide/New/Child', 'Nested')).project;
    expect(p.sources.get('documents/guide.md')).toBe('# [**New**](guide/New "title")\n\n## ``Nested``');
  });

  it('treats literal heading stars as names and encodes non-ASCII spaces without changing other paths', async () => {
    let p = await project({ 'documents/guide.md': '# *\n\n## Child\n\n# Other\n\n## Child',
      'documents/links.md': '[one](guide/*/Child) [two](guide/Other/Child)' });
    expect(documentUsages(p, 'guide/*/Child').references).toHaveLength(1);
    p = (await renameDocument(p.root, p.revision, 'heading', 'guide/*', 'A\u00a0B')).project;
    expect(p.sources.get('documents/links.md')).toBe('[one](guide/A%C2%A0B/Child) [two](guide/Other/Child)');
    expect(documentDiagnostics(p)).toEqual([]);
  });

  it('lets source edits repair invalid headings without retargeting their ambiguous old links', async () => {
    const p = await project({ 'documents/guide.md': '# bad/name\n\n## Child', 'documents/links.md': '[old](guide/bad/name/Child)' });
    const result = await editDocument(p.root, p.revision, 'guide', [{ op: 'replace', block: 0, markdown: '# Repaired' }]);
    expect(readDocumentPath(result.project, 'guide/Repaired/Child')).toBe('## Child');
    expect(result.project.sources.get('documents/links.md')).toBe('[old](guide/bad/name/Child)');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_LINK_MISSING' }));
  });

  it('requires an explicit rename for complex referenced structure changes and rejects collisions', async () => {
    const p = await project({ 'documents/guide.md': '# H\n\n## Old\n\n## Existing', 'documents/link.md': '[target](guide/H/Old)' });
    await expect(editDocument(p.root, p.revision, 'guide', [{ op: 'replace', block: 1, markdown: '# New' }]))
      .rejects.toMatchObject({ code: 'RENAME_REQUIRED' });
    await expect(renameDocument(p.root, p.revision, 'heading', 'guide/H/Old', 'Existing')).rejects.toMatchObject({ code: 'NAME_EXISTS' });
    await expect(renameDocument(p.root, p.revision, 'document', 'guide', 'GUIDE')).rejects.toMatchObject({ code: 'CASE_ONLY_RENAME' });
    expect((await loadProject(p.root)).sources).toEqual(p.sources);
  });
});
