import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';
import { VibeError, isRecord } from './types.js';
import type { Cell, Diagnostic, TableSchema, YamlFile } from './types.js';

// The YAML parser never constructs a JS number, even for invalid bare numerals.
export function parseYaml(source: string, file = '<input>'): YamlFile {
  const document = parseDocument(source, {
    schema: 'failsafe',
    customTags: ['bool', 'null'],
    keepSourceTokens: true,
    prettyErrors: false,
    uniqueKeys: true,
    stringKeys: true,
  });
  const diagnostics: Diagnostic[] = [...document.errors, ...document.warnings].map(error => ({
    code: 'YAML_SYNTAX', file, path: '', message: error.message,
  }));
  visit(document, (_key, node) => {
    if (isAlias(node) || (isRecord(node) && (node.anchor || node.tag))) {
      diagnostics.push({
        code: 'YAML_UNSUPPORTED', file, path: '',
        message: 'Aliases, anchors and explicit tags are not supported.',
      });
    }
  });
  if (diagnostics.length) throw new VibeError('INVALID_YAML', 'Cannot parse ' + file, diagnostics);
  return { file, source, document: document as YamlFile['document'], data: document.toJS() };
}

export function serializeYaml(file: YamlFile): string {
  return file.source;
}

export function updateCell(
  file: YamlFile, schema: TableSchema, key: string, column: string, value: Cell,
): YamlFile {
  if (!isRecord(file.data) || !Array.isArray(file.data.rows) ||
      !Object.hasOwn(schema.columns, column)) {
    throw new VibeError('INVALID_CELL', 'Expected an existing table column.');
  }
  if (column === schema.primary_key) {
    throw new VibeError('INVALID_CELL', 'Key renaming is not part of the cell-value API.');
  }
  if (value !== null && typeof value !== 'string' && typeof value !== 'boolean') {
    throw new VibeError('INVALID_CELL', 'Cell values must be strings, booleans or null.');
  }
  const matches = file.data.rows.flatMap((row: unknown, index: number) =>
    isRecord(row) && row[schema.primary_key] === key ? [index] : []);
  if (matches.length !== 1) throw new VibeError('INVALID_CELL', 'Row Key is missing or ambiguous.');
  const node = file.document.getIn(['rows', matches[0]!, column], true);
  if (!isScalar(node) || !node.range) {
    throw new VibeError('INVALID_CELL', 'Expected an existing scalar cell.');
  }
  if (Object.is(node.value, value)) return file;
  const [start, end] = node.range;
  return parseYaml(file.source.slice(0, start) + JSON.stringify(value) + file.source.slice(end), file.file);
}

export function formatYaml(file: YamlFile, _schema?: TableSchema): YamlFile {
  const document = file.document.clone();
  visit(document, (key, node) => {
    if (isMap(node) || isSeq(node)) node.flow = false;
    if (isScalar(node) && typeof node.value === 'string') {
      node.type = key === 'key' ? 'PLAIN' : 'QUOTE_DOUBLE';
    }
  });
  return parseYaml(document.toString({
    indent: 2, lineWidth: 0, blockQuote: false, doubleQuotedAsJSON: true,
  }).replace(/\r\n/g, '\n'), file.file);
}
