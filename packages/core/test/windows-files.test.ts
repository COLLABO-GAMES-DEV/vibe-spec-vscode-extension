import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGitStatus, pullProject, resolveProject, saveProject } from '../src/git.js';
import { initProject, loadProject, writeChanges } from '../src/project.js';

// Node's fs.open permits sharing on Windows. A separate .NET process is needed
// to exercise actual Windows sharing violations, rather than a mocked errno.
async function holdFile(path: string, share: 'None' | 'Read' | 'ReadWrite'): Promise<() => Promise<void>> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$file = [System.IO.File]::Open($env:VIBE_LOCK_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::' + share + ')',
    'try {',
    '  [Console]::Out.WriteLine("LOCKED")',
    '  [Console]::Out.Flush()',
    '  [Console]::In.ReadLine() | Out-Null',
    '} finally { $file.Dispose() }',
  ].join('\n');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, VIBE_LOCK_PATH: path }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const started = Date.now();
  let phase = 'starting', expired: string | undefined;
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => { /* The exit/error promise reports child failures. */ });
  const closed = new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(
      `File holder exited ${code} (${signal ?? 'no signal'}) while ${phase}, ${Date.now() - started}ms after spawn` +
      (expired ? `; ${expired} watchdog expired` : '') + ': ' + stderr)));
  });
  // Keep startup failures handled even while waiting for the readiness line.
  void closed.catch(() => {});
  let output = '';
  const ready = new Promise<void>(accept => child.stdout.setEncoding('utf8').on('data', chunk => {
    output += chunk;
    if (output.includes('LOCKED')) accept();
  }));
  // Classic PowerShell startup/shutdown can be slow on a hosted Windows runner.
  // These watchdogs bound the helper, not the product's 500ms rename retries.
  const timeout = setTimeout(() => { expired = '30s startup'; child.kill(); }, 30_000);
  try {
    await Promise.race([ready, closed.then(() => { throw new Error('File holder exited before acquiring the lock'); })]);
  } catch (error) {
    child.kill();
    await closed.catch(() => {});
    throw error;
  } finally { clearTimeout(timeout); }
  phase = 'holding the file';
  return async () => {
    phase = 'releasing the file';
    const timeout = setTimeout(() => { expired = '15s release'; child.kill(); }, 15_000);
    try { child.stdin.end('\n'); await closed; }
    finally { clearTimeout(timeout); }
  };
}

describe.skipIf(process.platform !== 'win32')('Windows cross-process file sharing', () => {
  let sandbox: string;
  const schema = 'primary_key: key\ncolumns:\n  key:\n    type: string\n  name:\n    type: text\n';
  const table = 'schema: items\nrows:\n  - key: "a"\n    name: "original"\n';
  const git = (root: string, ...args: string[]) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'vibe-windows-'));
    const config = join(sandbox, 'gitconfig');
    await writeFile(config, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_COUNT', '3');
    for (const [index, [key, value]] of [
      ['user.name', 'Windows Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'],
    ].entries()) {
      vi.stubEnv('GIT_CONFIG_KEY_' + index, key!);
      vi.stubEnv('GIT_CONFIG_VALUE_' + index, value!);
    }
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(sandbox, { recursive: true, force: true });
  });
  async function project(name = '기획 공백') {
    const root = join(sandbox, name);
    await initProject(root);
    await writeFile(join(root, 'schemas/items.yaml'), schema);
    await writeFile(join(root, 'tables/items.yaml'), table);
    await saveProject(root, 'baseline');
    return root;
  }

  it('preserves bytes and the commit when FileShare.None denies reads and writes, then retries after release', async () => {
    const root = await project();
    const path = join(root, 'tables/items.yaml');
    const before = await loadProject(root);
    const original = await readFile(path);
    const head = git(root, 'rev-parse', 'HEAD');
    const changed = table.replace('original', 'changed');
    const release = await holdFile(path, 'None');
    try {
      await expect(loadProject(root)).rejects.toThrow();
      await expect(writeChanges(before, new Map([['tables/items.yaml', changed]])))
        .rejects.toMatchObject({ code: 'WRITE_FAILED', written: [] });
      await expect(saveProject(root, 'blocked')).rejects.toThrow();
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
      expect(await readdir(join(root, 'tables'))).not.toContain('items.yaml.vibe-tmp');
      expect(await readdir(root)).not.toContain('.vibe-spec.lock');
    } finally { await release(); }
    expect(await readFile(path)).toEqual(original);
    expect((await loadProject(root)).revision).toBe(before.revision);
    expect(await writeChanges(before, new Map([['tables/items.yaml', changed]]))).toEqual(['tables/items.yaml']);
    expect(await readFile(path, 'utf8')).toBe(changed);
  }, 90_000);

  it('keeps the original when FileShare.Read allows revision checks but denies the temporary-file replacement', async () => {
    const root = await project();
    const path = join(root, 'tables/items.yaml');
    const before = await loadProject(root);
    const original = await readFile(path);
    const changed = table.replace('original', 'changed');
    const release = await holdFile(path, 'Read');
    try {
      expect((await loadProject(root)).revision).toBe(before.revision);
      await expect(writeChanges(before, new Map([['tables/items.yaml', changed]])))
        .rejects.toMatchObject({ code: 'WRITE_FAILED', written: [], message: expect.stringContaining('rename') });
      expect(await readFile(path)).toEqual(original);
      expect(await readdir(join(root, 'tables'))).not.toContain('items.yaml.vibe-tmp');
      expect(await readdir(root)).not.toContain('.vibe-spec.lock');
    } finally { await release(); }
    expect(await readFile(path)).toEqual(original);
    expect(await writeChanges(before, new Map([['tables/items.yaml', changed]]))).toEqual(['tables/items.yaml']);
  }, 90_000);

  async function stagedOrSettled(root: string, settled: () => boolean) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (settled() || (await readdir(join(root, 'tables'))).includes('items.yaml.vibe-tmp')) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('The writer did not stage its replacement or report a failure.');
  }

  it('completes a replacement after a short Windows sharing lock is released', async () => {
    const root = await project();
    const path = join(root, 'tables/items.yaml');
    const before = await loadProject(root);
    const changed = table.replace('original', 'after short sharing lock');
    const release = await holdFile(path, 'Read');
    let settled = false;
    const pending = writeChanges(before, new Map([['tables/items.yaml', changed]]));
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await stagedOrSettled(root, () => settled);
      // Keep the actual sharing violation in place across the first rename attempts.
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally { await release(); }
    await expect(pending).resolves.toEqual(['tables/items.yaml']);
    expect(await readFile(path, 'utf8')).toBe(changed);
    expect(await readdir(join(root, 'tables'))).not.toContain('items.yaml.vibe-tmp');
    expect(await readdir(root)).not.toContain('.vibe-spec.lock');
  }, 90_000);

  it('rechecks bytes during sharing retries and preserves an intervening external write', async () => {
    const root = await project();
    const path = join(root, 'tables/items.yaml');
    const before = await loadProject(root);
    const external = table.replace('original', 'external writer wins');
    // This allows an external write, while continuing to forbid rename/delete.
    const release = await holdFile(path, 'ReadWrite');
    let settled = false;
    const pending = writeChanges(before, new Map([['tables/items.yaml', table.replace('original', 'our draft')]]));
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await stagedOrSettled(root, () => settled);
      await writeFile(path, external);
      await expect(pending).rejects.toMatchObject({ code: 'STALE_REVISION', written: [] });
      expect(await readFile(path, 'utf8')).toBe(external);
      expect(await readdir(join(root, 'tables'))).not.toContain('items.yaml.vibe-tmp');
      expect(await readdir(root)).not.toContain('.vibe-spec.lock');
    } finally { await release(); }
  }, 90_000);

  it('retains conflict bytes and Git stages when another process denies conflict-file replacement', async () => {
    const a = await project('작업 A');
    const origin = join(sandbox, '로컬 원격.git');
    await mkdir(origin);
    git(origin, 'init', '--bare', '--initial-branch=main');
    git(a, 'remote', 'add', 'origin', origin);
    git(a, 'push', '--set-upstream', 'origin', 'main');
    const b = join(sandbox, '작업 B');
    git(sandbox, 'clone', origin, b);
    for (const [root, value] of [[a, 'ours'], [b, 'theirs']] as const) {
      await writeFile(join(root, 'tables/items.yaml'), table.replace('original', value));
      await saveProject(root, value);
    }
    git(b, 'push', 'origin', 'main');
    const pending = await pullProject(a);
    expect(pending.completed).toBe(false);
    const path = join(a, 'tables/items.yaml');
    const original = await readFile(path);
    const stages = git(a, 'ls-files', '--unmerged');
    const head = git(a, 'rev-parse', 'HEAD');
    const choices = [{ file: 'tables/items.yaml', key: 'a', choice: 'ours' as const }];
    const release = await holdFile(path, 'Read');
    try {
      await expect(resolveProject(a, pending.status.revision, choices))
        .rejects.toMatchObject({ code: 'WRITE_FAILED', written: [], message: expect.stringContaining('rename') });
      expect(await readFile(path)).toEqual(original);
      expect(git(a, 'ls-files', '--unmerged')).toBe(stages);
      expect(git(a, 'rev-parse', 'HEAD')).toBe(head);
      expect(await readdir(join(a, 'tables'))).not.toContain('items.yaml.vibe-tmp');
      expect(await readdir(a)).not.toContain('.vibe-spec.lock');
    } finally { await release(); }
    expect((await getGitStatus(a)).revision).toBe(pending.status.revision);
    const resolved = await resolveProject(a, pending.status.revision, choices);
    expect(resolved.completed).toBe(true);
    expect(git(a, 'ls-files', '--unmerged')).toBe('');
    expect(await readFile(path, 'utf8')).toContain('name: "ours"');
  }, 90_000);
});
