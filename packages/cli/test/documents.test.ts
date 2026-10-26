import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic, DocumentOperation, DocumentSummary, DocumentView, Usages } from '@vibe-spec/core';
import { afterEach, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const roots: string[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2sAAAAASUVORK5CYII=', 'base64');
interface Reply<T = unknown> {
  ok: boolean;
  revision: string | null;
  target?: string;
  data: T;
  diagnostics: Diagnostic[];
  error?: { code: string; message: string };
}
function cli<T = unknown>(root: string, args: string[], cwd = root) {
  const result = spawnSync(process.execPath, [entry, ...args, '--project', root, '--json'], {
    cwd, encoding: 'utf8', timeout: process.platform === 'win32' ? 60_000 : 15_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  const reply = JSON.parse(result.stdout) as Reply<T>;
  expect(reply).toMatchObject({ ok: expect.any(Boolean), diagnostics: expect.any(Array) });
  expect(reply).toHaveProperty('data');
  expect(reply).toHaveProperty('revision');
  return { status: result.status, reply };
}
async function planning() {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-cli-documents-'));
  roots.push(directory);
  const root = join(directory, 'planning');
  const initialized = spawnSync(process.execPath, [entry, 'init', root, '--json'], {
    cwd: directory, encoding: 'utf8', timeout: 15_000,
  });
  expect(initialized.status, initialized.stdout + initialized.stderr).toBe(0);
  return root;
}
function revision(root: string) {
  const result = cli(root, ['validate']);
  expect(result.reply.revision).toMatch(/^[a-f0-9]{64}$/);
  return result.reply.revision!;
}
function write<T = unknown>(root: string, args: string[], expected = revision(root), dryRun = false) {
  return cli<T>(root, [...args, '--target', 'base', '--expect-revision', expected, ...(dryRun ? ['--dry-run'] : [])]);
}
async function input(root: string, text: string, name = 'input.md') {
  const path = join(dirname(root), name);
  await writeFile(path, text, 'utf8');
  return path;
}
async function create(root: string, name: string, source: string) {
  return write(root, ['document', 'create', name, '--input', await input(root, source)]);
}
async function edit(root: string, name: string, operations: DocumentOperation[], expected = revision(root), dryRun = false) {
  const path = await input(root, '\uFEFF' + JSON.stringify(operations), 'operations.json');
  return write(root, ['document', 'edit', name, '--input', path], expected, dryRun);
}
function view(root: string, name: string) {
  const result = cli<DocumentView>(root, ['document', 'read', name]);
  expect(result.status, JSON.stringify(result.reply)).toBe(0);
  expect(result.reply.target).toBe('base');
  expect(result.reply.data.revision).toBe(result.reply.revision);
  return result.reply.data;
}
async function documentBytes(root: string, name: string) {
  return readFile(join(root, 'documents', name + '.md'));
}
async function documentFiles(root: string) {
  try { return (await readdir(join(root, 'documents'))).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('document commands in actual CLI processes', () => {
  it('preserves UTF-8 BOM, CRLF, whitespace and untouched block bytes through create/read/edit/fmt', async () => {
    const root = await planning();
    const source = '\uFEFF# 안내 😀\r\n\r\n바꿀 문단  \r\n둘째 줄\r\n\r\n\r\n- 그대로\r\n  - 중첩 😀\r\n\r\n끝  ';
    const path = await input(root, source);
    const before = revision(root);
    const preview = write(root, ['document', 'create', '안내', '--input', path], before, true);
    expect(preview).toMatchObject({ status: 0, reply: { revision: before, target: 'base', data: {
      applied: false, changed: [], planned: ['documents/안내.md'], preview: { 'documents/안내.md': source },
    } } });
    expect(await documentFiles(root)).toEqual([]);
    expect(revision(root)).toBe(before);
    const created = write(root, ['document', 'create', '안내', '--input', path], before);
    expect(created).toMatchObject({ status: 0, reply: { data: { applied: true, changed: ['documents/안내.md'] } } });
    expect(await documentBytes(root, '안내')).toEqual(Buffer.from(source));
    expect(cli<DocumentSummary[]>(root, ['document', 'list']).reply.data).toEqual([
      { name: '안내', errors: 0, warnings: 0 },
    ]);
    const read = view(root, '안내');
    expect(read.source).toBe(source);
    const block = read.blocks.find(item => item.markdown.includes('바꿀 문단'))!;
    expect(block.index).toBe(1);
    expect(source.slice(block.start, block.end)).toBe(block.markdown);
    const replacement = '고친 문단 😀';
    const expected = Buffer.from(source.slice(0, block.start) + replacement + source.slice(block.end));
    const operations: DocumentOperation[] = [{ op: 'replace', block: block.index, markdown: replacement }];
    expect(await edit(root, '안내', operations, read.revision, true)).toMatchObject({ status: 0, reply: {
      revision: read.revision, data: { applied: false, changed: [], preview: { 'documents/안내.md': expected.toString('utf8') } },
    } });
    expect(await documentBytes(root, '안내')).toEqual(Buffer.from(source));
    expect(await edit(root, '안내', operations, read.revision)).toMatchObject({ status: 0, reply: { data: { applied: true } } });
    expect(await documentBytes(root, '안내')).toEqual(expected);
    const current = view(root, '안내');
    expect(await edit(root, '안내', [{ op: 'replace', block: 1, markdown: replacement }], current.revision))
      .toMatchObject({ status: 0, reply: { revision: current.revision, data: { changed: [] } } });
    for (const args of [['validate'], ['fmt', '--check'], ['fmt']]) {
      expect(cli(root, args)).toMatchObject({ status: 0, reply: { revision: current.revision, diagnostics: [] } });
      expect(await documentBytes(root, '안내')).toEqual(expected);
    }
    // --project works outside the planning folder as well.
    expect(cli<DocumentView>(root, ['document', 'read', '안내'], dirname(root)).reply.data.source).toBe(expected.toString('utf8'));
  });

  it('uses original zero-based indices for a batch, then previews and applies deletion', async () => {
    const root = await planning();
    expect((await create(root, 'guide', '# Guide\n\nFirst\n\nSecond\n\nThird\n')).status).toBe(0);
    const before = view(root, 'guide');
    expect(await edit(root, 'guide', [
      { op: 'replace', block: 1, markdown: 'Changed' },
      { op: 'insert', before: 2, markdown: 'Inserted' },
      { op: 'delete', block: 3 },
    ], before.revision)).toMatchObject({ status: 0 });
    const after = view(root, 'guide');
    expect(after.blocks.map(block => block.markdown)).toEqual(['# Guide', 'Changed', 'Inserted', 'Second']);
    expect(await edit(root, 'guide', [{ op: 'insert', before: after.blocks.length, markdown: 'Last' }], after.revision))
      .toMatchObject({ status: 0 });
    expect(view(root, 'guide').blocks.at(-1)?.markdown).toBe('Last');
    const bytes = await documentBytes(root, 'guide');
    const current = revision(root);
    expect(write(root, ['document', 'delete', 'guide'], current, true)).toMatchObject({ status: 0, reply: {
      revision: current, data: { applied: false, changed: [], planned: ['documents/guide.md'], preview: { 'documents/guide.md': null } },
    } });
    expect(await documentBytes(root, 'guide')).toEqual(bytes);
    expect(write(root, ['document', 'delete', 'guide'], current)).toMatchObject({ status: 0, reply: {
      data: { applied: true, changed: ['documents/guide.md'] },
    } });
    expect(cli(root, ['document', 'list']).reply.data).toEqual([]);
    expect(cli(root, ['document', 'read', 'guide']).status).toBe(2);
  });

  it('reads sections and tags and renames table, Key, document, heading and tag link destinations only', async () => {
    const root = await planning();
    await writeFile(join(root, 'schemas/items.yaml'), 'primary_key: key\ncolumns:\n  key: { type: string }\n  price: { type: decimal }\n');
    await writeFile(join(root, 'tables/items.yaml'), 'schema: items\nrows:\n  - { key: "gold", price: "00042.0000" }\n');
    expect((await create(root, 'economy', '# Coins\n\n### Earn\n\n<!-- name: note -->\nEarn coins here.\n')).status).toBe(0);
    const original = '\uFEFF# Links\r\n\r\n[**price**](items/gold/price "price title")  \r\n[earn](<economy/Coins/Earn>)\r\n[note](<economy/Coins/Earn/note>)\r\n[whole](economy)\r\n\r\nPlain items/gold/price and economy/Coins/Earn.\r\n\r\n`items/gold/price`\r\n';
    expect((await create(root, 'links', original)).status).toBe(0);
    for (const path of ['economy', 'economy/Coins/Earn', 'economy/Coins/Earn/note']) {
      const read = cli(root, ['read', path, '--target', 'base']);
      expect(read.status, JSON.stringify(read.reply)).toBe(0);
      expect(JSON.stringify(read.reply.data)).toContain('Earn coins here.');
    }
    const usages = cli<Usages>(root, ['where-used', 'items/gold/price']);
    expect(usages.status).toBe(0);
    expect(usages.reply.data.references).toContainEqual(expect.objectContaining({ file: 'documents/links.md' }));
    expect(usages.reply.data.candidates).toContainEqual(expect.objectContaining({ file: 'documents/links.md' }));
    for (const [kind, from, to] of [
      ['key', 'items/gold', 'coin'], ['table', 'items', 'goods'],
      ['heading', 'economy/Coins/Earn', 'Get coins'], ['tag', 'economy/Coins/Get coins/note', 'details'],
      ['document', 'economy', 'balance'],
    ]) {
      const result = write(root, ['rename', kind!, from!, '--to', to!]);
      expect(result.status, JSON.stringify(result.reply)).toBe(0);
    }
    const expected = original
      .replace('](items/gold/price "price title")', '](goods/coin/price "price title")')
      .replace('](<economy/Coins/Earn>)', '](<balance/Coins/Get coins>)')
      .replace('](<economy/Coins/Earn/note>)', '](<balance/Coins/Get coins/details>)')
      .replace('](economy)', '](balance)');
    expect(await documentBytes(root, 'links')).toEqual(Buffer.from(expected));
    expect(cli(root, ['read', 'goods/coin/price']).reply.data).toEqual({ value: '00042.0000', present: true });
    expect(cli(root, ['read', 'balance/Coins/Get coins/details']).status).toBe(0);
    expect(await documentFiles(root)).toEqual(['balance.md', 'links.md']);
    expect(cli(root, ['validate']).status).toBe(0);
  }, 60_000);

  it('rejects stale document creation, editing, deletion and image insertion without overwriting external bytes', async () => {
    const root = await planning();
    expect((await create(root, 'guide', '# Guide\n\nOriginal\n')).status).toBe(0);
    const stale = view(root, 'guide').revision;
    const source = '\uFEFF# Guide\r\n\r\nExternal 😀  ';
    await writeFile(join(root, 'documents/guide.md'), source);
    const current = revision(root);
    expect(current).not.toBe(stale);
    const markdown = await input(root, '# New\n');
    const operations = await input(root, '[{"op":"replace","block":1,"markdown":"Overwrite"}]', 'operations.json');
    const image = join(dirname(root), 'diagram.png');
    await writeFile(image, png);
    for (const args of [
      ['document', 'create', 'new', '--input', markdown],
      ['document', 'edit', 'guide', '--input', operations],
      ['document', 'delete', 'guide'], ['document', 'image', image],
    ]) {
      expect(write(root, args, stale)).toMatchObject({ status: 2, reply: {
        revision: current, data: { applied: false, changed: [] }, error: { code: 'STALE_REVISION' },
      } });
      expect(await documentBytes(root, 'guide')).toEqual(Buffer.from(source));
      expect(await documentFiles(root)).toEqual(['guide.md']);
    }
  });

  it('reports broken document links after deletion and fmt preserves the remaining document', async () => {
    const root = await planning();
    expect((await create(root, 'target', '# Target\n')).status).toBe(0);
    const source = '\uFEFF# Links\r\n\r\n[Target](target/Target)  ';
    expect((await create(root, 'links', source)).status).toBe(0);
    const deleted = write(root, ['document', 'delete', 'target']);
    expect(deleted).toMatchObject({ status: 1, reply: { ok: false, data: { applied: true } } });
    expect(deleted.reply.diagnostics).toContainEqual(expect.objectContaining({ file: 'documents/links.md' }));
    for (const args of [['validate'], ['fmt', '--check'], ['fmt']]) {
      expect(cli(root, args)).toMatchObject({ status: 1, reply: { diagnostics: deleted.reply.diagnostics } });
      expect(await documentBytes(root, 'links')).toEqual(Buffer.from(source));
    }
  });

  it('previews image insertion, copies bytes and returns a usable local Markdown path', async () => {
    const root = await planning();
    const path = join(dirname(root), 'diagram.png');
    await writeFile(path, png);
    const before = revision(root);
    const preview = write<{ path: string }>(root, ['document', 'image', path], before, true);
    expect(preview).toMatchObject({ status: 0, reply: { revision: before, data: { applied: false, path: expect.stringMatching(/^assets\/[^/]+\.png$/) } } });
    expect(await documentFiles(root)).toEqual([]);
    expect(revision(root)).toBe(before);
    const inserted = write<{ path: string; revision: string }>(root, ['document', 'image', path], before);
    expect(inserted).toMatchObject({ status: 0, reply: { data: { applied: true, path: preview.reply.data.path } } });
    expect(inserted.reply.revision).not.toBe(before);
    expect(inserted.reply.data.revision).toBe(inserted.reply.revision);
    expect(await readFile(join(root, 'documents', inserted.reply.data.path))).toEqual(png);
    expect((await create(root, 'images', '# Images\n\n![diagram](' + inserted.reply.data.path + ')\n')).status).toBe(0);
    expect(view(root, 'images').links).toContainEqual(expect.objectContaining({ kind: 'image', destination: inserted.reply.data.path }));
    expect(cli(root, ['validate']).status).toBe(0);
  });

  it('requires an explicit target and revision, and keeps non-edit document writes on base', async () => {
    const root = await planning();
    const markdown = await input(root, '# Guide\n');
    const operations = await input(root, '[]', 'operations.json');
    const current = revision(root);
    for (const args of [
      ['document', 'create', 'guide', '--input', markdown],
      ['document', 'edit', 'guide', '--input', operations], ['document', 'delete', 'guide'],
      ['document', 'image', markdown],
      ['rename', 'document', 'guide', '--to', 'new'], ['rename', 'heading', 'guide/Title', '--to', 'New'],
      ['rename', 'tag', 'guide/tag', '--to', 'new'],
    ]) {
      expect(cli(root, [...args, '--expect-revision', current])).toMatchObject({ status: 2, reply: {
        data: { applied: false, changed: [] }, error: { code: 'TARGET_REQUIRED' },
      } });
      expect(cli(root, [...args, '--target', 'base'])).toMatchObject({ status: 2, reply: { error: { code: 'REVISION_REQUIRED' } } });
      expect(cli(root, [...args, '--target', 'review/A', '--expect-revision', current])).toMatchObject({ status: 2, reply: { error: { code: args[0] === 'document' && args[1] === 'edit' ? 'PATH_NOT_FOUND' : 'INVALID_ARGUMENT' } } });
    }
    expect(await documentFiles(root)).toEqual([]);
    expect(revision(root)).toBe(current);
  }, 60_000);

  it('rejects unsupported document arguments and malformed edit input without changing the document', async () => {
    const root = await planning();
    const source = '# Guide\n\nKeep me.\n';
    expect((await create(root, 'guide', source)).status).toBe(0);
    const current = revision(root);
    for (const args of [
      ['document'], ['document', 'unknown'], ['document', 'read'], ['document', 'list', 'extra'],
      ['document', 'list', '--dry-run'], ['document', 'read', 'guide', '--check'],
      ['document', 'read', 'guide', '--input', 'ignored'], ['document', 'list', '--to', 'ignored'],
      ['document', 'list', '--expect-revision', current], ['document', 'list', '--target', 'review/A'],
      ['document', 'create', 'new', '--target', 'base', '--expect-revision', current],
      ['document', 'delete', 'guide', '--input', 'ignored', '--target', 'base', '--expect-revision', current],
    ]) {
      expect(cli(root, args)).toMatchObject({ status: 2, reply: { error: { code: 'INVALID_ARGUMENT' } } });
    }
    for (const text of ['{broken', '{}', '{"op":"delete","block":1}', '[{"op":"delete","block":-1}]', '[{"op":"replace","block":99,"markdown":"No"}]']) {
      const path = await input(root, text, 'bad.json');
      expect(write(root, ['document', 'edit', 'guide', '--input', path], current)).toMatchObject({
        status: 2, reply: { data: { applied: false, changed: [] }, error: expect.any(Object) },
      });
      expect(await documentBytes(root, 'guide')).toEqual(Buffer.from(source));
    }
    const invalidUtf8 = join(dirname(root), 'invalid.md');
    await writeFile(invalidUtf8, Buffer.from([0x23, 0x20, 0xc3, 0x28]));
    expect(write(root, ['document', 'create', 'invalid', '--input', invalidUtf8], current)).toMatchObject({
      status: 2, reply: { data: { applied: false, changed: [] }, error: { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' } },
    });
    expect(await documentFiles(root)).toEqual(['guide.md']);
    expect(revision(root)).toBe(current);
  }, 60_000);

  it('initializes document guidance and saves Markdown and local images with the CLI in a temporary Git repository', async () => {
    const root = await planning();
    const instructions = await readFile(join(root, 'AGENTS.md'), 'utf8');
    for (const command of ['document list', 'document read', 'document create', 'document edit', 'document delete', 'document image', 'rename heading', 'rename tag']) {
      expect(instructions).toContain(command);
    }
    expect(instructions).toContain('전체 Markdown');
    expect(instructions).toContain('그 revision 안에서만 유효');
    const source = '\uFEFF# Guide\r\n\r\nKept exactly.  ';
    expect((await create(root, 'guide', source)).status).toBe(0);
    const path = join(dirname(root), 'diagram.png');
    await writeFile(path, png);
    const image = write<{ path: string }>(root, ['document', 'image', path]);
    expect(image.status).toBe(0);
    const config = join(dirname(root), 'empty.gitconfig');
    await writeFile(config, '');
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config };
    function git(args: string[]) {
      const result = spawnSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8', timeout: 15_000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    }
    git(['init', '--initial-branch=main']);
    git(['config', 'user.name', 'Document CLI Test']);
    git(['config', 'user.email', 'documents@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['config', 'core.autocrlf', 'true']);
    // Set a repository-local empty hook directory, independent of user hooks.
    git(['config', 'core.hooksPath', dirname(root)]);
    expect(cli(root, ['save', '--reason', 'Document fixture'])).toMatchObject({ status: 0, reply: { data: { completed: true } } });
    expect(git(['ls-files']).split('\n')).toEqual(expect.arrayContaining(['documents/guide.md', 'documents/' + image.reply.data.path]));
    expect(Buffer.from(git(['show', 'HEAD:documents/guide.md']))).toEqual(Buffer.from(source));
    expect(await readFile(join(root, 'documents', image.reply.data.path))).toEqual(png);
    expect(await documentBytes(root, 'guide')).toEqual(Buffer.from(source));
  });
});

it('previews document rename and all destination edits without writing', async () => {
  const root = await planning();
  await create(root, '기준', '# 제목');
  await create(root, '연결', '[보기](기준/제목)');
  const expected = revision(root);
  const preview = write<{ applied: boolean; planned: string[] }>(root,
    ['rename', 'document', '기준', '--to', '새 문서'], expected, true);
  expect(preview.status).toBe(0);
  expect(preview.reply.data.applied).toBe(false);
  expect(preview.reply.data.planned).toContain('documents/연결.md');
  expect(revision(root)).toBe(expected);
  expect((await documentBytes(root, '연결')).toString()).toBe('[보기](기준/제목)');
}, process.platform === 'win32' ? 60_000 : 20_000);
