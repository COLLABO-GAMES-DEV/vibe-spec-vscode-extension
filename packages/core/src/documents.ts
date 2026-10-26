import { newFolderMarkers } from './folder-names.js';
import { pathParts, pathFromParts, canonicalPath } from './paths.js';
import { renamePlanReferences } from './plan-references.js';
import { resourceEntries, resourceEntry, resourceFile, resourcePath } from './resources.js';
import type { Heading } from 'mdast';
import type { Diagnostic, MutationOptions, Project, WriteResult } from './types.js';
import { isRecord, VibeError } from './types.js';
import type { DocumentBlock, DocumentOperation, DocumentSnapshot, DocumentSummary, DocumentView, ParsedDocument } from './document-types.js';
import { markdownTree, nameComment, nodeEnd, nodeStart, parseMarkdown } from './document-parser.js';
import { documentPathMatches, documentSources, documentUsages, renameDocumentLinks, rewriteDocumentPaths } from './document-references.js';
import { mutateProject, projectWithChanges, readPath } from './project.js';
import { compareResourceNames, resourceNameError, resourceNameKey, suggestResourceName } from './names.js';
import { textCandidates } from './usage.js';
import { checkMarkdownSource as checkSource, composeDocumentSnapshot } from './document-snapshot.js';

function fileOf(project: Project, name: string): string {
  const file = resourceFile(project, 'document', name);
  if (!file) throw new VibeError('PATH_NOT_FOUND', 'Unknown or ambiguous document: ' + name);
  return file;
}
function parseDocument(name: string, source: string, file: string): ParsedDocument {
  const parsed = parseMarkdown(name, source);
  return { ...parsed, diagnostics: parsed.diagnostics.map(item => ({ ...item, file })) };
}
function document(project: Project, name: string): ParsedDocument {
  if (typeof name !== 'string' || !name || name.includes('/')) throw new VibeError('PATH_INVALID', 'Expected a document name.');
  const source = project.sources.get(fileOf(project, name));
  if (source === undefined) throw new VibeError('PATH_NOT_FOUND', 'Unknown document: ' + name);
  return parseDocument(name, source, fileOf(project, name));
}
function addressable(parsed: ParsedDocument, path: string): boolean {
  const ancestors = pathParts(path).map((_, i, parts) => pathFromParts(parts.slice(0, i + 1)));
  return !parsed.diagnostics.some(item =>
    ['DOCUMENT_PATH_DUPLICATE', 'DOCUMENT_NAME_INVALID'].includes(item.code) && ancestors.includes(item.path));
}
function namedBlock(parsed: ParsedDocument, path: string): DocumentBlock {
  const found = parsed.blocks.filter(block => block.path === path);
  if (found.length !== 1 || !addressable(parsed, path)) {
    throw new VibeError('PATH_NOT_FOUND', 'Document path is missing or ambiguous: ' + path);
  }
  return found[0]!;
}

/** Reading a section does not resolve its links, including self/cyclic links. */
export function readDocumentPath(project: Project, path: string): unknown {
  path = canonicalPath(path);
  if (typeof path !== 'string' || pathParts(path).some(part => !part)) throw new VibeError('PATH_INVALID', 'Invalid document path.');
  const name = pathParts(path)[0]!, parsed = document(project, name);
  if (path === name) return parsed.source;
  const block = namedBlock(parsed, path);
  const tree = markdownTree(parsed.source);
  const heading = tree.children.find(node => node.type === 'heading' && nodeStart(node) === block.start);
  if (heading?.type !== 'heading') return block.markdown;
  const next = tree.children.find(node => node.type === 'heading' && nodeStart(node) > block.start && node.depth <= heading.depth &&
    parsed.blocks.some(item => item.start === nodeStart(node)));
  return parsed.source.slice(block.start, next ? nodeStart(next) : parsed.source.length);
}

function resolvedDocument(project: Project, parsed: ParsedDocument, file: string): ParsedDocument {
  const diagnostics = [...parsed.diagnostics];
  const links = parsed.links.map(link => {
    if (link.kind === 'external') return { ...link, resolved: true };
    const issue = (code: string, message: string, warning = false) => diagnostics.push({ code,
      file, path: parsed.blocks[link.block]?.path ?? parsed.name, message,
      target: link.path ?? link.destination, ...(warning ? { severity: 'warning' as const } : {}) });
    if (link.kind === 'image') {
      if (link.path === undefined) {
        issue('DOCUMENT_IMAGE_EXTERNAL', 'External images are not loaded automatically.', true);
        return { ...link, resolved: false };
      }
      if (!/^assets\/[^/\\?#\u0000-\u001f]+$/.test(link.path) || ['.', '..'].includes(link.path.slice(7))) {
        issue('DOCUMENT_IMAGE_PATH', 'Local images must use a file inside documents/assets/.');
        return { ...link, resolved: false };
      }
      const resolved = project.assets?.has('documents/' + link.path) ?? false;
      if (!resolved) issue('DOCUMENT_IMAGE_MISSING', 'Unknown local image: ' + link.path);
      return { ...link, resolved };
    }
    try {
      const value = readPath(project, link.path!);
      return { ...link, resolved: true, value: isRecord(value) && Object.hasOwn(value, 'value') ? value.value : value };
    } catch (error) {
      if (!(error instanceof VibeError)) throw error;
      issue('DOCUMENT_LINK_MISSING', 'Cannot resolve document link: ' + link.destination + '. ' + error.message);
      return { ...link, resolved: false };
    }
  });
  return { ...parsed, diagnostics, links };
}

export function getDocumentView(project: Project, name: string): DocumentView {
  const parsed = resolvedDocument(project, document(project, name), fileOf(project, name));
  return { ...parsed, revision: project.revision,
    diagnostics: [...project.diagnostics.filter(item => item.file === fileOf(project, name)), ...parsed.diagnostics] };
}

export function listDocuments(project: Project): DocumentSummary[] {
  return documentSources(project).map(([name, file, source]) => {
    const parsed = resolvedDocument(project, parseDocument(name, source, file), file);
    const diagnostics = [...project.diagnostics.filter(item => item.file === file), ...parsed.diagnostics];
    return { name, errors: diagnostics.filter(item => item.severity !== 'warning').length,
      warnings: diagnostics.filter(item => item.severity === 'warning').length };
  }).sort((a, b) => compareResourceNames(a.name, b.name));
}

export function documentDiagnostics(project: Project): Diagnostic[] {
  return documentSources(project).flatMap(([name, file, source]) => resolvedDocument(project, parseDocument(name, source, file), file).diagnostics);
}

function checkName(project: Project, name: string, from?: string): void {
  if (typeof name !== 'string') throw new VibeError('NAME_INVALID', 'Document name must be a string.');
  const error = resourceNameError(name);
  if (error) throw new VibeError('NAME_INVALID', error + ' Suggested name: ' + suggestResourceName(name));
  const fromFile = from === undefined ? undefined : fileOf(project, from);
  const occupied = resourceEntries(project).filter(entry => entry.kind !== 'schema' && entry.file !== fromFile)
    .map(entry => entry.name);
  if (occupied.some(other => resourceNameKey(other) === resourceNameKey(name))) {
    throw new VibeError('NAME_EXISTS', 'A document or table already uses this name. Suggested name: ' + suggestResourceName(name, occupied));
  }
  if (from !== undefined && from !== name && resourceNameKey(from) === resourceNameKey(name)) {
    throw new VibeError('CASE_ONLY_RENAME', 'Rename to a different intermediate name before changing only case or Unicode normalization.');
  }
}

export async function createDocument(
  root: string, revision: string, name: string, source: string, options: MutationOptions & { folder?: string } = {},
): Promise<WriteResult> {
  checkSource(source);
  return mutateProject(root, revision, before => {
    checkName(before, name);
    return new Map([...newFolderMarkers(before, options.folder ?? ''), [resourcePath('document', name, options.folder, before), source]]);
  }, options);
}

interface Splice { start: number; end: number; text: string }
function spliceSource(source: string, edits: Splice[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}
function withSource(project: Project, name: string, source: string): Project {
  return { ...project, sources: new Map(project.sources).set(fileOf(project, name), source) };
}
function headingAt(parsed: ParsedDocument, block: DocumentBlock): Heading | undefined {
  return markdownTree(parsed.source).children.find((node): node is Heading => node.type === 'heading' && nodeStart(node) === block.start);
}
function checkSegment(to: string, kind: 'heading' | 'tag'): void {
  if (typeof to !== 'string' || !to.trim() || /[\r\n\u0000]/.test(to) || to.trim() !== to || kind === 'tag' && to.includes('-->')) {
    throw new VibeError('NAME_INVALID', 'Heading and tag names must be nonempty, have no surrounding whitespace or line breaks.');
  }
  checkSource(to);
}
function assertFreePath(parsed: ParsedDocument, oldPath: string, nextPath: string): void {
  if (nextPath !== oldPath && parsed.blocks.some(block => block.path === nextPath)) {
    throw new VibeError('NAME_EXISTS', 'A heading or tag already uses this path: ' + nextPath);
  }
}
export function headingNameEdit(source: string, heading: Heading, to: string): Splice {
  const text = to.replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, '\\$&');
  if (heading.children.length === 1) {
    let leaf = heading.children[0]!;
    while ('children' in leaf && leaf.children.length === 1) leaf = leaf.children[0]!;
    if (leaf.type === 'text') return { start: nodeStart(leaf), end: nodeEnd(leaf), text };
    if (leaf.type === 'inlineCode' && !to.includes('`')) {
      const fence = /^`+/.exec(source.slice(nodeStart(leaf)))![0].length;
      return { start: nodeStart(leaf) + fence, end: nodeEnd(leaf) - fence, text: to };
    }
  }
  // A composite displayed name has no single text span; only its heading content is replaced.
  return { start: nodeStart(heading.children[0]!), end: nodeEnd(heading.children.at(-1)!), text };
}

interface DocumentRename { path: string; to: string; kind: 'heading' | 'tag' }

/** The same conservative heading/tag rename inference serves both write APIs. */
function replacementRename(parsed: ParsedDocument, block: DocumentBlock, markdown: string): DocumentRename | undefined {
  if (!block.path || !addressable(parsed, block.path) || markdown === block.markdown) return;
  const next = parseMarkdown(parsed.name, markdown), nextBlock = next.blocks[0];
  const oldHeading = headingAt(parsed, block), newHeading = nextBlock && headingAt(next, nextBlock);
  if (next.blocks.length === 1 && nextBlock?.path && addressable(next, nextBlock.path) &&
      (oldHeading && newHeading && oldHeading.depth === newHeading.depth ||
       !oldHeading && !newHeading && nameComment.test(markdown.split(/\r\n|\r|\n/)[0]!))) {
    const to = pathParts(nextBlock.path).at(-1)!;
    checkSegment(to, oldHeading ? 'heading' : 'tag');
    const nextPath = pathFromParts([...pathParts(block.path).slice(0, -1), to]);
    assertFreePath(parsed, block.path, nextPath);
    if (nextPath !== block.path) return { path: block.path, to, kind: oldHeading ? 'heading' : 'tag' };
  }
}

function documentRenamePath(renamed: DocumentRename[]): (path: string) => string {
  return path => {
    const parts = pathParts(path);
    for (const rename of renamed) if (documentPathMatches(path, rename.path)) parts[pathParts(rename.path).length - 1] = rename.to;
    return pathFromParts(parts);
  };
}

function checkBlockBoundary(next: ParsedDocument, block: DocumentBlock, start: number, end: number): void {
  if (!next.blocks.some(item => item.start === start && item.end === end && item.markdown === block.markdown)) {
    throw new VibeError('DOCUMENT_BOUNDARY', 'This edit would absorb or change the boundary of another block. Add a separator or close the Markdown construct.');
  }
}

function checkReferencedStructure(
  references: Project, parsed: ParsedDocument, next: ParsedDocument, removed: Set<number>, renamePath: (path: string) => string,
): void {
  // Explicit deletion is allowed and is reported by ordinary link validation.
  for (const block of parsed.blocks) {
    if (!block.path || !addressable(parsed, block.path) || removed.has(block.index)) continue;
    const expected = renamePath(block.path);
    if (!next.blocks.some(item => item.path === expected) && documentUsages(references, block.path).references.length) {
      throw new VibeError('RENAME_REQUIRED', 'Use an explicit heading/tag rename before changing referenced document structure: ' + block.path);
    }
  }
}

/** Apply every document draft at one revision, then rewrite links in the composed sources. */
export async function saveDocumentSnapshots(
  root: string, revision: string, snapshots: DocumentSnapshot[], options: MutationOptions = {},
): Promise<WriteResult> {
  if (!Array.isArray(snapshots)) throw new VibeError('INVALID_ARGUMENT', 'Expected an array of document snapshots.');
  return mutateProject(root, revision, before => {
    return prepareDocumentSnapshots(before, snapshots);
  }, options);
}

export function prepareDocumentSnapshots(before: Project, snapshots: DocumentSnapshot[]): Map<string, string> {
  const changes = new Map<string, string>(), seen = new Set<string>(), renamed: DocumentRename[] = [];
  const prepared: { parsed: ParsedDocument; next: ParsedDocument; removed: Set<number> }[] = [];
  for (const snapshot of snapshots) {
    if (!isRecord(snapshot) || typeof snapshot.name !== 'string' || !Array.isArray(snapshot.blocks) ||
        Object.keys(snapshot).some(key => !['name', 'blocks'].includes(key))) {
      throw new VibeError('INVALID_ARGUMENT', 'Expected a document name and snapshot blocks.');
    }
    const parsed = document(before, snapshot.name), file = fileOf(before, snapshot.name);
    if (seen.has(file)) throw new VibeError('EDIT_OVERLAP', 'A document can appear only once in a snapshot batch.');
    seen.add(file);
    const { source, unchanged, removed } = composeDocumentSnapshot(parsed, snapshot.blocks);
    if (source === parsed.source) continue;
    const next = parseMarkdown(parsed.name, source);
    for (const { block, start, end } of unchanged) checkBlockBoundary(next, block, start, end);
    for (const block of snapshot.blocks) {
      if (block.original === undefined || block.markdown === undefined) continue;
      const rename = replacementRename(parsed, parsed.blocks[block.original]!, block.markdown);
      if (rename) renamed.push(rename);
    }
    changes.set(file, source);
    prepared.push({ parsed, next, removed });
  }
  const composed = { ...before, sources: new Map([...before.sources, ...changes]) };
  const renamePath = documentRenamePath(renamed);
  for (const { parsed, next, removed } of prepared) {
    checkReferencedStructure(composed, parsed, next, removed, renamePath);
  }
  if (renamed.length) {
    for (const [file, source] of rewriteDocumentPaths(composed, renamePath)) changes.set(file, source);
  }
  for (const rename of renamed) {
    for (const [file, value] of renamePlanReferences(projectWithChanges(before, changes), rename.kind, rename.path, rename.to)) changes.set(file, value);
  }
  return changes;
}

export async function editDocument(
  root: string, revision: string, name: string, operations: DocumentOperation[], options: MutationOptions = {},
): Promise<WriteResult> {
  if (!Array.isArray(operations)) throw new VibeError('INVALID_OPERATIONS', 'Expected an array of document operations.');
  return mutateProject(root, revision, before => {
    const parsed = document(before, name), edits: Splice[] = [];
    const renamed: DocumentRename[] = [];
    const removed = new Set<number>(), replaced = new Set<number>(), changedBlocks = new Set<number>();
    for (const operation of operations) {
      if (!isRecord(operation) || !['insert', 'replace', 'delete'].includes(String(operation.op))) {
        throw new VibeError('INVALID_OPERATIONS', 'Unknown document operation.');
      }
      const allowed = operation.op === 'insert' ? ['op', 'before', 'markdown'] : operation.op === 'replace' ? ['op', 'block', 'markdown'] : ['op', 'block'];
      if (Object.keys(operation).some(key => !allowed.includes(key))) throw new VibeError('INVALID_OPERATIONS', 'Unexpected operation field.');
      if (operation.op !== 'delete') checkSource(operation.markdown);
      if (operation.op === 'insert') {
        if (!Number.isInteger(operation.before) || operation.before < 0 || operation.before > parsed.blocks.length) {
          throw new VibeError('PATH_NOT_FOUND', 'Insertion index is outside this document revision.');
        }
        if (!parseMarkdown(name, operation.markdown).blocks.length) throw new VibeError('INVALID_OPERATIONS', 'An inserted block cannot be empty.');
        const next = parsed.blocks[operation.before];
        let start = next?.start ?? parsed.blocks.at(-1)?.end ?? (parsed.source.startsWith('\uFEFF') ? 1 : 0);
        if (next) {
          const lineStart = Math.max(parsed.source.lastIndexOf('\n', start - 1), parsed.source.lastIndexOf('\r', start - 1)) + 1;
          const prefixStart = lineStart === 0 && parsed.source.startsWith('\uFEFF') ? 1 : lineStart;
          if (/^[ \t]*$/.test(parsed.source.slice(prefixStart, start))) start = prefixStart;
        }
        const text = next ? operation.markdown + '\n\n' : (parsed.blocks.length ? '\n\n' : '') + operation.markdown;
        edits.push({ start, end: start, text });
        continue;
      }
      if (!Number.isInteger(operation.block) || !parsed.blocks[operation.block]) {
        throw new VibeError('PATH_NOT_FOUND', 'Block index is outside this document revision.');
      }
      if (replaced.has(operation.block) || removed.has(operation.block)) throw new VibeError('EDIT_OVERLAP', 'A block cannot be edited twice in one revision.');
      const block = parsed.blocks[operation.block]!;
      if (operation.op === 'delete') {
        removed.add(block.index);
        edits.push({ start: block.start, end: block.end, text: '' });
      } else {
        replaced.add(block.index);
        if (operation.markdown === block.markdown) continue;
        changedBlocks.add(block.index);
        edits.push({ start: block.start, end: block.end, text: operation.markdown });
        const rename = replacementRename(parsed, block, operation.markdown);
        if (rename) renamed.push(rename);
      }
    }
    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]!, current = sorted[i]!;
      if (current.start < previous.end || current.start === previous.start && current.end === previous.end) {
        throw new VibeError('EDIT_OVERLAP', 'Document operations overlap.');
      }
    }
    const source = spliceSource(parsed.source, edits);
    if (source === parsed.source) return new Map<string, string>();
    const renamePath = documentRenamePath(renamed);
    const next = parseMarkdown(name, source);
    for (const block of parsed.blocks) {
      if (removed.has(block.index) || changedBlocks.has(block.index)) continue;
      const offset = (position: number, end = false) => position + edits.reduce((delta, edit) =>
        delta + (edit.end <= position && !(end && edit.start === edit.end && edit.start === position)
          ? edit.text.length - (edit.end - edit.start) : 0), 0);
      checkBlockBoundary(next, block, offset(block.start), offset(block.end, true));
    }
    checkReferencedStructure(before, parsed, next, removed, renamePath);
    const changes = new Map<string, string>([[fileOf(before, name), source]]);
    if (renamed.length) {
      for (const [file, value] of rewriteDocumentPaths(withSource(before, name, source), renamePath)) changes.set(file, value);
    }
    for (const rename of renamed) {
      for (const [file, value] of renamePlanReferences(projectWithChanges(before, changes), rename.kind, rename.path, rename.to)) changes.set(file, value);
    }
    return changes;
  }, options);
}

export async function deleteDocument(
  root: string, revision: string, name: string, options: MutationOptions = {},
): Promise<WriteResult> {
  return mutateProject(root, revision, before => {
    document(before, name);
    return new Map([[fileOf(before, name), null]]);
  }, options);
}

export async function renameDocument(
  root: string, revision: string, kind: 'document' | 'heading' | 'tag', path: string, to: string, options: MutationOptions = {},
): Promise<WriteResult> {
  if (!['document', 'heading', 'tag'].includes(kind) || typeof path !== 'string' || typeof to !== 'string') {
    throw new VibeError('INVALID_ARGUMENT', 'Expected document, heading or tag rename.');
  }
  path = canonicalPath(path);
  let candidates: WriteResult['candidates'] = [];
  const result = await mutateProject(root, revision, async before => {
    const name = pathParts(path)[0]!, parsed = document(before, name);
    const changes = new Map<string, string | null>();
    if (kind === 'document') {
      if (path !== name) throw new VibeError('PATH_INVALID', 'Document rename expects a document name.');
      if (to === name) return changes;
      checkName(before, to, name);
      candidates = await textCandidates(before, name);
      for (const [file, source] of renameDocumentLinks(before, kind, path, to)) changes.set(file, source);
      for (const [file, source] of renamePlanReferences(before, kind, path, to)) changes.set(file, source);
      const renamedSource = changes.get(fileOf(before, name)) ?? parsed.source;
      changes.delete(fileOf(before, name));
      changes.set(resourcePath('document', to, resourceEntry(fileOf(before, name))!.folder), renamedSource);
      changes.set(fileOf(before, name), null);
      return changes;
    }
    checkSegment(to, kind);
    const block = namedBlock(parsed, path), heading = headingAt(parsed, block);
    if (kind === 'heading' ? !heading : !!heading || !nameComment.test(block.markdown.split(/\r\n|\r|\n/)[0]!)) {
      throw new VibeError('PATH_INVALID', 'The path does not identify a ' + kind + '.');
    }
    if (pathParts(path).at(-1) === to) return changes;
    const nextPath = pathFromParts([...pathParts(path).slice(0, -1), to]);
    assertFreePath(parsed, path, nextPath);
    let edit: Splice;
    if (heading) {
      edit = headingNameEdit(parsed.source, heading, to);
    } else {
      const comment = block.markdown.split(/\r\n|\r|\n/)[0]!;
      const prefix = /^<!--[ \t]*name:[ \t]*/.exec(comment)![0];
      const old = nameComment.exec(comment)![1]!;
      edit = { start: block.start + prefix.length, end: block.start + prefix.length + old.length, text: to };
    }
    candidates = await textCandidates(before, pathParts(path).at(-1)!);
    const source = spliceSource(parsed.source, [edit]);
    changes.set(fileOf(before, name), source);
    for (const [file, value] of renameDocumentLinks(withSource(before, name, source), kind, path, to)) changes.set(file, value);
    for (const [file, value] of renamePlanReferences(before, kind, path, to)) changes.set(file, value);
    return changes;
  }, options);
  return { ...result, candidates };
}
