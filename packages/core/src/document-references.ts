import { resourceEntries, resourceFile } from './resources.js';
import { toString } from 'mdast-util-to-string';
import type { Project, RenameKind, Usage, Usages } from './types.js';
import { tableContexts } from './validation.js';
import { decodeDestination, markdownTree, parseMarkdown } from './document-parser.js';

export function documentSources(project: Project): [string, string, string][] {
  return resourceEntries(project, 'document').map(({ name, file }) =>
    [name, file, project.sources.get(file)!] as [string, string, string]
  ).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

export function documentPathMatches(destination: string, target: string, wildcard = false): boolean {
  const parts = destination.split('/'), wanted = target.split('/');
  return parts.length >= wanted.length && wanted.every((part, index) => part === parts[index] || wildcard && index === 1 && part === '*');
}

export function documentUsages(project: Project, path: string): Usages {
  const result: Usages = { references: [], candidates: [] };
  const needle = path.split('/').at(-1)!;
  const wildcard = resourceFile(project, 'table', path.split('/')[0]!) !== undefined;
  for (const [name, file, source] of documentSources(project)) {
    const document = parseMarkdown(name, source);
    function add(list: Usage[], offset: number, location = name): void {
      const line = source.slice(0, offset).split(/\r\n|\r|\n/).length;
      if (!list.some(item => item.file === file && item.line === line && item.path === location)) {
        list.push({ file, path: location, line, text: source.split(/\r\n|\r|\n/)[line - 1] ?? '' });
      }
    }
    for (const link of document.links) {
      if (link.kind === 'resource' && link.path !== undefined && documentPathMatches(link.path, path, wildcard)) {
        add(result.references, link.start, document.blocks[link.block]?.path ?? name);
      }
    }
    if (!needle) continue;
    for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + needle.length)) {
      if (!document.links.some(link => at < link.end && at + needle.length > link.start)) add(result.candidates, at);
    }
  }
  return result;
}

/** Raw ranges of decoded path segments, including escaped/entity/percent-encoded separators. */
function destinationSegments(raw: string): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  const tokens = /\\[!-/:-@\[-`{-~]|&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);|%[\da-fA-F]{2}|[\s\S]/g;
  let start = 0;
  for (const token of raw.matchAll(tokens)) {
    let decoded = token[0];
    if (decoded.startsWith('\\')) decoded = decoded.slice(1);
    else if (decoded.startsWith('&')) decoded = toString(markdownTree(decoded));
    decoded = decodeDestination(decoded);
    if (decoded !== '/') continue;
    result.push({ start, end: token.index });
    start = token.index + token[0].length;
  }
  result.push({ start, end: raw.length });
  return result;
}

function encodeSegment(value: string, angle: boolean): string {
  return value.replace(/[\s\\<>()[\]"'`&%#?]/g, char => {
    if (char === ' ' && angle) return char;
    const encoded = encodeURIComponent(char);
    return encoded === char ? '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0') : encoded;
  });
}

/** Apply a simultaneous path mapping, preserving every unchanged destination segment. */
export function rewriteDocumentPaths(project: Project, rename: (path: string) => string): Map<string, string> {
  const changes = new Map<string, string>();
  for (const [name, file, source] of documentSources(project)) {
    const edits = new Map<string, { start: number; end: number; text: string }>();
    for (const link of parseMarkdown(name, source).links) {
      if (link.kind !== 'resource' || link.path === undefined) continue;
      const next = rename(link.path);
      if (next === link.path) continue;
      const oldParts = link.path.split('/'), newParts = next.split('/');
      const raw = source.slice(link.start, link.end), ranges = destinationSegments(raw);
      const angle = source[link.start - 1] === '<';
      if (oldParts.length !== newParts.length || ranges.length !== oldParts.length) {
        edits.set(link.start + ':' + link.end, { start: link.start, end: link.end,
          text: newParts.map(part => encodeSegment(part, angle)).join('/') });
      } else for (let i = 0; i < oldParts.length; i++) {
        if (oldParts[i] === newParts[i]) continue;
        const start = link.start + ranges[i]!.start, end = link.start + ranges[i]!.end;
        edits.set(start + ':' + end, { start, end, text: encodeSegment(newParts[i]!, angle) });
      }
    }
    let edited = source;
    for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) {
      edited = edited.slice(0, edit.start) + edit.text + edited.slice(edit.end);
    }
    if (edited !== source) changes.set(file, edited);
  }
  return changes;
}

export function renameDocumentLinks(project: Project, kind: RenameKind, path: string, to: string): Map<string, string> {
  if (kind === 'schema') return new Map();
  const [name, key, column] = path.split('/');
  const contexts = kind === 'column' ? tableContexts(project) : undefined;
  const schema = contexts?.get(name!)?.table.schema;
  const shared = new Set(contexts ? [...contexts].filter(([, item]) => item.table.schema === schema).map(([table]) => table) : []);
  return rewriteDocumentPaths(project, destination => {
    const parts = destination.split('/');
    if ((kind === 'table' || kind === 'document') && parts[0] === name) parts[0] = to;
    if (kind === 'key' && parts[0] === name && parts[1] === key) parts[1] = to;
    if (kind === 'column' && shared.has(parts[0]!) && parts[2] === column) parts[2] = to;
    if ((kind === 'heading' || kind === 'tag') && documentPathMatches(destination, path)) parts[path.split('/').length - 1] = to;
    return parts.join('/');
  });
}
