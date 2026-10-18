import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { compareResourceNames, getDocumentView, getTableView, initProject, inspectStructure,
  listDocuments, listFolders, listTables, loadProject, resourceEntries, tableSummaries } from '../src/index.js';
import { formattedSources } from '../src/project.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('naturally orders resource numbers, including numbers beyond safe integers', () => {
  for (const prefix of ['', '문서 ', 'table_', '폴더/하위']) {
    expect([100, 11, 6, 1].map(n => prefix + n).sort(compareResourceNames))
      .toEqual([1, 6, 11, 100].map(n => prefix + n));
  }
  expect(['표9007199254740993', '표9007199254740992'].sort(compareResourceNames))
    .toEqual(['표9007199254740992', '표9007199254740993']);
});

it('breaks collation ties by original spelling independently of input order', () => {
  for (const pair of [['문서1', '문서01'], ['가1', '가1'.normalize('NFD')]]) {
    const expected = [...pair].sort();
    expect([...pair].sort(compareResourceNames)).toEqual(expected);
    expect([...pair].reverse().sort(compareResourceNames)).toEqual(expected);
  }
  expect(compareResourceNames('표1', '표1')).toBe(0);
});

it('orders document, table and folder views without changing source, row, Key or block order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-resource-order-')); roots.push(root);
  await initProject(root);
  const schema = 'primary_key: key\ncolumns:\n  key: {type: integer}\n  target: {type: ref, table: 표1}\n';
  await writeFile(join(root, 'schemas/shared.yaml'), schema);
  const keys = ['100', '11', '6', '1'];
  const table = '# preserve row order\r\nschema: shared\r\nrows:\r\n' +
    keys.map(key => `  - key: "${key}"\r\n    target: "${key}"\r\n`).join('');
  const markdown = '\uFEFF# 제목11\r\n\r\n문단  \r\n\r\n# 제목1\r\n';
  const numbers = [1, 6, 11, 100];
  for (const [index, n] of numbers.entries()) {
    const folder = '폴더' + numbers[numbers.length - index - 1];
    for (const side of ['tables', 'documents']) await mkdir(join(root, side, folder), { recursive: true });
    await writeFile(join(root, 'tables', folder, `표${n}.yaml`), table);
    await writeFile(join(root, 'documents', folder, `문서${n}.md`), markdown);
  }
  await mkdir(join(root, 'documents/폴더1/하위11'), { recursive: true });
  await mkdir(join(root, 'tables/폴더1/하위6'), { recursive: true });
  await mkdir(join(root, 'documents/assets'), { recursive: true });
  const project = await loadProject(root);
  const sources = [...project.sources], files = [...project.files], directories = [...project.directories!];
  const entries = resourceEntries(project), formatted = [...formattedSources(project)];
  const tables = numbers.map(n => '표' + n);
  expect(listTables(project).map(item => item.name)).toEqual(tables);
  expect(tableSummaries(project).map(item => item.name)).toEqual(tables);
  expect(listDocuments(project).map(item => item.name)).toEqual(numbers.map(n => '문서' + n));
  expect(listFolders(project)).toEqual(['폴더1', '폴더1/하위6', '폴더1/하위11', '폴더6', '폴더11', '폴더100']);
  const view = getTableView(project, '표1');
  expect(view.tables).toEqual(tables);
  expect(view.schemaTables).toEqual(tables);
  expect(view.rows.map(row => row.key)).toEqual(keys);
  expect(view.references.target).toEqual(keys);
  expect((await inspectStructure(project, { op: 'column-update', table: '표1', column: 'target', changes: { label: '대상' } })).tables)
    .toEqual(tables);
  const document = getDocumentView(project, '문서1');
  expect(document.source).toBe(markdown);
  expect(document.blocks.filter(block => block.kind === 'heading').map(block => block.markdown)).toEqual(['# 제목11', '# 제목1']);
  expect([...project.sources]).toEqual(sources);
  expect([...project.files]).toEqual(files);
  expect(project.directories).toEqual(directories);
  expect(resourceEntries(project)).toEqual(entries);
  expect([...formattedSources(project)]).toEqual(formatted);
  for (const [file, source] of sources) expect(await readFile(join(root, file))).toEqual(Buffer.from(source));
  expect((await loadProject(root)).revision).toBe(project.revision);
});
