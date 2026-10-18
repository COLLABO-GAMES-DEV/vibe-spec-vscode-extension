import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDocument, editDocument, getDocumentView } from '../src/documents.js';
import { initProject, loadProject } from '../src/project.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('moves a raw block using existing operations without serializing neighbouring Markdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-document-move-')); roots.push(root);
  let project = await initProject(root);
  const source = '\uFEFF# 제목\r\n\r\n첫 문단  \r\n\r\n<aside>원문 **그대로**</aside>\r\n\r\n마지막\t';
  project = (await createDocument(root, project.revision, '이동', source)).project;
  const before = getDocumentView(project, '이동');
  const raw = before.blocks[2]!;
  expect(raw.editable).toBe(false);
  const result = await editDocument(root, project.revision, '이동', [
    { op: 'delete', block: raw.index },
    { op: 'insert', before: 1, markdown: raw.markdown },
  ]);
  expect(await readFile(join(root, 'documents/이동.md'), 'utf8')).toBe(
    '\uFEFF# 제목\r\n\r\n<aside>원문 **그대로**</aside>\n\n첫 문단  \r\n\r\n\r\n\r\n마지막\t',
  );
  expect(getDocumentView(result.project, '이동').blocks.map(block => block.markdown)).toEqual([
    before.blocks[0]!.markdown, raw.markdown, before.blocks[1]!.markdown, before.blocks[3]!.markdown,
  ]);
});

it('rejects a move from an old tab revision after another document was edited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-document-move-')); roots.push(root);
  let project = await initProject(root);
  project = (await createDocument(root, project.revision, '첫째', '앞\n\n뒤')).project;
  project = (await createDocument(root, project.revision, '둘째', '다른 문서')).project;
  const frozen = getDocumentView(project, '첫째');
  await editDocument(root, project.revision, '둘째', [{ op: 'replace', block: 0, markdown: '외부 변경' }]);
  await expect(editDocument(root, frozen.revision, '첫째', [
    { op: 'delete', block: 0 }, { op: 'insert', before: 2, markdown: frozen.blocks[0]!.markdown },
  ])).rejects.toMatchObject({ code: 'STALE_REVISION' });
  const current = await loadProject(root);
  expect(getDocumentView(current, '첫째').source).toBe(frozen.source);
  expect(getDocumentView(current, '둘째').source).toBe('외부 변경');
});
