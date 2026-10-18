import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic, EditOperation, GitChoice, GitResult, GitStatus } from '@vibe-spec/core';
import { afterEach, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const roots: string[] = [];
const env: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no',
};
interface Reply<T = unknown> {
  ok: boolean;
  revision: string | null;
  data: T;
  diagnostics: Diagnostic[];
  error?: { code: string; message: string };
}
function processResult(binary: string, args: string[], cwd: string) {
  // One CLI save runs several native Git commands (each with a 30s bound).
  // Windows CI must not kill the whole CLI before that product bound expires.
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: process.platform === 'win32' ? 60_000 : 15_000 });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return result;
}
function git(cwd: string, args: string[]) {
  const result = processResult('git', args, cwd);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function cli<T = unknown>(root: string, args: string[], cwd = root) {
  const result = processResult(process.execPath, [entry, ...args, '--project', root, '--json'], cwd);
  expect(result.stderr).toBe('');
  const reply = JSON.parse(result.stdout) as Reply<T>;
  expect(reply).toMatchObject({ ok: expect.any(Boolean), diagnostics: expect.any(Array) });
  expect(reply).toHaveProperty('revision');
  expect(reply).toHaveProperty('data');
  return { status: result.status, reply };
}
function success(root: string, args: string[], action: GitResult['action']) {
  const result = cli<GitResult>(root, args);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 0, reply: {
    ok: true, diagnostics: [], data: { action, completed: true },
  } });
  expect(result.reply.revision).toBe(result.reply.data.status.revision);
  return result.reply.data;
}
function current(root: string) {
  const result = cli<GitStatus>(root, ['status']);
  expect(result.reply.data.revision).toBe(result.reply.revision);
  return result.reply.data;
}
function configure(repository: string, autocrlf = false) {
  git(repository, ['config', 'user.name', 'Vibe Git E2E']);
  git(repository, ['config', 'user.email', 'git-e2e@example.invalid']);
  git(repository, ['config', 'commit.gpgsign', 'false']);
  git(repository, ['config', 'tag.gpgsign', 'false']);
  git(repository, ['config', 'core.autocrlf', String(autocrlf)]);
}
async function setup(nested = false, autocrlf = false) {
  const directory = await mkdtemp(join(tmpdir(), 'vibe CLI Git 한글 '));
  roots.push(directory);
  // Git for Windows rejects node:os.devNull as a config path. Each scenario
  // uses a real empty file before starting any Git or CLI process.
  const globalConfig = join(directory, 'empty.gitconfig');
  await writeFile(globalConfig, '');
  env.GIT_CONFIG_GLOBAL = globalConfig;
  const remote = join(directory, 'remote.git');
  const a = join(directory, 'alice');
  const b = join(directory, 'bob');
  git(directory, ['init', '--bare', '--initial-branch=main', remote]);
  git(directory, ['clone', remote, a]);
  configure(a, autocrlf);
  const first = nested ? join(a, 'planning') : a;
  const second = nested ? join(b, 'planning') : b;
  const initialized = processResult(process.execPath, [entry, 'init', first, '--json'], directory);
  expect(initialized.status, initialized.stdout).toBe(0);
  await writeFile(join(first, 'schemas/items.yaml'), [
    'primary_key: key', 'columns:', '  key: { type: string }',
    '  name: { type: string, required: true }', '  note: { type: text }',
    '  amount: { type: decimal }', '',
  ].join('\n'));
  await writeFile(join(first, 'schemas/offers.yaml'), [
    'primary_key: key', 'columns:', '  key: { type: string }',
    '  item: { type: ref, table: items }', '',
  ].join('\n'));
  // Adjacent flow rows deliberately make independent row edits conflict textually.
  await writeFile(join(first, 'tables/items.yaml'), [
    'schema: items', 'rows:',
    '  - { key: "alpha", name: "Alpha", note: "base", amount: "+001.2300E+0002" }',
    '  - { key: "beta", name: "Beta", note: "base", amount: "900719925474099312345" }', '',
  ].join('\n'));
  await writeFile(join(first, 'tables/offers.yaml'), 'schema: offers\nrows:\n  - { key: "original", item: "alpha" }\n');
  const initialRevision = current(first).revision;
  const saved = success(first, ['save', '--reason', 'Initial planning reason', '--expect-revision', initialRevision], 'save');
  const pushed = success(first, ['push'], 'push');
  git(directory, ['-c', 'core.autocrlf=' + autocrlf, 'clone', remote, b]);
  configure(b, autocrlf);
  return { directory, remote, a, b, first, second, saved, pushed };
}
async function edit(directory: string, root: string, operation: EditOperation, expectedStatus = 0) {
  const input = join(directory, 'edit.json');
  await writeFile(input, JSON.stringify(operation));
  const revision = cli(root, ['read', operation.table]).reply.revision!;
  const result = cli(root, ['edit', '--input', input, '--expect-revision', revision]);
  expect(result, JSON.stringify(result)).toMatchObject({ status: expectedStatus, reply: { data: { applied: true } } });
  return result;
}
async function update(directory: string, root: string, key: string, values: Record<string, string>) {
  return edit(directory, root, { op: 'update', table: 'items', key, values });
}
function cell(root: string, path: string, expectedStatus = 0) {
  const result = cli<{ value: unknown; present: boolean }>(root, ['read', path]);
  expect(result.status).toBe(expectedStatus);
  return result.reply.data.value;
}
async function choicesFile(directory: string, choices: GitChoice[], bom = false) {
  const input = join(directory, 'choices.json');
  await writeFile(input, (bom ? '\uFEFF' : '') + JSON.stringify(choices));
  return input;
}
async function conflict() {
  const fixture = await setup();
  const { directory, first, second } = fixture;
  await update(directory, first, 'alpha', { name: 'Theirs' });
  success(first, ['save', '--reason', 'Remote name'], 'save');
  success(first, ['push'], 'push');
  await update(directory, second, 'alpha', { name: 'Ours' });
  success(second, ['save', '--reason', 'Local name'], 'save');
  const pulled = cli<GitResult>(second, ['pull']);
  expect(pulled).toMatchObject({ status: 1, reply: { ok: false, data: {
    action: 'pull', completed: false, status: { state: 'conflict', mergeInProgress: true },
  } } });
  expect(pulled.reply.data.status.conflicts).toContainEqual(expect.objectContaining({
    kind: 'row', file: 'tables/items.yaml', table: 'items', key: 'alpha',
    base: expect.objectContaining({ name: 'Alpha' }),
    ours: expect.objectContaining({ name: 'Ours' }),
    theirs: expect.objectContaining({ name: 'Theirs' }),
  }));
  expect(pulled.reply.revision).toBe(pulled.reply.data.status.revision);
  return { ...fixture, pulled: pulled.reply.data };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Git through actual CLI processes and two clones', { timeout: process.platform === 'win32' ? 120_000 : 60_000 }, () => {
  it.each([false, true])('keeps source bytes and revisions identical across local clones with autocrlf=%s', async autocrlf => {
    const { directory, first, second } = await setup(false, autocrlf);
    const managed = ['.agents/skills/vibe-import/SKILL.md', '.gitattributes', '.gitignore', '.vibe-spec.json', 'AGENTS.md',
      'schemas/items.yaml', 'schemas/offers.yaml', 'tables/items.yaml', 'tables/offers.yaml'];
    expect(git(second, ['ls-files', '--', '.gitattributes'])).toBe('.gitattributes');
    for (const file of managed) {
      const source = await readFile(join(first, file));
      expect(source.includes(13), file).toBe(false);
      expect(await readFile(join(second, file)), file).toEqual(source);
    }
    expect(cli(first, ['read', 'items']).reply.revision).toBe(cli(second, ['read', 'items']).reply.revision);
    expect(cli(second, ['fmt']).status).toBe(0);
    success(second, ['save', '--reason', 'Format sources'], 'save');
    success(second, ['push'], 'push');
    success(first, ['pull'], 'pull');
    const before = await readFile(join(second, 'tables/items.yaml'), 'utf8');
    await update(directory, second, 'alpha', { amount: '-000.45000e+001' });
    expect(await readFile(join(second, 'tables/items.yaml'), 'utf8'))
      .toBe(before.replace('"+001.2300E+0002"', '"-000.45000e+001"'));
    success(second, ['save', '--reason', 'One numeric cell'], 'save');
    success(second, ['push'], 'push');
    success(first, ['pull'], 'pull');
    for (const file of managed) {
      const source = await readFile(join(second, file));
      expect(source.includes(13), file).toBe(false);
      expect(await readFile(join(first, file)), file).toEqual(source);
    }
    expect(cli(first, ['read', 'items']).reply.revision).toBe(cli(second, ['read', 'items']).reply.revision);
    expect(cli(first, ['fmt', '--check'])).toMatchObject({ status: 0, reply: { data: { changed: [] } } });
    expect(git(first, ['status', '--porcelain'])).toBe('');
    expect(git(second, ['status', '--porcelain'])).toBe('');
  });

  it('saves the initial reason, establishes upstream on first push, and pulls into the other clone', async () => {
    const { directory, first, second, saved, pushed } = await setup();
    expect(saved.commit).toBe(git(first, ['rev-parse', 'HEAD']));
    expect(saved.status).toMatchObject({ state: 'unpublished', conflicts: [] });
    expect(git(first, ['log', '-1', '--format=%B'])).toBe('Initial planning reason');
    expect(git(first, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/main');
    expect(pushed.status).toMatchObject({ state: 'published', ahead: 0, behind: 0 });
    await update(directory, first, 'alpha', { amount: '-000.45000e+001' });
    expect(current(first).state).toBe('unsaved');
    const next = success(first, ['save', '--reason', 'Keep decimal spelling'], 'save');
    expect(next.commit).not.toBe(saved.commit);
    success(first, ['push'], 'push');
    const pulled = success(second, ['pull'], 'pull');
    expect(pulled.status).toMatchObject({ state: 'published', conflicts: [] });
    expect(cell(second, 'items/alpha/amount')).toBe('-000.45000e+001');
    expect(cell(second, 'items/beta/amount')).toBe('900719925474099312345');
    expect(git(second, ['rev-parse', 'HEAD'])).toBe(next.commit);
    // Common --project works even when cwd is outside both repositories.
    expect(cli<GitStatus>(first, ['status'], directory)).toMatchObject({ status: 0, reply: {
      data: { state: 'published' },
    } });
  });

  it('merges different adjacent rows even when plain Git has a textual conflict', async () => {
    const { directory, first, second } = await setup();
    const base = join(directory, 'base.yaml');
    await writeFile(base, await readFile(join(first, 'tables/items.yaml')));
    await update(directory, first, 'alpha', { note: 'remote row' });
    success(first, ['save', '--reason', 'Edit alpha'], 'save');
    success(first, ['push'], 'push');
    await update(directory, second, 'beta', { note: 'local row' });
    success(second, ['save', '--reason', 'Edit beta'], 'save');
    const textual = processResult('git', ['merge-file', '-p', join(second, 'tables/items.yaml'), base,
      join(first, 'tables/items.yaml')], directory);
    expect(textual.status).toBe(1);
    expect(textual.stdout).toContain('<<<<<<<');
    const merged = success(second, ['pull'], 'pull');
    expect(merged.status).toMatchObject({ conflicts: [], mergeInProgress: false });
    expect(cell(second, 'items/alpha/note')).toBe('remote row');
    expect(cell(second, 'items/beta/note')).toBe('local row');
    expect(git(second, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
    success(second, ['push'], 'push');
    success(first, ['pull'], 'pull');
    expect(cell(first, 'items/beta/note')).toBe('local row');
  });

  it('automatically merges separate fields of the same row', async () => {
    const { directory, first, second } = await setup();
    await update(directory, first, 'alpha', { name: 'Remote name' });
    success(first, ['save', '--reason', 'Name'], 'save');
    success(first, ['push'], 'push');
    await update(directory, second, 'alpha', { amount: '000.0001200' });
    success(second, ['save', '--reason', 'Amount'], 'save');
    expect(success(second, ['pull'], 'pull').status.conflicts).toEqual([]);
    expect(cell(second, 'items/alpha/name')).toBe('Remote name');
    expect(cell(second, 'items/alpha/amount')).toBe('000.0001200');
  });

  it.each([
    ['base', 'Alpha'], ['ours', 'Ours'], ['theirs', 'Theirs'],
  ] as const)('resolves the same cell using %s and completes a validated merge', async (choice, expected) => {
    const { directory, second, pulled } = await conflict();
    const input = await choicesFile(directory, [{ file: 'tables/items.yaml', key: 'alpha', choice }], choice === 'ours');
    const resolved = success(second, ['pull', '--resolve', input, '--expect-revision', pulled.status.revision], 'resolve');
    expect(resolved.status).toMatchObject({ conflicts: [], mergeInProgress: false });
    expect(resolved.commit).toBe(git(second, ['rev-parse', 'HEAD']));
    expect(cell(second, 'items/alpha/name')).toBe(expected);
    expect(git(second, ['ls-files', '-u'])).toBe('');
    expect(cli(second, ['validate'])).toMatchObject({ status: 0, reply: { diagnostics: [] } });
  });

  it('retains completed merge data and reports REF_MISSING after a rename meets a new old-Key reference', async () => {
    const { directory, first, second } = await setup();
    const renamed = cli(first, ['rename', 'key', 'items/alpha', '--to', 'renamed',
      '--expect-revision', cli(first, ['read', 'items']).reply.revision!]);
    expect(renamed.status).toBe(0);
    success(first, ['save', '--reason', 'Rename alpha'], 'save');
    success(first, ['push'], 'push');
    await edit(directory, second, { op: 'create', table: 'offers', row: { key: 'new', item: 'alpha' } });
    success(second, ['save', '--reason', 'Add old-Key reference'], 'save');
    const merged = cli<GitResult>(second, ['pull']);
    expect(merged).toMatchObject({ status: 1, reply: { ok: false, data: {
      action: 'pull', completed: true, status: { conflicts: [], mergeInProgress: false },
    } } });
    expect(merged.reply.error).toBeUndefined();
    expect(merged.reply.diagnostics).toContainEqual(expect.objectContaining({ code: 'REF_MISSING', path: 'offers/new/item' }));
    expect(merged.reply.data.diagnostics).toEqual(merged.reply.diagnostics);
    expect(cell(second, 'offers/original/item', 1)).toBe('renamed');
    expect(cell(second, 'offers/new/item', 1)).toBe('alpha');
    expect(git(second, ['ls-files', '-u'])).toBe('');
    expect(cli(second, ['validate']).status).toBe(1);
  });

  it.each([false, true])('preserves staged and working changes outside save scope (nested root: %s)', async nested => {
    const { directory, a, first } = await setup(nested);
    const unrelated = join(a, 'outside.txt');
    const notes = join(first, 'notes.txt');
    await writeFile(unrelated, 'staged version\n');
    await writeFile(notes, 'project-local but unmanaged\n');
    git(a, ['add', '--', 'outside.txt', nested ? 'planning/notes.txt' : 'notes.txt']);
    await writeFile(unrelated, 'working version\n');
    const indexBefore = git(a, ['diff', '--cached', '--binary']);
    await update(directory, first, 'alpha', { name: 'Managed edit' });
    success(first, ['save', '--reason', 'Only planning data'], 'save');
    expect(git(a, ['show', '--format=', '--name-only', 'HEAD'])).toBe(nested ? 'planning/tables/items.yaml' : 'tables/items.yaml');
    expect(git(a, ['diff', '--cached', '--binary'])).toBe(indexBefore);
    expect(await readFile(unrelated, 'utf8')).toBe('working version\n');
    expect(await readFile(notes, 'utf8')).toBe('project-local but unmanaged\n');
    expect(current(first).otherChanges.length).toBeGreaterThan(0);
  });

  it('rejects empty reasons and stale saves without making a commit', async () => {
    const { directory, first } = await setup();
    const revision = current(first).revision;
    await update(directory, first, 'alpha', { name: 'Unsaved' });
    const head = git(first, ['rev-parse', 'HEAD']);
    for (const args of [['save'], ['save', '--reason', ''], ['save', '--reason', ' \n\t '],
      ['save', '--reason', 'Stale', '--expect-revision', revision]]) {
      expect(cli(first, args)).toMatchObject({ status: 2, reply: { ok: false, data: {
        action: 'save', completed: false,
      }, error: expect.any(Object) } });
      expect(git(first, ['rev-parse', 'HEAD'])).toBe(head);
    }
    expect(cell(first, 'items/alpha/name')).toBe('Unsaved');
  });

  it('keeps a successful save visible even when validation returns exit 1', async () => {
    const { directory, first } = await setup();
    await edit(directory, first, { op: 'create', table: 'offers', row: { key: 'invalid', item: 'missing' } }, 1);
    const saved = cli<GitResult>(first, ['save', '--reason', 'Save with diagnostics']);
    expect(saved).toMatchObject({ status: 1, reply: { ok: false, data: { action: 'save', completed: true } } });
    expect(saved.reply.error).toBeUndefined();
    expect(saved.reply.data.commit).toBe(git(first, ['rev-parse', 'HEAD']));
    expect(saved.reply.data.diagnostics).toEqual(saved.reply.diagnostics);
    expect(saved.reply.diagnostics).toContainEqual(expect.objectContaining({ code: 'REF_MISSING' }));
  });

  it('keeps successful resolution data when the chosen row still has validation errors', async () => {
    const { directory, first, second } = await setup();
    await edit(directory, first, { op: 'update', table: 'offers', key: 'original', values: { item: 'beta' } });
    success(first, ['save', '--reason', 'Valid remote reference'], 'save');
    success(first, ['push'], 'push');
    await edit(directory, second, { op: 'update', table: 'offers', key: 'original', values: { item: 'missing' } }, 1);
    expect(cli<GitResult>(second, ['save', '--reason', 'Local reference to review']))
      .toMatchObject({ status: 1, reply: { data: { action: 'save', completed: true } } });
    const pulled = cli<GitResult>(second, ['pull']);
    expect(pulled).toMatchObject({ status: 1, reply: { data: { action: 'pull', completed: false } } });
    const input = await choicesFile(directory, [{ file: 'tables/offers.yaml', key: 'original', choice: 'ours' }]);
    const resolved = cli<GitResult>(second, ['pull', '--resolve', input, '--expect-revision', pulled.reply.revision!]);
    expect(resolved).toMatchObject({ status: 1, reply: { ok: false, data: {
      action: 'resolve', completed: true, status: { conflicts: [], mergeInProgress: false },
    } } });
    expect(resolved.reply.error).toBeUndefined();
    expect(resolved.reply.data.commit).toBe(git(second, ['rev-parse', 'HEAD']));
    expect(resolved.reply.data.diagnostics).toEqual(resolved.reply.diagnostics);
    expect(resolved.reply.diagnostics).toContainEqual(expect.objectContaining({ code: 'REF_MISSING' }));
    expect(cell(second, 'offers/original/item', 1)).toBe('missing');
  });

  it('rejects force and non-fast-forward push while preserving both local and remote commits', async () => {
    const { directory, remote, first, second } = await setup();
    await update(directory, first, 'alpha', { name: 'Remote commit' });
    success(first, ['save', '--reason', 'Remote advance'], 'save');
    success(first, ['push'], 'push');
    const remoteHead = git(remote, ['rev-parse', 'main']);
    await update(directory, second, 'beta', { name: 'Local commit' });
    const local = success(second, ['save', '--reason', 'Local advance'], 'save');
    for (const args of [['push', '--force'], ['push']]) {
      expect(cli(second, args)).toMatchObject({ status: 2, reply: { ok: false,
        data: { action: 'push', completed: false }, error: expect.any(Object),
      } });
      expect(git(second, ['rev-parse', 'HEAD'])).toBe(local.commit);
      expect(git(remote, ['rev-parse', 'main'])).toBe(remoteHead);
      expect(git(second, ['log', '-1', '--format=%B'])).toBe('Local advance');
    }
  });

  it.each(['missing remote', 'rejected hook'] as const)('reports %s upload failure without losing the saved commit', async failure => {
    const { directory, remote, first } = await setup();
    const remoteHead = git(remote, ['rev-parse', 'main']);
    await update(directory, first, 'alpha', { note: 'Saved locally' });
    const saved = success(first, ['save', '--reason', 'Keep local save'], 'save');
    if (failure === 'missing remote') git(first, ['remote', 'set-url', 'origin', join(directory, 'missing.git')]);
    else {
      const hook = join(remote, 'hooks/pre-receive');
      await writeFile(hook, '#!/bin/sh\necho "Upload denied by fixture" >&2\nexit 1\n');
      // Git for Windows runs this LF shell hook with its bundled sh; chmod only
      // controls executable permission on POSIX filesystems.
      if (process.platform !== 'win32') await chmod(hook, 0o755);
    }
    const pushed = cli<GitResult>(first, ['push']);
    expect(pushed).toMatchObject({ status: 2, reply: { ok: false, data: {
      action: 'push', completed: false,
    }, error: expect.any(Object) } });
    if (failure === 'rejected hook') expect(pushed.reply.error?.message).toContain('Upload denied by fixture');
    expect(git(first, ['rev-parse', 'HEAD'])).toBe(saved.commit);
    expect(git(remote, ['rev-parse', 'main'])).toBe(remoteHead);
    expect(cell(first, 'items/alpha/note')).toBe('Saved locally');
  });

  it('rejects a dirty pull without overwriting files or advancing HEAD', async () => {
    const { directory, first, second } = await setup();
    await update(directory, first, 'alpha', { name: 'Remote change' });
    success(first, ['save', '--reason', 'Remote change'], 'save');
    success(first, ['push'], 'push');
    await update(directory, second, 'beta', { note: 'Unsaved local change' });
    const head = git(second, ['rev-parse', 'HEAD']);
    const source = await readFile(join(second, 'tables/items.yaml'), 'utf8');
    expect(cli(second, ['pull'])).toMatchObject({ status: 2, reply: {
      data: { action: 'pull', completed: false }, error: expect.any(Object),
    } });
    expect(git(second, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await readFile(join(second, 'tables/items.yaml'), 'utf8')).toBe(source);
    expect(git(second, ['ls-files', '-u'])).toBe('');
  });

  it('rejects missing, malformed and stale resolution inputs without completing the merge', async () => {
    const { directory, second, pulled } = await conflict();
    const input = await choicesFile(directory, [{ file: 'tables/items.yaml', key: 'alpha', choice: 'ours' }]);
    const head = git(second, ['rev-parse', 'HEAD']);
    expect(cli(second, ['pull', '--resolve', input])).toMatchObject({ status: 2, reply: {
      data: { action: 'resolve', completed: false }, error: { code: 'REVISION_REQUIRED' },
    } });
    await writeFile(input, '{broken');
    expect(cli(second, ['pull', '--resolve', input, '--expect-revision', pulled.status.revision]))
      .toMatchObject({ status: 2, reply: { data: { action: 'resolve', completed: false } } });
    await choicesFile(directory, [{ file: 'tables/items.yaml', key: 'alpha', choice: 'ours' }]);
    // A separate editor changes a nonconflicting file after the resolution screen read.
    const file = join(second, 'tables/offers.yaml');
    await writeFile(file, (await readFile(file, 'utf8')) + '# external edit\n');
    const before = await readFile(join(second, 'tables/items.yaml'), 'utf8');
    expect(cli(second, ['pull', '--resolve', input, '--expect-revision', pulled.status.revision]))
      .toMatchObject({ status: 2, reply: {
        data: { action: 'resolve', completed: false }, error: { code: 'STALE_REVISION' },
      } });
    expect(git(second, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await readFile(join(second, 'tables/items.yaml'), 'utf8')).toBe(before);
    expect(current(second)).toMatchObject({ state: 'conflict', mergeInProgress: true });
  });
});
