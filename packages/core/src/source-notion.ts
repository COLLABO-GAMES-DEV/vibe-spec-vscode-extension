import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, posix, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { marked } from 'marked';
import type { NotionSource, NotionSourceFile, NotionSourceLink } from './source-types.js';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function entryIdentity(path: string): { id: string; title: string; all: boolean; extension: string } | undefined {
  const match = /^(.*?)([a-f\d]{32})(_all)?\.(md|csv)$/i.exec(posix.basename(path));
  if (!match) return undefined;
  return { id: match[2]!.toLowerCase(), title: match[1]!.trimEnd(), all: !!match[3], extension: match[4]!.toLowerCase() };
}

function linkId(path: string): string | undefined {
  return /(?:^|[^a-f\d])([a-f\d]{32})(?:_all)?(?:\.(?:md|csv))?$/i.exec(posix.basename(path))?.[1]?.toLowerCase();
}

function decode(value: string, issues: string[], context: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    issues.push(`Invalid URL encoding in ${context}: ${value}`);
    return value;
  }
}

function inspectLink(
  url: string,
  kind: NotionSourceLink['kind'],
  page: NotionSource['pages'][number],
  paths: Set<string>,
  idPaths: Map<string, Set<string>>,
  issues: string[],
): NotionSourceLink {
  const link: NotionSourceLink = { kind, url, self: false };
  const hashIndex = url.indexOf('#');
  if (hashIndex !== -1) link.anchor = decode(url.slice(hashIndex + 1), issues, page.path);
  const withoutAnchor = hashIndex === -1 ? url : url.slice(0, hashIndex);
  let target = withoutAnchor.split('?')[0]!;
  const external = /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//');
  if (external) {
    // URL parsing only: no request is made, even for Notion URLs.
    let parsed: URL;
    try {
      parsed = new URL(url, 'https://notion.so');
    } catch {
      issues.push(`Invalid URL in ${page.path}: ${url}`);
      return link;
    }
    if (!['https:', 'http:'].includes(parsed.protocol)
      || !/(^|\.)notion\.(so|site)$/i.test(parsed.hostname)) return link;
    target = parsed.pathname;
  }
  target = decode(target, issues, page.path);
  const id = linkId(target);
  if (id) link.targetId = id;

  if (!external) {
    const path = target === '' ? page.path
      : posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(page.path), target));
    link.targetPath = path;
    if (paths.has(path)) {
      link.self = path === page.path;
      const identity = entryIdentity(path);
      if (identity) link.targetId = identity.id;
      return link;
    }
  }

  const candidates = id ? idPaths.get(id) : undefined;
  if (candidates?.size === 1) link.targetPath = candidates.values().next().value!;
  else if (candidates && candidates.size > 1) issues.push(`Ambiguous Notion ID in ${page.path}: ${url}`);
  else if (!external) issues.push(`Target is not in the ZIP (${page.path}): ${url}`);
  link.self = link.targetPath === page.path || (id !== undefined && id === page.id);
  return link;
}

/**
 * Inspect one unencrypted Notion Markdown/CSV ZIP in memory. UTF-8 text (including
 * BOMs and line endings) is retained; other entries have metadata only. Nested
 * ZIPs are listed but not expanded. No files, links or document blocks are imported.
 */
export async function inspectNotionSource(file: string): Promise<NotionSource> {
  const absoluteFile = resolve(file);
  if (extname(absoluteFile).toLowerCase() !== '.zip') throw new Error('Notion source inspection requires a ZIP file.');
  const bytes = await readFile(absoluteFile);
  const seen = new Set<string>();
  const entries = unzipSync(bytes, {
    filter(entry) {
      if (entry.name.endsWith('/')) return false;
      if (seen.has(entry.name)) throw new Error(`Duplicate ZIP entry path: ${entry.name}`);
      seen.add(entry.name);
      return true;
    },
  });
  if (Object.keys(entries).length !== seen.size) throw new Error('ZIP entry names could not be preserved by the ZIP reader.');
  const source: NotionSource = {
    kind: 'notion', file: absoluteFile, sourceHash: hash(bytes), files: [], pages: [], databases: [], issues: [],
  };
  const databases = new Map<string, NotionSource['databases'][number]>();
  // ignoreBOM=true keeps the BOM character instead of silently removing it.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  for (const [path, content] of Object.entries(entries)) {
    const entry: NotionSourceFile = { path, sha256: hash(content), bytes: content.byteLength };
    source.files.push(entry);
    const extension = posix.extname(path).toLowerCase();
    if (extension === '.zip') source.issues.push(`Nested ZIP is listed but not expanded: ${path}`);
    if (extension !== '.md' && extension !== '.csv') continue;
    try {
      entry.text = decoder.decode(content);
    } catch {
      source.issues.push(`Text is not valid UTF-8; only metadata is available: ${path}`);
    }
    const identity = entryIdentity(path);
    if (!identity) {
      source.issues.push(`No trailing 32-character Notion ID; file retained without page/database mapping: ${path}`);
      continue;
    }
    if (identity.extension === 'md') {
      source.pages.push({ id: identity.id, path, title: identity.title, links: [] });
    } else {
      const database = databases.get(identity.id);
      if (database) {
        database.files.push(path);
        if (identity.all && !entryIdentity(database.preferred)?.all) database.preferred = path;
      } else {
        databases.set(identity.id, { id: identity.id, preferred: path, files: [path] });
      }
    }
  }
  source.databases = [...databases.values()];
  const idPaths = new Map<string, Set<string>>();
  for (const { id, path } of [
    ...source.pages,
    ...source.databases.map(database => ({ id: database.id, path: database.preferred })),
  ]) {
    const paths = idPaths.get(id) ?? new Set<string>();
    paths.add(path);
    idPaths.set(id, paths);
  }
  const files = new Map(source.files.map(entry => [entry.path, entry]));
  const paths = new Set(files.keys());
  for (const page of source.pages) {
    const text = files.get(page.path)?.text;
    if (text === undefined) continue;
    // The parser handles balanced parentheses, reference links and nested tokens;
    // fenced/inline code and raw HTML are not treated as Markdown links.
    marked.walkTokens(marked.lexer(text), token => {
      if (token.type === 'link' || token.type === 'image') {
        page.links.push(inspectLink(token.href, token.type, page, paths, idPaths, source.issues));
      }
    });
  }
  return source;
}
