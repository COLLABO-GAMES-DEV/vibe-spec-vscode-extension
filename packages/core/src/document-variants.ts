import type { Project } from './types.js';
import { VibeError } from './types.js';
import { resourceFile } from './resources.js';
import { markdownTree, nodeStart, parseMarkdown } from './document-parser.js';
import { checkMarkdownSource } from './document-snapshot.js';

export interface DocumentScope {
  path: string; name: string; file: string; kind: 'document' | 'section' | 'paragraph';
  start: number; end: number; markdown: string;
}
/** Offsets are ephemeral, at the caller's revision. Only public paths are persisted. */
export function documentScope(project: Project, path: string): DocumentScope {
  const parts = path.split('/'), name = parts[0]!;
  if (parts.some(part => !part || part === '*')) throw new VibeError('PATH_INVALID', 'Expected a document, heading or named paragraph path.');
  const file = resourceFile(project, 'document', name), source = file && project.sources.get(file);
  if (!file || source === undefined) throw new VibeError('PATH_NOT_FOUND', 'Unknown document: ' + name);
  const parsed = parseMarkdown(name, source);
  // A whole document includes its whitespace body, even when it has no blocks.
  // The BOM is a file prefix, never part of an alternative's Markdown payload.
  let start = source.startsWith('\uFEFF') ? 1 : 0;
  let end = source.length;
  let kind: DocumentScope['kind'] = 'document';
  if (parts.length > 1) {
    const blocks = parsed.blocks.filter(block => block.path === path);
    if (blocks.length !== 1 || parsed.diagnostics.some(d => ['DOCUMENT_PATH_DUPLICATE', 'DOCUMENT_NAME_INVALID'].includes(d.code)
      && (path === d.path || path.startsWith(d.path + '/')))) throw new VibeError('PATH_NOT_FOUND', 'Missing or ambiguous document scope: ' + path);
    const block = blocks[0]!;
    start = block.start; end = block.end;
    if (block.kind === 'heading') {
      kind = 'section';
      const headings = markdownTree(source).children.filter(node => node.type === 'heading');
      const heading = headings.find(node => nodeStart(node) === start)!;
      const next = headings.find(node => nodeStart(node) > start && node.depth <= heading.depth);
      end = parsed.blocks.filter(item => item.start >= start && (!next || item.start < nodeStart(next))).at(-1)!.end;
    } else if (block.kind === 'paragraph') {
      kind = 'paragraph';
      const prefix = /^<!--[ \t]*name:[^\r\n]*-->(?:\r\n|\r|\n)[ \t]*/.exec(block.markdown)?.[0];
      if (!prefix) throw new VibeError('DOCUMENT_SCOPE', 'Expected a named paragraph.');
      start += prefix.length;
    }
    else throw new VibeError('DOCUMENT_SCOPE', 'Choose a named paragraph, section or whole document.');
  }
  return { path, name, file, kind, start, end, markdown: source.slice(start, end) };
}
export function documentScopes(project: Project, name: string): DocumentScope[] {
  const root = documentScope(project, name), source = project.sources.get(root.file)!;
  const paths = [name, ...parseMarkdown(name, source).blocks.flatMap(block => block.path ? [block.path] : [])];
  return paths.flatMap(path => { try { return [documentScope(project, path)]; } catch { return []; } });
}

/** Splice only chosen scopes; never reinterpret the original bytes outside them. */
export function documentVariantChanges(project: Project, replacements: Record<string, string> = {}): Map<string, string> {
  const groups = new Map<string, { scope: DocumentScope; markdown: string }[]>();
  for (const [path, markdown] of Object.entries(replacements)) {
    checkMarkdownSource(markdown);
    const scope = documentScope(project, path), entries = groups.get(scope.file) ?? [];
    if (entries.some(entry => scope.path.startsWith(entry.scope.path + '/') || entry.scope.path.startsWith(scope.path + '/')
      || scope.start < entry.scope.end && entry.scope.start < scope.end)) throw new VibeError('EDIT_OVERLAP', 'Document variant scopes overlap: ' + path);
    entries.push({ scope, markdown }); groups.set(scope.file, entries);
  }
  const changes = new Map<string, string>();
  for (const [file, entries] of groups) {
    const source = project.sources.get(file)!;
    let next = source;
    for (const { scope, markdown } of [...entries].sort((a, b) => b.scope.start - a.scope.start)) {
      next = next.slice(0, scope.start) + markdown + next.slice(scope.end);
    }
    const name = entries[0]!.scope.name, before = parseMarkdown(name, source), after = parseMarkdown(name, next);
    for (const block of before.blocks) {
      if (entries.some(({ scope }) => block.start >= scope.start && block.end <= scope.end || scope.kind === 'paragraph' && block.path === scope.path)) continue;
      const shift = entries.filter(({ scope }) => scope.end <= block.start).reduce((n, { scope, markdown }) => n + markdown.length - (scope.end - scope.start), 0);
      if (!after.blocks.some(b => b.start === block.start + shift && b.end === block.end + shift && b.markdown === block.markdown && b.path === block.path)) {
        throw new VibeError('DOCUMENT_BOUNDARY', 'The replacement changes a block outside the chosen scope. Close Markdown constructs and preserve the scope heading.');
      }
    }
    for (const { scope, markdown } of entries) {
      if (scope.kind === 'document') continue;
      const shift = entries.filter(e => e.scope.end <= scope.start).reduce((n, e) => n + e.markdown.length - (e.scope.end - e.scope.start), 0);
      const start = scope.start + shift;
      const anchorStart = (before.blocks.find(b => b.path === scope.path)?.start ?? scope.start) + shift;
      const anchor = after.blocks.filter(b => b.path === scope.path);
      if (anchor.length !== 1 || anchor[0]!.start !== anchorStart || anchor[0]!.kind !== (scope.kind === 'section' ? 'heading' : 'paragraph')) {
        throw new VibeError('DOCUMENT_SCOPE', 'Keep the chosen heading or paragraph name. Use baseline rename for address changes.');
      }
      if (scope.kind === 'paragraph' && (after.blocks.filter(b => b.start >= anchorStart && b.start < start + markdown.length).length !== 1)) {
        throw new VibeError('DOCUMENT_SCOPE', 'A named paragraph replacement must remain one paragraph.');
      }
      if (scope.kind === 'section') {
        const headings = markdownTree(next).children.filter(n => n.type === 'heading');
        const original = markdownTree(source).children.find(n => n.type === 'heading' && nodeStart(n) === scope.start);
        const first = headings.find(n => nodeStart(n) === start);
        if (original?.type !== 'heading' || !first || first.depth !== original.depth || headings.some(n => nodeStart(n) > start && nodeStart(n) < start + markdown.length && n.depth <= first.depth)) {
          throw new VibeError('DOCUMENT_SCOPE', 'The replacement must stay inside the selected section.');
        }
      }
    }
    if (next !== source) changes.set(file, next);
  }
  return changes;
}
