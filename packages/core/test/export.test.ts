import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportMarkdown } from '../src/export.js';
import { initProject, loadProject } from '../src/project.js';
import type { Project, TableSchema } from '../src/types.js';
import { formatYaml, parseYaml } from '../src/yaml.js';

const sandboxes: string[] = [];
const schema: TableSchema = { primary_key: 'key', columns: {
  key: { type: 'string', label: 'Key' },
  title: { type: 'text', label: '제목', required: true },
  price: { type: 'decimal' },
  kind: { type: 'enum', values: ['one', 'two'] },
  target: { type: 'ref', table: 'items', on_delete: 'restrict', nullable: true },
} };
const yaml = (file: string, value: unknown) => formatYaml(parseYaml(JSON.stringify(value), file)).source;
async function fixture(entries: Record<string, unknown> = {
  'schemas/items.yaml': schema,
  'tables/items.yaml': { schema: 'items', rows: [{ key: 'a', title: '원문', price: '+001.2300E+0002', kind: 'one', target: 'a' }] },
}) {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'vibe-export-'))); sandboxes.push(sandbox);
  const root = join(sandbox, 'planning');
  await initProject(root);
  for (const [file, value] of Object.entries(entries)) await writeFile(join(root, file), yaml(file, value));
  return { sandbox, project: await loadProject(root) };
}
const outputFile = (project: Project, name = 'items.md') => join(project.root, '.vibe-spec-export', name);
async function sourceSnapshot(project: Project) {
  const names = [...project.sources.keys(), '.vibe-spec.json', '.gitignore', '.gitattributes', 'AGENTS.md'];
  return new Map(await Promise.all(names.map(async file => [file, await readFile(join(project.root, file), 'utf8')] as const)));
}
afterEach(async () => { await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('Markdown table exports', () => {
  it('exports schema, all rows and snapshot revision without touching any source or root ignore file', async () => {
    const { project } = await fixture();
    const before = await sourceSnapshot(project);
    execFileSync('git', ['init', '--quiet', project.root]);
    const result = await exportMarkdown(project);
    expect(result).toEqual({ directory: join(project.root, '.vibe-spec-export'), files: ['items.md'], revision: project.revision, diagnostics: [] });
    const source = await readFile(outputFile(project), 'utf8');
    expect(source).toContain('<!-- vibe-spec markdown export v1; project: ');
    expect(source).toContain('# items\n');
    expect(source).toContain('Source revision: ' + project.revision);
    expect(source).toContain('Validation errors: 0 in this table/schema; 0 in the project.');
    expect(source).toContain('| Code | Label | Type | Required | Enum | Ref | Key |');
    expect(source).toContain('| key | Key | string | true |  |  | yes |');
    expect(source).toContain('| title | 제목 | text | true |');
    expect(source).toContain('&#91;"one","two"&#93;');
    expect(source).toContain('items (on_delete: restrict)');
    expect(source).toContain('| a | 원문 | +001.2300E+0002 | one | a |');
    expect(source).toContain('vibe read <table> --json --project <planning-root>');
    expect(await sourceSnapshot(project)).toEqual(before);
    expect((await loadProject(project.root)).revision).toBe(project.revision);
    expect(await readFile(join(result.directory, '.gitignore'), 'utf8')).toBe('*\n');
    expect(execFileSync('git', ['check-ignore', '.vibe-spec-export/items.md', '.vibe-spec-export/.gitignore'],
      { cwd: project.root, encoding: 'utf8' }).trim().split(/\r?\n/)).toEqual(['.vibe-spec-export/items.md', '.vibe-spec-export/.gitignore']);
  });

  it('uses the supplied snapshot even if the source changes after it was read', async () => {
    const { project } = await fixture();
    await writeFile(join(project.root, 'tables/items.yaml'), yaml('tables/items.yaml', { schema: 'items', rows: [{ key: 'newer', title: 'later' }] }));
    const current = await loadProject(project.root), result = await exportMarkdown(project);
    expect(result.revision).toBe(project.revision);
    expect(await readFile(outputFile(project), 'utf8')).toContain('| a | 원문 |');
    expect((await loadProject(project.root)).revision).toBe(current.revision);
  });

  it('preserves numeric/ref text and escapes pipes, line breaks, HTML and Markdown in cells and headers', async () => {
    const special = 'a|b\r\n<script>& *bold* _em_ `code` [link](url) ~~strike~~ \\tail';
    const key = 'ref|*[]`\\end';
    const unusual = 'extra|<code>\nline';
    const { project } = await fixture({
      'schemas/한글.yaml': { primary_key: 'key', columns: { key: { type: 'string' }, '이름|<b>': { type: 'text', label: special },
        number: { type: 'decimal' }, target: { type: 'ref', table: '한글' } } },
      'tables/한글.yaml': { schema: '한글', rows: [
        { key, '이름|<b>': special, number: '900719925474099312345', target: key, [unusual]: 'unlisted|value' },
        { key: 'b', '이름|<b>': '', number: '-0.000', target: key },
        { key: 'c', '이름|<b>': null, number: '+001.2300E+0002', target: key },
        { key: 'd', number: '1.0000000000000000000000000000000001' },
      ] },
    });
    const result = await exportMarkdown(project), source = await readFile(join(result.directory, '한글.md'), 'utf8');
    for (const numeric of ['900719925474099312345', '-0.000', '+001.2300E+0002', '1.0000000000000000000000000000000001']) expect(source).toContain(numeric);
    expect(source).toContain('a&#124;b&#13;<br>&#60;script&#62;&#38; &#42;bold&#42; &#95;em&#95; &#96;code&#96; &#91;link&#93;(url) &#126;&#126;strike&#126;&#126; &#92;tail');
    expect(source).not.toContain('<script>');
    expect(source).not.toContain('\r');
    expect(source).toContain('ref&#124;&#42;&#91;&#93;&#96;&#92;end');
    expect(source).toContain('Undeclared columns (included in the rows): extra&#124;&#60;code&#62;<br>line.');
    expect(source).toContain('unlisted&#124;value');
    expect(source).toContain('<em>empty string</em>');
    expect(source).toContain('<em>null</em>');
    expect(source).toContain('<em>missing</em>');
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'COLUMN_UNKNOWN' }), expect.objectContaining({ code: 'VALUE_TYPE_OR_RANGE' })]));
    const body = source.split('## Rows\n')[1]!.split('\n').filter(line => line.startsWith('|'));
    expect(body).toHaveLength(6); // Header, divider, all four original rows.
    expect(body.every(line => line.split('|').length === 7)).toBe(true);
  });

  it('exports ordinary value and reference errors and reports their count', async () => {
    const { project } = await fixture({ 'schemas/items.yaml': schema,
      'tables/items.yaml': { schema: 'items', rows: [{ key: 'a', price: 'not numeric', target: 'missing', undeclared: { nested: ['value', null] } }] } });
    const result = await exportMarkdown(project);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'VALUE_REQUIRED' }), expect.objectContaining({ code: 'VALUE_TYPE_OR_RANGE' }),
      expect.objectContaining({ code: 'REF_MISSING' }), expect.objectContaining({ code: 'COLUMN_UNKNOWN' }),
    ]));
    const source = await readFile(outputFile(project), 'utf8');
    expect(source).toContain('Validation errors: ' + result.diagnostics.length + ' in this table/schema;');
    expect(source).toContain('not numeric');
    expect(source).toContain('{"nested":&#91;"value",null&#93;}');
  });

  it('keeps schema YAML column order including numeric codes and includes empty tables', async () => {
    const { project } = await fixture();
    await writeFile(join(project.root, 'schemas/items.yaml'), 'primary_key: key\ncolumns:\n  key:\n    type: string\n  "10":\n    type: text\n  "2":\n    type: text\n');
    await writeFile(join(project.root, 'tables/items.yaml'), 'schema: items\nrows: []\n');
    const result = await exportMarkdown(await loadProject(project.root));
    expect(await readFile(join(result.directory, 'items.md'), 'utf8')).toContain('Rows: 0\n\n| key | 10 | 2 |');
  });

  it.each([
    ['schemas/items.yaml', 'columns: [\n'],
    ['schemas/items.yaml', 'primary_key: key\ncolumns: []\n'],
    ['schemas/items.yaml', 'primary_key: missing\ncolumns:\n  key:\n    type: string\n'],
    ['tables/items.yaml', 'schema: missing\nrows: []\n'],
    ['tables/items.yaml', 'schema: items\nrows: [null]\n'],
  ])('rejects unreadable input %s before creating an output directory', async (file, source) => {
    const { project } = await fixture();
    await writeFile(join(project.root, file), source);
    await expect(exportMarkdown(await loadProject(project.root))).rejects.toMatchObject({ code: 'EXPORT_UNREADABLE' });
    expect(await readdir(project.root)).not.toContain('.vibe-spec-export');
  });
});

describe('Markdown output paths and generated files', () => {
  it('resolves configured paths from the planning root and explicit output takes precedence', async () => {
    const { sandbox, project } = await fixture();
    await writeFile(join(project.root, '.vibe-spec.json'), JSON.stringify({ planning_root: '.', export_directory: 'configured output' }));
    const configured = await exportMarkdown(project);
    expect(configured.directory).toBe(join(project.root, 'configured output'));
    const explicit = await exportMarkdown(project, '../external output');
    expect(explicit.directory).toBe(join(sandbox, 'external output'));
    expect(await readFile(join(explicit.directory, '.gitignore'), 'utf8')).toBe('*\n');
    const absolute = await exportMarkdown(project, join(sandbox, 'absolute'));
    expect(absolute.directory).toBe(join(sandbox, 'absolute'));
    await writeFile(join(project.root, '.vibe-spec.json'), 'invalid JSON');
    expect((await exportMarkdown(project, '../explicit')).directory).toBe(join(sandbox, 'explicit'));
    await expect(exportMarkdown(project)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it.each(['', '  ', null, false, 42])('rejects invalid configured export_directory %j', async value => {
    const { project } = await fixture();
    await writeFile(join(project.root, '.vibe-spec.json'), JSON.stringify({ planning_root: '.', export_directory: value }));
    await expect(exportMarkdown(project)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it.each(['.', '..', 'schemas', 'schemas/subfolder', 'tables', 'tables/subfolder', 'documents', 'documents/assets', 'plans', '.git', '.git/export', '../.git/export'])
    ('rejects protected output %s without changing source files', async output => {
      const { project } = await fixture(), before = await sourceSnapshot(project);
      await expect(exportMarkdown(project, output)).rejects.toMatchObject({ code: 'EXPORT_PATH' });
      expect(await sourceSnapshot(project)).toEqual(before);
    });

  it('preserves an existing output .gitignore and unrelated files', async () => {
    const { project } = await fixture();
    const directory = join(project.root, 'out'); await mkdir(directory);
    const ignore = '# Team-owned ignore\r\n*\r\n';
    await writeFile(join(directory, '.gitignore'), ignore);
    await writeFile(join(directory, 'notes.md'), 'Handwritten notes.\n');
    await exportMarkdown(project, directory);
    expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe(ignore);
    expect(await readFile(join(directory, 'notes.md'), 'utf8')).toBe('Handwritten notes.\n');
  });

  it('updates generated files and removes only this project\'s stale generated Markdown', async () => {
    const { project } = await fixture();
    const initial = await exportMarkdown(project);
    const stale = await readFile(outputFile(project), 'utf8');
    await writeFile(join(initial.directory, 'notes.md'), 'foreign\n');
    await writeFile(join(initial.directory, 'old.md'), stale);
    await writeFile(join(initial.directory, 'snippet.md'), '# foreign\n' + stale);
    await writeFile(join(project.root, 'tables/items.yaml'), yaml('tables/items.yaml', { schema: 'items', rows: [{ key: 'changed', title: 'fresh' }] }));
    const current = await loadProject(project.root);
    await exportMarkdown(current);
    expect(await readFile(outputFile(project), 'utf8')).toContain('| changed | fresh |');
    expect(await readdir(initial.directory)).not.toContain('old.md');
    expect(await readFile(join(initial.directory, 'snippet.md'), 'utf8')).toBe('# foreign\n' + stale);
    await rm(join(project.root, 'tables/items.yaml'));
    expect((await exportMarkdown(await loadProject(project.root))).files).toEqual([]);
    expect(await readdir(initial.directory)).toEqual(expect.arrayContaining(['.gitignore', 'notes.md', 'snippet.md']));
    expect(await readdir(initial.directory)).not.toContain('items.md');
  });

  it('preflights all conflicts before rewriting any generated files or deleting stale ones', async () => {
    const { project } = await fixture();
    const result = await exportMarkdown(project), original = await readFile(outputFile(project), 'utf8');
    await writeFile(join(result.directory, 'stale.md'), original);
    await writeFile(join(result.directory, 'z.md'), 'Handwritten content.\n');
    await writeFile(join(project.root, 'tables/z.yaml'), yaml('tables/z.yaml', { schema: 'items', rows: [] }));
    await expect(exportMarkdown(await loadProject(project.root))).rejects.toMatchObject({ code: 'EXPORT_CONFLICT' });
    expect(await readFile(outputFile(project), 'utf8')).toBe(original);
    expect(await readFile(join(result.directory, 'stale.md'), 'utf8')).toBe(original);
    expect(await readFile(join(result.directory, 'z.md'), 'utf8')).toBe('Handwritten content.\n');
  });

  it('rejects a case-colliding foreign destination before creating .gitignore', async () => {
    const { project } = await fixture();
    const directory = join(project.root, 'out'); await mkdir(directory);
    await writeFile(join(directory, 'ITEMS.MD'), 'foreign');
    await expect(exportMarkdown(project, directory)).rejects.toMatchObject({ code: 'EXPORT_CONFLICT' });
    expect(await readdir(directory)).toEqual(['ITEMS.MD']);
  });

  it('does not overwrite or remove exports generated for another project', async () => {
    const a = await fixture(), b = await fixture();
    const shared = join(a.sandbox, 'shared');
    await exportMarkdown(a.project, shared);
    const original = await readFile(join(shared, 'items.md'), 'utf8');
    await expect(exportMarkdown(b.project, shared)).rejects.toMatchObject({ code: 'EXPORT_CONFLICT' });
    await rm(join(b.project.root, 'tables/items.yaml'));
    await exportMarkdown(await loadProject(b.project.root), shared);
    expect(await readFile(join(shared, 'items.md'), 'utf8')).toBe(original);
  });

  it('rejects an output directory symlink or junction into the source tree', async () => {
    const { sandbox, project } = await fixture(), before = await sourceSnapshot(project);
    const link = join(sandbox, 'linked-output');
    await symlink(join(project.root, 'tables'), link, 'junction');
    await expect(exportMarkdown(project, link)).rejects.toMatchObject({ code: 'EXPORT_PATH' });
    await expect(exportMarkdown(project, join(link, 'child'))).rejects.toMatchObject({ code: 'EXPORT_PATH' });
    expect(await sourceSnapshot(project)).toEqual(before);
  });

  // Windows file symlinks require Developer Mode/admin; directory junction coverage runs everywhere.
  it.skipIf(process.platform === 'win32').each(['items.md', 'stale.md', '.gitignore'])('rejects output symlink %s before touching any file', async file => {
    const { sandbox, project } = await fixture(), before = await sourceSnapshot(project);
    const directory = join(project.root, 'out'); await mkdir(directory);
    const outside = join(sandbox, 'outside.md'); await writeFile(outside, 'foreign');
    await symlink(outside, join(directory, file));
    await expect(exportMarkdown(project, directory)).rejects.toMatchObject({ code: 'EXPORT_CONFLICT' });
    expect(await readFile(outside, 'utf8')).toBe('foreign');
    expect(await sourceSnapshot(project)).toEqual(before);
    expect(await readdir(directory)).toEqual([file]);
  });

  it('rejects files or target directories in place of output paths', async () => {
    const { sandbox, project } = await fixture();
    const file = join(sandbox, 'file'); await writeFile(file, 'foreign');
    await expect(exportMarkdown(project, file)).rejects.toMatchObject({ code: 'EXPORT_PATH' });
    const directory = resolve(project.root, 'out'); await mkdir(join(directory, 'items.md'), { recursive: true });
    await expect(exportMarkdown(project, directory)).rejects.toMatchObject({ code: 'EXPORT_CONFLICT' });
    expect(await readdir(directory)).toEqual(['items.md']);
  });
});
