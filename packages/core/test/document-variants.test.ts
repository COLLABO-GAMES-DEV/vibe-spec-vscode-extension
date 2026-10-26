import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentSnapshotBlock } from '../src/document-types.js';
import { afterEach, expect, it } from 'vitest';
import { loadProject } from '../src/project.js';
import { createPlan, writeVariant, readVariant, getPlan, approvePlan } from '../src/plans.js';
import { documentScope } from '../src/document-variants.js';
import { getTargetDocumentView, saveTargetDocumentSnapshots, editVariantDocument } from '../src/document-targets.js';
import { renameResource } from '../src/editing.js';
import { whereUsed } from '../src/usage.js';
import { validateProject } from '../src/validation.js';
const roots: string[] = [];
const source = '\uFEFF# 前 😀\r\n \r\n<!-- name: note -->\r\n원문  \r\n\r\n## 선택\r\n\r\n내용\r\n\r\n# 바깥\r\n\r\n끝  ';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-doc-variants-')); roots.push(root);
  await cp(fileURLToPath(new URL('./fixtures/project/', import.meta.url)), root, { recursive: true });
  await mkdir(join(root, 'documents'), { recursive: true }); await writeFile(join(root, 'documents/rules.md'), source);
  let p = await loadProject(root); p = (await createPlan(root, p.revision, 'review', { title: 'Synthetic', status: 'review' })).project;
  return p;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it('captures named paragraph bytes without its tag, warns with three values, and approves only that range', async () => {
  let p = await fixture(); const path = 'rules/前 😀/note';
  expect(documentScope(p, path).markdown).toBe('원문  ');
  p = (await writeVariant(p.root, p.revision, 'review', 'A', { documents: { [path]: '대안 😀  ' } })).project;
  p = (await writeVariant(p.root, p.revision, 'review', 'B', { documents: { [path]: '다른 안' } })).project;
  expect(readVariant(p, 'review', 'A').sources.get('documents/rules.md')).toBe(source.replace('원문  ', '대안 😀  '));
  const file = join(p.root, 'plans/review/A.yaml'); await writeFile(file, '# keep comment\n' + await readFile(file, 'utf8'));
  p = await loadProject(p.root); const bytes = await readFile(file);
  const unchanged = await writeVariant(p.root, p.revision, 'review', 'A', { documents: { [path]: '대안 😀  ' } });
  expect(unchanged.changed).toEqual([]); expect(await readFile(file)).toEqual(bytes);
  const current = source.replace('원문  ', '현재 원문').replace('끝  ', '바깥 새 값  ');
  await writeFile(join(p.root, 'documents/rules.md'), current); p = await loadProject(p.root);
  const view = getPlan(p, 'review'); expect(view.diagnostics.filter(d => d.code === 'BASE_CHANGED')).toHaveLength(2);
  expect(view.variants.A!.document_base_values![path]).toBe('원문  ');
  expect(view.comparison[0]).toMatchObject({ kind: 'document', baseline: { value: '현재 원문' }, alternatives: { A: { value: '대안 😀  ' } } });
  p = (await approvePlan(p.root, p.revision, 'review', 'A')).project;
  expect(await readFile(join(p.root, 'documents/rules.md'), 'utf8')).toBe(current.replace('현재 원문', '대안 😀  '));
  expect(p.sources.has('plans/review/B.yaml')).toBe(true); expect(validateProject(p)).toEqual([]);
});
it('rejects overlap, missing scope, section escape, swallowed outside blocks and scope renaming', async () => {
  const p = await fixture();
  for (const documents of [
    { rules: source, 'rules/前 😀/note': 'x' }, { 'rules/missing': 'x' },
    { 'rules/前 😀/선택': '## 선택\n\n# 탈출' }, { 'rules/前 😀/선택': '## 선택\n\n```' },
    { 'rules/前 😀/선택': '## 바꿈' }, { 'rules/前 😀/note': 'x\n\ny' },
  ]) await expect(writeVariant(p.root, p.revision, 'review', 'A', { documents })).rejects.toBeDefined();
});
it('saves snapshots and CLI block edits at a target; untouched save and stale writes preserve bytes', async () => {
  let p = await fixture(); const path = 'rules/前 😀/선택';
  p = (await writeVariant(p.root, p.revision, 'review', 'A', { documents: { [path]: documentScope(p, path).markdown } })).project;
  const view = getTargetDocumentView(p, 'rules', 'review/A');
  const blocks = view.blocks.map(b => ({ original: b.index }));
  expect((await saveTargetDocumentSnapshots(p.root, p.revision, [{ name: 'rules', target: 'review/A', blocks }])).changed).toEqual([]);
  const index = view.blocks.find(b => b.markdown === '내용')!.index;
  p = (await editVariantDocument(p.root, p.revision, 'rules', 'review/A', [{ op: 'replace', block: index, markdown: '수정' }])).project;
  expect(p.sources.get('documents/rules.md')).toBe(source);
  await expect(saveTargetDocumentSnapshots(p.root, view.revision, [{ name: 'rules', target: 'review/A', blocks }])).rejects.toMatchObject({ code: 'STALE_REVISION' });
  await expect(editVariantDocument(p.root, p.revision, 'rules', 'review/A', [{ op: 'replace', block: 0, markdown: '# 바깥 변경' }])).rejects.toBeDefined();
});
it('renames scope addresses, Markdown links and captured headings while keeping provenance', async () => {
  let p = await fixture(); const path = 'rules/前 😀/선택';
  p = (await writeVariant(p.root, p.revision, 'review', 'A', { documents: { [path]: '## 선택\n\n[값](offers/bundle/price)' }, sources: [{ raw: '선택' }] })).project;
  expect((await whereUsed(p, path)).references.some(x => x.file === 'plans/review/A.yaml')).toBe(true);
  expect((await whereUsed(p, 'offers/bundle/price')).references.some(x => x.file === 'plans/review/A.yaml')).toBe(true);
  p = (await renameResource(p.root, p.revision, 'heading', path, '새제목')).project;
  expect(getPlan(p, 'review').variants.A).toMatchObject({ documents: { 'rules/前 😀/새제목': '## 새제목\n\n[값](offers/bundle/price)' }, sources: [{ raw: '선택' }] });
  p = (await renameResource(p.root, p.revision, 'key', 'offers/bundle', 'box')).project;
  expect(getPlan(p, 'review').variants.A!.documents!['rules/前 😀/새제목']).toContain('offers/box/price');
  expect(validateProject(p)).toEqual([]);
});
it('whole-document replacement keeps BOM/prefix/suffix and composes exact table references in the same alternative', async () => {
  let p = await fixture();
  const scope = documentScope(p, 'rules');
  p = (await writeVariant(p.root, p.revision, 'review', 'A', { documents: { rules: scope.markdown.replace('내용', '[price](offers/bundle/price)') }, set: { 'offers/bundle/price': '12.5000' } })).project;
  const view = getTargetDocumentView(p, 'rules', 'review/A');
  expect(view.source).toBe(source.replace('내용', '[price](offers/bundle/price)'));
  expect(view.links.find(link => link.path === 'offers/bundle/price')?.value).toBe('12.5000');
  expect(validateProject(p)).toEqual([]);
  p = (await approvePlan(p.root, p.revision, 'review', 'A')).project;
  expect(p.sources.get('documents/rules.md')).toBe(source.replace('내용', '[price](offers/bundle/price)'));
});
it('captures new selected scopes while keeping every other snapshot byte and accepts native insertions within a section', async () => {
  let p = await fixture(); p = (await writeVariant(p.root, p.revision, 'review', 'A', {})).project;
  const path = 'rules/前 😀/선택'; const view = getTargetDocumentView(p, 'rules', 'review/A', [path]);
  const index = view.blocks.find(b => b.markdown === '내용')!.index;
  const blocks = view.blocks.flatMap<DocumentSnapshotBlock>(b => b.index === index ? [{ original: b.index, markdown: '- first\n- second' }, { markdown: '> note' }] : [{ original: b.index }]);
  p = (await saveTargetDocumentSnapshots(p.root, p.revision, [{ name: 'rules', target: 'review/A', scopes: [path], blocks }])).project;
  expect(p.sources.get('documents/rules.md')).toBe(source);
  const changed = getTargetDocumentView(p, 'rules', 'review/A');
  expect(changed.source).toContain('- first\n- second'); expect(changed.source).toContain('> note');
  expect(changed.source.slice(changed.source.indexOf('# 바깥'))).toBe(source.slice(source.indexOf('# 바깥')));
});
it('compares composed scope values when alternatives choose different nested scopes', async () => {
  let p = await fixture(); const section = 'rules/前 😀', paragraph = section + '/note';
  p = (await writeVariant(p.root, p.revision, 'review', 'A', { documents: { [section]: documentScope(p, section).markdown.replace('내용', 'section A') } })).project;
  p = (await writeVariant(p.root, p.revision, 'review', 'B', { documents: { [paragraph]: 'paragraph B' } })).project;
  const rows = getPlan(p, 'review').comparison;
  expect(rows.find(row => row.path === section)?.alternatives.B?.value).toBe(documentScope(readVariant(p, 'review', 'B'), section).markdown);
  expect(rows.find(row => row.path === paragraph)?.alternatives.A?.value).toBe(documentScope(readVariant(p, 'review', 'A'), paragraph).markdown);
});
