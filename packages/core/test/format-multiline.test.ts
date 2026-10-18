import { expect, it } from 'vitest';
import { formatYaml, parseYaml, updateCell } from '../src/yaml.js';
import type { TableSchema } from '../src/types.js';

it('keeps long multiline text on one physical line without changing its value', () => {
  const schema: TableSchema = { primary_key: 'key', columns: { key: { type: 'string' }, note: { type: 'text' } } };
  const value = '긴 설명을 원문 그대로 보존합니다. '.repeat(4) + '\r\n두 번째 줄\t"인용"\\경로';
  const file = formatYaml(parseYaml(JSON.stringify({ schema: 'notes', rows: [{ key: 'a', note: value }] })), schema);
  expect(file.data).toEqual({ schema: 'notes', rows: [{ key: 'a', note: value }] });
  expect(file.source.split('\n')).toContain('    note: ' + JSON.stringify(value));
  expect(formatYaml(file, schema).source).toBe(file.source);
  const updated = updateCell(file, schema, 'a', 'note', value + ' 수정');
  const before = file.source.split('\n'), after = updated.source.split('\n');
  expect(after).toHaveLength(before.length);
  expect(after.filter((line, index) => line !== before[index])).toHaveLength(1);
});
