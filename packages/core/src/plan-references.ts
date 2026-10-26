import { documentPathMatches, rewriteMarkdownPaths } from './document-references.js';
import { markdownTree, nodeStart, parseMarkdown, nameComment } from './document-parser.js';
import { headingNameEdit } from './documents.js';
import { isDeepStrictEqual } from 'node:util';
import type { Project, RenameKind, Usage, Usages, YamlFile } from './types.js';
import { isRecord, VibeError } from './types.js';
import { declaredReferences, tableContexts } from './validation.js';
import { formatYaml, parseYaml } from './yaml.js';

const patchFile = (path: string) => /^plans\/[^/]+\/(?!_plan\.yaml$)[^/]+\.yaml$/.test(path);

export function hasPlanAddedRow(project: Project, path: string): boolean {
  return [...project.files].some(([file, parsed]) => {
    if (!patchFile(file) || !isRecord(parsed.data) || !isRecord(parsed.data.add) || !isRecord(parsed.data.add[path])) return false;
    const metadata = project.files.get('plans/' + file.split('/')[1] + '/_plan.yaml')?.data;
    return isRecord(metadata) && (metadata.status === 'draft' || metadata.status === 'review');
  });
}

/** Rename current addresses and declared references, including archived patches.
 * Source evidence is historical text and deliberately remains unchanged. */
export function renamePlanReferences(project: Project, kind: RenameKind, path: string, to: string): Map<string, string> {
  const changes = new Map<string, string>();
  if (kind === 'schema') return changes;
  const [table, key, column] = path.split('/');
  const contexts = tableContexts(project), target = contexts.get(table!);
  const references = declaredReferences(project);
  const shared = new Set([...contexts].filter(([, item]) => item.table.schema === target?.table.schema).map(([name]) => name));
  function address(value: string): string {
    const parts = value.split('/');
    if ((kind === 'table' || kind === 'document') && parts[0] === table) parts[0] = to;
    if (kind === 'key' && parts[0] === table && parts[1] === key) parts[1] = to;
    if (kind === 'column' && shared.has(parts[0]!) && parts[2] === column) parts[2] = to;
    if ((kind === 'heading' || kind === 'tag') && documentPathMatches(value, path)) parts[path.split('/').length - 1] = to;
    return parts.join('/');
  }
  function fieldValue(name: string, field: string, value: unknown): unknown {
    const reference = references.find(item => item.name === name && item.field === field);
    return kind === 'key' && reference?.target === table && value === key ? to : value;
  }
  function valueAt(location: string, value: unknown): unknown {
    const [name, row, field] = location.split('/');
    if (field !== undefined) return fieldValue(name!, field, value);
    if (!isRecord(value)) return value;
    const result = Object.create(null) as Record<string, unknown>;
    for (const [code, raw] of Object.entries(value)) {
      const nextCode = kind === 'column' && shared.has(name!) && code === column ? to : code;
      if (Object.hasOwn(result, nextCode)) throw new VibeError('NAME_EXISTS', 'A variant already contains column: ' + nextCode);
      result[nextCode] = kind === 'key' && name === table && row === key &&
        code === contexts.get(name!)?.schema.primary_key && raw === key ? to : fieldValue(name!, code, raw);
    }
    return result;
  }
  for (const [file, parsed] of project.files) {
    if (!patchFile(file) || !isRecord(parsed.data)) continue;
    const data = structuredClone(parsed.data);
    for (const section of ['set', 'add', 'base_values']) {
      const mapping = data[section];
      if (!isRecord(mapping)) continue;
      const renamed = Object.create(null) as Record<string, unknown>;
      for (const [location, value] of Object.entries(mapping)) {
        const next = address(location);
        if (Object.hasOwn(renamed, next)) throw new VibeError('NAME_EXISTS', 'A variant already uses path: ' + next);
        renamed[next] = valueAt(location, value);
      }
      data[section] = renamed;
    }
    for (const section of ['remove', 'base_missing']) {
      if (Array.isArray(data[section])) data[section] = data[section].map(value => typeof value === 'string' ? address(value) : value);
    }
    for (const section of ['documents', 'document_base_values']) {
      const mapping = data[section];
      if (!isRecord(mapping)) continue;
      const renamed: Record<string, string> = Object.create(null);
      for (const [location, raw] of Object.entries(mapping)) {
        if (typeof raw !== 'string') continue;
        const next = address(location);
        if (Object.hasOwn(renamed, next)) throw new VibeError('NAME_EXISTS', 'A variant already uses scope: ' + next);
        let value = raw;
        if ((kind === 'heading' || kind === 'tag') && documentPathMatches(path, location)) {
          const name = location.split('/')[0]!;
          const blocks = parseMarkdown(name, raw).blocks;
          const parent = location.split('/').slice(1, -1);
          const relativePath = (p: string) => location === name ? p : [name, ...parent, ...p.split('/').slice(1)].join('/');
          const block = blocks.find(b => b.path && relativePath(b.path) === path);
          if (block) {
            if (kind === 'heading') {
              const heading = markdownTree(raw).children.find(n => n.type === 'heading' && nodeStart(n) === block.start);
              if (heading?.type === 'heading') { const edit = headingNameEdit(raw, heading, to); value = raw.slice(0, edit.start) + edit.text + raw.slice(edit.end); }
            } else {
              const comment = block.markdown.split(/\r\n|\r|\n/)[0]!;
              const old = nameComment.exec(comment)?.[1];
              if (old) { const start = block.start + comment.indexOf(old); value = raw.slice(0, start) + to + raw.slice(start + old.length); }
            }
          }
        }
        renamed[next] = rewriteMarkdownPaths(next.split('/')[0]!, value, address);
      }
      data[section] = renamed;
    }
    if (!isDeepStrictEqual(parsed.data, data)) changes.set(file, formatYaml(parseYaml(JSON.stringify(data), file)).source);
  }
  return changes;
}

export function planUsages(project: Project, path: string): Usages {
  const [target, key, column] = path.split('/'), needle = column ?? key ?? target!;
  const result: Usages = { references: [], candidates: [] };
  const references = declaredReferences(project);
  function usage(file: YamlFile, parts: (string | number)[], list: Usage[]) {
    const node = file.document.getIn(parts, true) as { range?: number[] } | undefined;
    const offset = node?.range?.[0] ?? 0, line = file.source.slice(0, offset).split('\n').length;
    const location = parts.join('/');
    if (!list.some(item => item.file === file.file && item.path === location)) list.push({
      file: file.file, path: location, line, text: file.source.split('\n')[line - 1] ?? '',
    });
  }
  function matches(location: string): boolean {
    const [name, row, field] = location.split('/');
    return name === target && (key === undefined || key === '*' || key === row) && (column === undefined || column === field);
  }
  function cell(file: YamlFile, parts: (string | number)[], table: string, field: string, value: unknown) {
    const reference = references.find(item => item.name === table && item.field === field);
    if (reference) {
      if (column === undefined && reference.target === target && (key === undefined || value === key)) usage(file, parts, result.references);
    } else if (typeof value === 'string' && value.includes(needle)) usage(file, parts, result.candidates);
  }
  function text(file: YamlFile, parts: (string | number)[], value: unknown) {
    if (typeof value === 'string' && value.includes(needle)) usage(file, parts, result.candidates);
    else if (Array.isArray(value)) value.forEach((item, i) => text(file, [...parts, i], item));
    else if (isRecord(value)) for (const [name, item] of Object.entries(value)) text(file, [...parts, name], item);
  }
  for (const [filePath, file] of project.files) {
    if (!filePath.startsWith('plans/') || !isRecord(file.data)) continue;
    if (!patchFile(filePath)) { text(file, [], file.data); continue; }
    for (const section of ['set', 'add', 'base_values']) {
      const mapping = file.data[section];
      if (!isRecord(mapping)) continue;
      for (const [location, value] of Object.entries(mapping)) {
        const parts = [section, location], [name, , field] = location.split('/');
        if (matches(location)) usage(file, parts, result.references);
        if (field !== undefined) cell(file, parts, name!, field, value);
        else if (isRecord(value)) for (const [code, raw] of Object.entries(value)) {
          if (matches(location + '/' + code)) usage(file, [...parts, code], result.references);
          cell(file, [...parts, code], name!, code, raw);
        }
      }
    }
    for (const section of ['remove', 'base_missing']) {
      const values = file.data[section];
      if (Array.isArray(values)) values.forEach((location, i) => {
        if (typeof location === 'string' && matches(location)) usage(file, [section, i], result.references);
      });
    }
    for (const section of ['documents', 'document_base_values']) {
      const mapping = file.data[section];
      if (!isRecord(mapping)) continue;
      for (const [location, value] of Object.entries(mapping)) {
        const parts = [section, location];
        if (documentPathMatches(location, path)) usage(file, parts, result.references);
        if (typeof value !== 'string') continue;
        const parsed = parseMarkdown(location.split('/')[0]!, value);
        if (parsed.links.some(link => link.kind === 'resource' && link.path && documentPathMatches(link.path, path, true))) usage(file, parts, result.references);
        let prose = value;
        for (const link of [...parsed.links].sort((a, b) => b.start - a.start)) prose = prose.slice(0, link.start) + prose.slice(link.end);
        text(file, parts, prose);
      }
    }
    text(file, ['sources'], file.data.sources);
  }
  return result;
}
