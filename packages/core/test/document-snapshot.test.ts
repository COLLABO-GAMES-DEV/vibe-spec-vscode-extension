import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { getDocumentView, loadProject, saveDocumentSnapshots } from '../src/index.js';
import type { DocumentSnapshot, DocumentSnapshotBlock } from '../src/index.js';

const roots: string[] = [];
const fixture = fileURLToPath(new URL('./fixtures/project/', import.meta.url));
async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-document-snapshot-')); roots.push(root);
  await cp(fixture, root, { recursive: true });
  await writeFile(join(root, '.gitattributes'), '* text=auto eol=lf\ndocuments/*.md -text\ndocuments/**/*.md -text\ndocuments/assets/* -text\n');
  for (const [file, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), source);
  }
  return loadProject(root);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const original = (...indices: number[]): DocumentSnapshotBlock[] => indices.map(index => ({ original: index }));

describe('document snapshots preserve source ranges', () => {
  it.each(['', '\uFEFF \r\n\t\r\n', '\uFEFF  # 한글 😀\r\n \r\n반복  \r\n\r\n반복  \r\n\r\n끝', '# H\n\n끝\n'])('keeps unchanged bytes and revision: %j', async source => {
    const p = await project({ 'documents/guide.md': source });
    const view = getDocumentView(p, 'guide');
    for (const blocks of [view.blocks.map(block => ({ original: block.index })),
      view.blocks.map(block => ({ original: block.index, markdown: block.markdown }))]) {
      const result = await saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide', blocks }]);
      expect(result.changed).toEqual([]);
      expect(result.project.revision).toBe(p.revision);
      expect(await readFile(join(p.root, 'documents/guide.md'))).toEqual(Buffer.from(source));
    }
    expect((await saveDocumentSnapshots(p.root, p.revision, [])).changed).toEqual([]);
  });

  it('changes only the selected repeated block and preserves every outside byte', async () => {
    const source = '\uFEFF  # H 😀\r\n \r\n반복  \r\n\t\r\n반복  \r\n\r\n끝\t';
    const p = await project({ 'documents/domain/guide.md': source });
    const view = getDocumentView(p, 'guide'), changed = view.blocks[2]!;
    const markdown = '고침 😀\n다음 줄';
    const result = await saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide',
      blocks: view.blocks.map(block => block.index === 2 ? { original: 2, markdown } : { original: block.index }) }]);
    expect(result.changed).toEqual(['documents/domain/guide.md']);
    const expected = source.slice(0, changed.start) + markdown + source.slice(changed.end);
    expect(await readFile(join(p.root, 'documents/domain/guide.md'))).toEqual(Buffer.from(expected));
  });

  it('moves actual raw fragments while retaining the original whitespace slots', async () => {
    const source = '\uFEFF# H\r\n \r\n반복  \r\n\r\n<aside>원문 **그대로**</aside>\r\n \r\n반복  \r\n\r\n끝\t';
    const p = await project({ 'documents/guide.md': source });
    const view = getDocumentView(p, 'guide');
    expect(view.blocks[2]!.editable).toBe(false);
    const order = [0, 2, 3, 4, 1];
    const result = await saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide', blocks: original(...order) }]);
    expect(getDocumentView(result.project, 'guide').blocks.map(block => block.markdown)).toEqual(order.map(i => view.blocks[i]!.markdown));
    expect(await readFile(join(p.root, 'documents/guide.md'))).toEqual(Buffer.from(
      '\uFEFF# H\r\n \r\n<aside>원문 **그대로**</aside>\r\n\r\n반복  \r\n \r\n끝\t\r\n\r\n반복  ',
    ));
  });

  it('adds before an indented first block, between blocks and at the end without consuming gaps', async () => {
    const source = '\uFEFF  # H\r\n \r\nBody\r\n';
    const p = await project({ 'documents/guide.md': source });
    const result = await saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide', blocks: [
      { markdown: 'First' }, { original: 0 }, { markdown: 'Middle' }, { original: 1 }, { markdown: 'Last' },
    ] }]);
    expect(await readFile(join(p.root, 'documents/guide.md'))).toEqual(Buffer.from(
      '\uFEFFFirst\n\n  # H\r\n \r\nMiddle\n\nBody\n\nLast\r\n',
    ));
    expect(getDocumentView(result.project, 'guide').blocks.map(block => block.markdown)).toEqual(['First', '# H', 'Middle', 'Body', 'Last']);
  });

  it('removes only omitted ranges, including deleting every block', async () => {
    const source = '\uFEFF  # H\r\n \r\nBody  \r\n\r\nLast\r\n';
    const p = await project({ 'documents/guide.md': source });
    const removed = getDocumentView(p, 'guide').blocks[1]!;
    const result = await saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide', blocks: original(0, 2) }]);
    expect(await readFile(join(p.root, 'documents/guide.md'))).toEqual(Buffer.from(source.slice(0, removed.start) + source.slice(removed.end)));
    await saveDocumentSnapshots(p.root, result.project.revision, [{ name: 'guide', blocks: [] }]);
    expect(await readFile(join(p.root, 'documents/guide.md'))).toEqual(Buffer.from('\uFEFF  \r\n \r\n\r\n\r\n\r\n'));
  });

  it.each(['\n', '\r\n', '\r'])('adds a paragraph between compact source blocks: %j', async newline => {
    const p = await project({ 'documents/guide.md': 'Body' + newline + '# H' });
    const result = await saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide', blocks: [
      { original: 0 }, { markdown: 'New' }, { original: 1 },
    ] }]);
    expect(getDocumentView(result.project, 'guide').blocks.map(block => block.markdown)).toEqual(['Body', 'New', '# H']);
    expect(await readFile(join(p.root, 'documents/guide.md'), 'utf8')).toBe('Body' + newline + (newline === '\r' ? '\n\n' : '\n') + 'New\n\n# H');
  });

  it('combines moves, edits, insertions and deletion using only the read revision indices', async () => {
    const p = await project({ 'documents/guide.md': '# H\r\n\r\nFirst\r\n\r\nRemoved\r\n\r\nLast\r\n' });
    const result = await saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide', blocks: [
      { original: 0 }, { original: 3, markdown: 'Last edited' }, { markdown: 'New' }, { original: 1 },
    ] }]);
    expect(getDocumentView(result.project, 'guide').blocks.map(block => block.markdown)).toEqual(['# H', 'Last edited', 'New', 'First']);
    expect(await readFile(join(p.root, 'documents/guide.md'), 'utf8')).toBe('# H\r\n\r\nLast edited\r\n\r\n\r\n\r\nNew\n\nFirst\r\n');
  });

  it.each(['', '\uFEFF \r\n'])('inserts into a blockless document and preserves its source: %j', async source => {
    const p = await project({ 'documents/guide.md': source });
    const result = await saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide', blocks: [{ markdown: '# New' }, { markdown: 'Body' }] }]);
    expect(getDocumentView(result.project, 'guide').blocks.map(block => block.markdown)).toEqual(['# New', source ? 'Body ' : 'Body']);
    expect(await readFile(join(p.root, 'documents/guide.md'), 'utf8')).toBe(source.startsWith('\uFEFF') ? '\uFEFF# New\n\nBody' + source.slice(1) : '# New\n\nBody');
  });

  it.each([
    '<aside>\r\n\r\n# hidden\r\n\r\n</aside>', '$$\r\nx + y\r\n$$', '| a | b |\r\n| --- |\r\n| x | y |',
    '[label](guide "title")', '```js title="x"\r\ncode\r\n```', '[ref][id]\r\n\r\n[id]: guide',
  ])('retains unsupported raw source while another block changes: %s', async raw => {
    const source = '\uFEFF# H\r\n\r\n' + raw + '\r\n\r\nEnd';
    const p = await project({ 'documents/guide.md': source });
    const view = getDocumentView(p, 'guide');
    expect(view.blocks[1]!.editable).toBe(false);
    const blocks = view.blocks.map(block => block.index === view.blocks.length - 1 ? { original: block.index, markdown: 'Changed' } : { original: block.index });
    await saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide', blocks }]);
    expect(await readFile(join(p.root, 'documents/guide.md'))).toEqual(Buffer.from(source.slice(0, -3) + 'Changed'));
  });
});

describe('snapshot validation and revision protection', () => {
  it.each([
    null, {}, [{ name: 'guide', blocks: null }], [{ name: 'guide', blocks: [{}] }],
    [{ name: 'guide', blocks: [null] }], [{ name: 'guide', blocks: [{ original: 0 }, { original: 0 }] }],
    [{ name: 'guide', blocks: [{ original: -1 }] }], [{ name: 'guide', blocks: [{ original: 2 }] }],
    [{ name: 'guide', blocks: [{ original: 0.5 }] }], [{ name: 'guide', blocks: [{ original: '0' }] }],
    [{ name: 'guide', blocks: [{ original: undefined }] }], [{ name: 'guide', blocks: [{ markdown: undefined }] }],
    [{ name: 'guide', blocks: [{ markdown: 1 }] }], [{ name: 'guide', blocks: [{ markdown: '\ud800' }] }],
    [{ name: 'guide', blocks: [{ markdown: '  \n' }] }], [{ name: 'guide', blocks: [{ original: 0, id: 'persisted' }] }],
    [{ name: 'guide', blocks: [], id: 'persisted' }], [{ name: 'guide', blocks: [] }, { name: 'guide', blocks: [] }],
    [{ name: 'missing', blocks: [] }],
  ])('rejects invalid payloads without writing: %j', async snapshots => {
    const p = await project({ 'documents/guide.md': '# H\n\nBody' });
    await expect(saveDocumentSnapshots(p.root, p.revision, snapshots as unknown as DocumentSnapshot[])).rejects.toThrow();
    expect((await loadProject(p.root)).sources).toEqual(p.sources);
  });

  it.each([
    { source: '# H\nBody', blocks: [{ original: 0, markdown: 'paragraph' }, { original: 1 }] },
    { source: '# H\n\nBody', blocks: [{ markdown: '```' }, { original: 0 }, { original: 1 }] },
    { source: '# H\n\nBody', blocks: [{ original: 0, markdown: '<div>' }, { original: 1 }, { markdown: '</div>' }] },
    { source: '# H\n\n- untouched', blocks: [{ original: 0, markdown: '- changed' }, { original: 1 }] },
    { source: '- first\n\n# Separator\n\n- last', blocks: [{ original: 0 }, { original: 2 }] },
    { source: '- first\n\n# Separator\n\n- last', blocks: [{ original: 0 }, { original: 2 }, { original: 1 }] },
  ])('refuses absorption of unchanged blocks: $source', async ({ source, blocks }) => {
    const p = await project({ 'documents/guide.md': source });
    await expect(saveDocumentSnapshots(p.root, p.revision, [{ name: 'guide', blocks }])).rejects.toMatchObject({ code: 'DOCUMENT_BOUNDARY' });
    expect((await loadProject(p.root)).sources).toEqual(p.sources);
  });

  it('dry-runs all documents together and rejects stale revisions even for no-ops', async () => {
    const p = await project({ 'documents/a.md': 'A', 'documents/b.md': 'B' });
    const snapshots = [{ name: 'a', blocks: [{ original: 0, markdown: 'New A' }] }, { name: 'b', blocks: [{ original: 0, markdown: 'New B' }] }];
    const dry = await saveDocumentSnapshots(p.root, p.revision, snapshots, { dryRun: true });
    expect(dry.changed.sort()).toEqual(['documents/a.md', 'documents/b.md']);
    expect(dry.planned.sources.get('documents/a.md')).toBe('New A');
    expect(dry.planned.sources.get('documents/b.md')).toBe('New B');
    expect((await loadProject(p.root)).revision).toBe(p.revision);
    await writeFile(join(p.root, 'documents/b.md'), 'External');
    for (const payload of [snapshots, [], [{ name: 'a', blocks: original(0) }]]) {
      await expect(saveDocumentSnapshots(p.root, p.revision, payload)).rejects.toMatchObject({ code: 'STALE_REVISION' });
    }
    expect(await readFile(join(p.root, 'documents/a.md'), 'utf8')).toBe('A');
    expect(await readFile(join(p.root, 'documents/b.md'), 'utf8')).toBe('External');
  });

  it('does not write earlier valid drafts when a later document fails validation', async () => {
    const p = await project({ 'documents/a.md': 'A', 'documents/b.md': '# H\nBody' });
    await expect(saveDocumentSnapshots(p.root, p.revision, [
      { name: 'a', blocks: [{ original: 0, markdown: 'Changed' }] },
      { name: 'b', blocks: [{ original: 0, markdown: 'paragraph' }, { original: 1 }] },
    ])).rejects.toMatchObject({ code: 'DOCUMENT_BOUNDARY' });
    expect((await loadProject(p.root)).sources).toEqual(p.sources);
  });
});

describe('snapshot rename composition', () => {
  it.each([false, true])('rewrites every final draft after simultaneous heading/tag renames, reverse order %s', async reverse => {
    const p = await project({
      'documents/a.md': '\uFEFF# Old\r\n\r\n## Child\r\n\r\n<!-- name: old-tag -->\r\nBody\r\n\r\n[b](b/Before)\r\n',
      'documents/b.md': '# Before\n\n[old](a/Old/Child/old-tag "keep title")\n\nProse Old and `a/Old`',
      'documents/c.md': '[outside](a/Old/Child/old-tag)\r\n',
    });
    const snapshots: DocumentSnapshot[] = [
      { name: 'a', blocks: [{ original: 0, markdown: '# New' }, { original: 1, markdown: '## Renamed' },
        { original: 2, markdown: '<!-- name: new-tag -->\r\nBody' }, { original: 3 }] },
      { name: 'b', blocks: [{ original: 0, markdown: '# After' },
        { original: 1, markdown: '[draft label](a/Old/Child/old-tag "keep title")' }, { original: 2 },
        { markdown: '[new link](a/Old/Child)' }] },
    ];
    if (reverse) snapshots.reverse();
    const result = await saveDocumentSnapshots(p.root, p.revision, snapshots);
    expect(result.project.sources.get('documents/a.md')).toBe('\uFEFF# New\r\n\r\n## Renamed\r\n\r\n<!-- name: new-tag -->\r\nBody\r\n\r\n[b](b/After)\r\n');
    expect(result.project.sources.get('documents/b.md')).toBe('# After\n\n[draft label](a/New/Renamed/new-tag "keep title")\n\nProse Old and `a/Old`\n\n[new link](a/New/Renamed)');
    expect(result.project.sources.get('documents/c.md')).toBe('[outside](a/New/Renamed/new-tag)\r\n');
    expect(result.diagnostics.filter(item => item.severity !== 'warning')).toEqual([]);
  });

  it('checks newly introduced draft links before a structural identity change', async () => {
    const p = await project({ 'documents/a.md': '# H\n\n## Child', 'documents/b.md': 'Body' });
    await expect(saveDocumentSnapshots(p.root, p.revision, [
      { name: 'a', blocks: [{ original: 0 }, { original: 1, markdown: '# Child' }] },
      { name: 'b', blocks: [{ original: 0, markdown: '[new](a/H/Child)' }] },
    ])).rejects.toMatchObject({ code: 'RENAME_REQUIRED' });
    expect((await loadProject(p.root)).sources).toEqual(p.sources);
  });

  it('keeps existing rename collision protection', async () => {
    const p = await project({ 'documents/a.md': '# First\n\n# Second' });
    await expect(saveDocumentSnapshots(p.root, p.revision, [{ name: 'a', blocks: [
      { original: 0, markdown: '# Second' }, { original: 1 },
    ] }])).rejects.toMatchObject({ code: 'NAME_EXISTS' });
  });

  it('protects references when an unchanged heading moves under a different parent', async () => {
    const p = await project({ 'documents/a.md': '# H\n\n## Child\n\n# Other', 'documents/b.md': '[old](a/H/Child)' });
    await expect(saveDocumentSnapshots(p.root, p.revision, [{ name: 'a', blocks: original(0, 2, 1) }]))
      .rejects.toMatchObject({ code: 'RENAME_REQUIRED' });
    expect((await loadProject(p.root)).sources).toEqual(p.sources);
  });

  it('permits an explicitly changed group to merge lists while preserving its neighbors', async () => {
    const source = '\uFEFF# H\r\n\r\n- first\r\n\r\n# Separator\r\n\r\n- last\r\n\r\nEnd\r\n';
    const p = await project({ 'documents/a.md': source });
    const result = await saveDocumentSnapshots(p.root, p.revision, [{ name: 'a', blocks: [
      { original: 0 }, { original: 1, markdown: '- first\n- last' }, { original: 4 },
    ] }]);
    expect(getDocumentView(result.project, 'a').blocks.map(block => block.markdown)).toEqual(['# H', '- first\n- last', 'End']);
    expect(await readFile(join(p.root, 'documents/a.md'), 'utf8')).toBe('\uFEFF# H\r\n\r\n- first\n- last\r\n\r\n\r\n\r\n\r\n\r\nEnd\r\n');
  });

  it('allows explicit deletion and reports its broken references', async () => {
    const p = await project({ 'documents/a.md': '# H\n\n## Child', 'documents/b.md': '[old](a/H/Child)' });
    const result = await saveDocumentSnapshots(p.root, p.revision, [{ name: 'a', blocks: original(0) }]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_LINK_MISSING', target: 'a/H/Child' }));
  });
});
