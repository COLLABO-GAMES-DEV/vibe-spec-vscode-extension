import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString } from 'mdast-util-to-string';
import type { Definition, Nodes, Root } from 'mdast';
import type { DocumentBlock, DocumentLink, ParsedDocument } from './document-types.js';

const parser = unified().use(remarkParse).use(remarkGfm);
const supported = new Set(['heading', 'paragraph', 'list', 'listItem', 'table', 'tableRow', 'tableCell',
  'blockquote', 'code', 'thematicBreak', 'text', 'emphasis', 'strong', 'delete', 'inlineCode', 'break',
  'link', 'image', 'linkReference', 'imageReference']);

export function visitMarkdown(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ('children' in node) for (const child of node.children) visitMarkdown(child, visit);
}

/** remark removes a leading BOM before assigning offsets. Account for it explicitly. */
export function markdownTree(source: string): Root {
  const bom = source.startsWith('\uFEFF') ? 1 : 0;
  const tree = parser.parse(source);
  if (bom) visitMarkdown(tree, node => {
    for (const point of [node.position?.start, node.position?.end]) {
      if (point?.offset !== undefined) point.offset += bom;
    }
  });
  return tree;
}

export const nodeStart = (node: Nodes): number => node.position!.start.offset!;
export const nodeEnd = (node: Nodes): number => node.position!.end.offset!;
export const nameComment = /^<!--[ \t]*name:[ \t]*([^\r\n]*?)[ \t]*-->$/;
export const decodeDestination = (value: string): string => {
  try { return decodeURIComponent(value); } catch { return value; }
};

function closeLabel(source: string, start: number, end: number): number {
  let depth = 0;
  for (let at = start; at < end; at++) {
    if (source[at] === '\\') { at++; continue; }
    if (source[at] === '`') {
      const run = /^`+/.exec(source.slice(at))![0];
      let close = source.indexOf(run, at + run.length);
      while (close !== -1 && (source[close - 1] === '`' || source[close + run.length] === '`')) close = source.indexOf(run, close + run.length);
      if (close !== -1 && close < end) { at = close + run.length - 1; continue; }
    }
    if (source[at] === '[') depth++;
    if (source[at] === ']' && --depth === 0) return at;
  }
  return -1;
}

/** Scan only parser-confirmed destinations, never infer a link from prose/code. */
function destinationSpan(source: string, node: Nodes): { start: number; end: number } | undefined {
  const begin = nodeStart(node), limit = nodeEnd(node);
  let at: number;
  if (node.type === 'definition') {
    at = closeLabel(source, begin, limit) + 1;
    if (source[at] !== ':') return undefined;
    at++;
  } else if (node.type === 'link' || node.type === 'image') {
    if (source[begin] === '<') return { start: begin + 1, end: limit - 1 }; // autolink
    if (node.type === 'link' && node.children.length) {
      // Child positions handle brackets inside code spans and nested images.
      at = nodeEnd(node.children.at(-1)!);
      while (at < limit && source[at] !== ']') at++;
    } else at = closeLabel(source, begin + (node.type === 'image' ? 1 : 0), limit);
    if (at < begin || source[at + 1] !== '(') {
      // GFM bare autolinks have no Markdown destination delimiters.
      return { start: begin, end: limit };
    }
    at += 2;
  } else return undefined;
  const lineStart = Math.max(source.lastIndexOf('\n', begin - 1), source.lastIndexOf('\r', begin - 1)) + 1;
  const quoted = source.slice(lineStart, begin).includes('>');
  let continuation = false;
  while (at < limit) {
    if (/\s/.test(source[at]!)) { continuation ||= /[\r\n]/.test(source[at]!); at++; }
    else if (quoted && continuation && source[at] === '>') at++;
    else break;
  }
  if (source[at] === '<') {
    const start = ++at;
    while (at < limit) {
      if (source[at] === '\\') { at += 2; continue; }
      if (source[at] === '>') return { start, end: at };
      at++;
    }
    return undefined;
  }
  const start = at;
  let depth = 0;
  while (at < limit) {
    const char = source[at]!;
    if (char === '\\' && /[!-/:-@\[-`{-~]/.test(source[at + 1] ?? '')) { at += 2; continue; }
    if (/\s/.test(char) || char === ')' && depth === 0) break;
    if (char === '(') depth++;
    if (char === ')') depth--;
    at++;
  }
  return { start, end: at };
}

function rawIssues(node: Nodes, source: string): string[] {
  const issues = new Set<string>();
  visitMarkdown(node, child => {
    if (!supported.has(child.type)) issues.add(child.type === 'html'
      ? 'HTML requires source editing.' : 'Unsupported Markdown element: ' + child.type + '.');
    if (child.type === 'linkReference' || child.type === 'imageReference') issues.add('Reference links require source editing to preserve their definitions.');
    if ((child.type === 'link' || child.type === 'image') && child.title != null) issues.add('Link and image titles require source editing.');
    if (child.type === 'code' && child.meta) issues.add('Code metadata requires source editing.');
    if (child.type === 'inlineCode' && /[\r\n]/.test(source.slice(nodeStart(child), nodeEnd(child)))) {
      issues.add('Multiline inline code requires source editing.');
    }
    if (child.type === 'text') {
      const raw = source.slice(nodeStart(child), nodeEnd(child));
      if (/(^|[^\\])\${1,2}[^$\r\n]+\${1,2}|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/.test(raw) || /^\s*\$\$/m.test(raw)) {
        issues.add('Math requires source editing.');
      }
    }
    if (child.type === 'table' && child.children.some(row => row.children.length !== child.align?.length)) {
      issues.add('Table rows have inconsistent cell counts.');
    }
    if (child.type === 'table' && child.align?.some(align => align !== null)) issues.add('Table alignment requires source editing.');
    if (child.type === 'paragraph') {
      if (child.children.some(item => item.type === 'image' || item.type === 'imageReference') && child.children.length !== 1) {
        issues.add('Images mixed with text require source editing.');
      }
      const lines = source.slice(nodeStart(child), nodeEnd(child)).split(/\r\n|\r|\n/);
      if (lines.some(line => /\|.*\|/.test(line) && (/^\s*\|/.test(line) || /\|\s*$/.test(line))) ||
          lines.some(line => /^\s*\|?\s*:?-+:?\s*\|[-:|\s]*$/.test(line))) {
        issues.add('Unparsed table requires source editing.');
      }
    }
  });
  return [...issues];
}

export function parseMarkdown(name: string, source: string): ParsedDocument {
  const tree = markdownTree(source);
  const result: ParsedDocument = { name, source, blocks: [], links: [], diagnostics: [] };
  const headings: { depth: number; path: string }[] = [];
  const named = new Set<string>();
  const definitions = new Map<string, Definition>();
  const allDefinitions: Definition[] = [];
  const usedDefinitions = new Set<Definition>();
  visitMarkdown(tree, node => {
    if (node.type === 'definition') {
      allDefinitions.push(node);
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
    }
  });
  const diagnostic = (code: string, path: string, message: string, warning = false) => {
    result.diagnostics.push({ code, file: 'documents/' + name + '.md', path, message,
      ...(warning ? { severity: 'warning' as const } : {}) });
  };
  function assignPath(block: DocumentBlock, segment: string): string {
    const parent = headings.at(-1)?.path ?? name;
    const path = parent + '/' + segment;
    if (!segment.trim() || /[/\r\n]/.test(segment)) {
      diagnostic('DOCUMENT_NAME_INVALID', path, 'Heading and tag names must be nonempty and cannot contain / or line breaks.');
    }
    if (named.has(path)) diagnostic('DOCUMENT_PATH_DUPLICATE', path, 'Headings and tags must be unique under the same parent.');
    named.add(path);
    block.path = path;
    return path;
  }
  function addLink(node: Nodes, block: number): void {
    let target: Nodes = node, image = node.type === 'image' || node.type === 'imageReference';
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const definition = definitions.get(node.identifier);
      if (!definition) return;
      usedDefinitions.add(definition);
      target = definition;
    }
    if (!('url' in target) || typeof target.url !== 'string') return;
    const span = destinationSpan(source, target);
    if (!span) {
      diagnostic('DOCUMENT_LINK_UNSUPPORTED', name, 'Cannot locate this link destination safely.', true);
      return;
    }
    const destination = target.url, path = decodeDestination(destination);
    const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path);
    image ||= /^assets\//.test(path);
    const kind: DocumentLink['kind'] = image ? 'image' : external ? 'external' : 'resource';
    result.links.push({ destination, ...span, kind, block, ...(!external ? { path } : {}) });
  }
  for (let i = 0; i < tree.children.length; i++) {
    let node = tree.children[i]!;
    const start = nodeStart(node);
    let group = [node];
    let tag: string | undefined;
    if (node.type === 'html') {
      const match = nameComment.exec(source.slice(start, nodeEnd(node)));
      const next = tree.children[i + 1];
      if (match && next?.type === 'paragraph' && /^(?:\r\n|\r|\n)[ \t]*$/.test(source.slice(nodeEnd(node), nodeStart(next)))) {
        tag = match[1]!;
        node = next;
        group = [node];
        i++;
      } else if (match) diagnostic('DOCUMENT_TAG_ORPHAN', name, 'A name comment must immediately precede a paragraph.');
    }
    // Markdown between paired HTML containers belongs to that opaque source group.
    if (node.type === 'html') {
      const open = /^<(aside|details|div|section|figure|table)\b[^>]*>/i.exec(node.value);
      if (open && !new RegExp('</' + open[1] + '\\s*>', 'i').test(node.value)) {
        const tokens = new RegExp('<(/?)' + open[1] + '\\b[^>]*>', 'gi');
        let depth = 0, close = -1;
        for (const token of source.slice(start).matchAll(tokens)) {
          if (/\/\s*>$/.test(token[0])) continue;
          depth += token[1] ? -1 : 1;
          if (depth === 0) { close = start + token.index + token[0].length; break; }
        }
        if (close !== -1) {
          while (tree.children[i + 1] && nodeStart(tree.children[i + 1]!) < close) group.push(tree.children[++i]!);
        }
      }
    }
    const issues = [...new Set(group.flatMap(item => rawIssues(item, source)))];
    const end = nodeEnd(group.at(-1)!);
    const block: DocumentBlock = { index: result.blocks.length, kind: issues.length ? 'raw' : node.type,
      start, end, markdown: source.slice(start, end), editable: issues.length === 0, issues };
    if (node.type === 'heading') {
      while (headings.length && headings.at(-1)!.depth >= node.depth) headings.pop();
      const path = assignPath(block, toString(node).replace(/\r\n|\r|\n/g, ' '));
      headings.push({ depth: node.depth, path });
    } else if (tag !== undefined) assignPath(block, tag);
    result.blocks.push(block);
    for (const issue of issues) diagnostic('DOCUMENT_RAW', block.path ?? name, 'Block ' + block.index + ': ' + issue, true);
    for (const item of group) visitMarkdown(item, child => {
      if (['link', 'image', 'linkReference', 'imageReference'].includes(child.type)) addLink(child, block.index);
    });
  }
  // Unused definitions still contain structured destinations that must survive a rename.
  for (const definition of allDefinitions) {
    if (usedDefinitions.has(definition)) continue;
    const block = result.blocks.find(item => item.start <= nodeStart(definition) && item.end >= nodeEnd(definition));
    if (block) addLink(definition, block.index);
  }
  return result;
}
