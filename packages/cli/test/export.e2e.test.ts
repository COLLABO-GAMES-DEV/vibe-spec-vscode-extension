import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic, MarkdownExport } from '@vibe-spec/core';
import { afterEach, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../core/test/fixtures/project/', import.meta.url));
const roots: string[] = [];
interface Reply<T = unknown> {
  ok: boolean;
  revision: string | null;
  data: T;
  diagnostics: Diagnostic[];
  error?: { code: string; message: string };
}
function run(root: string, cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args, '--project', root], {
    cwd, encoding: 'utf8', timeout: 15_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return result;
}
function cli<T = unknown>(root: string, cwd: string, args: string[]) {
  const result = run(root, cwd, [...args, '--json']);
  expect(result.stderr).toBe('');
  const reply = JSON.parse(result.stdout) as Reply<T>;
  expect(reply).toMatchObject({ ok: expect.any(Boolean), diagnostics: expect.any(Array) });
  expect(reply).toHaveProperty('revision');
  expect(reply).toHaveProperty('data');
  return { status: result.status, reply };
}
async function planning() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'vibe CLI export 한글 ')));
  roots.push(directory);
  const root = join(directory, '기획 원본');
  const cwd = join(directory, '별도 작업 폴더');
  await cp(fixture, root, { recursive: true });
  await mkdir(cwd);
  await writeFile(join(root, '.vibe-spec.json'), '{"planning_root":"."}\n');
  await writeFile(join(root, '.gitignore'), '# Keep source ignore bytes\r\n');
  await writeFile(join(root, 'AGENTS.md'), '# Planning instructions\n');
  await cp(join(root, 'tables/offers.yaml'), join(root, 'tables/보상 표.yaml'));
  return { directory, root, cwd };
}
async function sourceBytes(root: string) {
  const files = ['.vibe-spec.json', '.gitignore', 'AGENTS.md'];
  for (const directory of ['schemas', 'tables']) {
    files.push(...(await readdir(join(root, directory))).sort().map(name => directory + '/' + name));
  }
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(root, file))] as const)));
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Markdown export through actual CLI processes', { timeout: 60_000 }, () => {
  it('exports default, configured and explicit paths with raw numbers, reference Keys, schema summaries and unchanged sources', async () => {
    const { directory, root, cwd } = await planning();
    const before = await sourceBytes(root);
    const revision = cli(root, cwd, ['read', 'offers']).reply.revision;
    const exported = cli<MarkdownExport>(root, cwd, ['export']);
    expect(exported).toMatchObject({ status: 0, reply: { ok: true, revision, diagnostics: [], data: {
      directory: join(root, '.vibe-spec-export'), files: ['items.md', 'offers.md', '보상 표.md'], revision, diagnostics: [],
    } } });
    const output = exported.reply.data.directory;
    expect((await readdir(output)).sort()).toEqual(['.gitignore', 'items.md', 'offers.md', '보상 표.md']);
    expect(await readFile(join(output, '.gitignore'), 'utf8')).toBe('*\n');
    const markdown = await readFile(join(output, 'offers.md'), 'utf8');
    expect(markdown).toContain('Source revision: ' + revision);
    expect(markdown).toContain('## Schema\n');
    expect(markdown).toContain('Schema: offers\n');
    expect(markdown).toContain('| Code | Label | Type | Required | Enum | Ref | Key |');
    expect(markdown).toContain('| sku | <em>missing</em> | string | true |  |  | yes |');
    expect(markdown).toContain('items (on_delete: restrict)');
    expect(markdown).toContain('Rows: 2\n');
    expect(markdown).toContain('| bundle | currency&#95;gold | +001.2300E+0002 | 900719925474099312345 | true |');
    expect(markdown).toContain('| starter | <em>null</em> | -0.000 | 001 | false |');
    expect(await readFile(join(output, 'items.md'), 'utf8')).toContain('골드');
    expect(await readFile(join(output, '보상 표.md'), 'utf8')).toContain('# 보상 표\n');
    expect(await sourceBytes(root)).toEqual(before);

    await writeFile(join(root, '.vibe-spec.json'), JSON.stringify({ planning_root: '.', export_directory: '설정 결과' }) + '\n');
    const configuredBefore = await sourceBytes(root);
    for (const [args, expected] of [
      [[], join(root, '설정 결과')],
      [['--output', '../명시 상대 결과'], join(directory, '명시 상대 결과')],
      [['--output', join(directory, '명시 절대 결과')], join(directory, '명시 절대 결과')],
    ] as const) {
      const result = cli<MarkdownExport>(root, cwd, ['export', ...args]);
      expect(result).toMatchObject({ status: 0, reply: { ok: true, revision, data: { directory: expected, revision } } });
      expect(await readFile(join(expected, 'offers.md'), 'utf8')).toBe(markdown);
      expect(await sourceBytes(root)).toEqual(configuredBefore);
    }
  });

  it('returns exit 2 for an existing ordinary Markdown file and protected source output without changing either', async () => {
    const { directory, root, cwd } = await planning();
    const output = join(directory, '사람이 쓴 문서');
    await mkdir(output);
    const handwritten = '# My notes\r\nKeep these bytes.\r\n';
    await writeFile(join(output, 'offers.md'), handwritten);
    const before = await sourceBytes(root);
    expect(cli(root, cwd, ['export', '--output', output])).toMatchObject({ status: 2, reply: {
      ok: false, data: null, error: { code: 'EXPORT_CONFLICT' },
    } });
    expect(await readdir(output)).toEqual(['offers.md']);
    expect(await readFile(join(output, 'offers.md'), 'utf8')).toBe(handwritten);
    expect(cli(root, cwd, ['export', '--output', 'tables'])).toMatchObject({ status: 2, reply: {
      ok: false, data: null, error: { code: 'EXPORT_PATH' },
    } });
    expect(await sourceBytes(root)).toEqual(before);
  });

  it('creates readable exports while retaining core value diagnostics and exit 1 in JSON and plain output', async () => {
    const { root, cwd } = await planning();
    const file = join(root, 'tables/offers.yaml');
    await writeFile(file, (await readFile(file, 'utf8'))
      .replace('"currency_gold"', '"missing_target"').replace('"+001.2300E+0002"', '"-001.2300E+0002"'));
    const before = await sourceBytes(root);
    const validation = cli(root, cwd, ['validate']);
    expect(validation.status).toBe(1);
    expect(validation.reply.diagnostics).toHaveLength(2);
    const exported = cli<MarkdownExport>(root, cwd, ['export']);
    expect(exported).toMatchObject({ status: 1, reply: { ok: false, revision: validation.reply.revision,
      diagnostics: validation.reply.diagnostics, data: {
        files: ['items.md', 'offers.md', '보상 표.md'], diagnostics: validation.reply.diagnostics,
      },
    } });
    expect(exported.reply.error).toBeUndefined();
    const markdown = await readFile(join(exported.reply.data.directory, 'offers.md'), 'utf8');
    expect(markdown).toContain('Validation errors: 2 in this table/schema; 2 in the project.');
    expect(markdown).toContain('missing&#95;target');
    expect(markdown).toContain('-001.2300E+0002');
    const plain = run(root, cwd, ['export']);
    expect(plain.status).toBe(1);
    expect(JSON.parse(plain.stdout)).toEqual(exported.reply.data);
    for (const diagnostic of validation.reply.diagnostics) {
      expect(plain.stderr).toContain(`${diagnostic.file} ${diagnostic.path}: ${diagnostic.code}: ${diagnostic.message}`);
    }
    expect(await sourceBytes(root)).toEqual(before);
  });

  it('documents export and limits --output to that command with JSON argument errors', async () => {
    const { root, cwd } = await planning();
    expect(cli<{ usage: string }>(root, cwd, ['--help']).reply.data.usage)
      .toContain('vibe export [--output <folder>] [--project <folder>] [--json]');
    for (const args of [['read', 'offers'], ['validate'], ['fmt']]) {
      expect(cli(root, cwd, [...args, '--output', 'unwanted'])).toMatchObject({ status: 2, reply: {
        ok: false, error: { code: 'INVALID_ARGUMENT', message: '--output is only available for export.' },
      } });
    }
    expect(cli(root, cwd, ['export', 'extra'])).toMatchObject({ status: 2, reply: {
      ok: false, error: { code: 'INVALID_ARGUMENT' },
    } });
    expect(await readdir(root)).not.toContain('unwanted');
    expect(await readdir(root)).not.toContain('.vibe-spec-export');
  });
});
