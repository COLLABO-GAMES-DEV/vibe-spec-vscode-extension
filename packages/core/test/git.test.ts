import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGitStatus, pullProject, pushProject, resolveProject, saveProject } from '../src/git.js';
import { initProject, loadProject, readPath } from '../src/project.js';
import { applyEdits, renameResource } from '../src/editing.js';
import { applyStructureEdit } from '../src/structure.js';
import { mergeTable } from '../src/git-merge.js';
import { parseYaml } from '../src/yaml.js';

let sandbox: string;
const schema = 'primary_key: key\ncolumns:\n  key:\n    type: string\n  name:\n    type: text\n  note:\n    type: text\n';
const table = 'schema: items\nrows:\n  - key: "a"\n    name: "A"\n    note: "base note"\n  - key: "z"\n    name: "Z"\n    note: "last note"\n';
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vibe-git-'));
  const config = join(sandbox, 'gitconfig');
  await writeFile(config, '[user]\n  name = Core Test\n  email = core@example.invalid\n[commit]\n  gpgsign = false\n[init]\n  defaultBranch = main\n[core]\n  autocrlf = false\n[credential]\n  helper =\n');
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(sandbox, { recursive: true, force: true });
});
async function project(name = 'project') {
  const root = join(sandbox, name);
  await initProject(root);
  await writeFile(join(root, 'schemas/items.yaml'), schema);
  await writeFile(join(root, 'tables/items.yaml'), table);
  return root;
}
async function edit(root: string, key: string, values: Record<string, string | boolean | null>) {
  const current = await loadProject(root);
  return applyEdits(root, current.revision, [{ op: 'update', table: 'items', key, values }]);
}
async function pair() {
  const origin = join(sandbox, 'remote.git');
  git(sandbox, 'init', '--bare', '--initial-branch=main', origin);
  const a = await project('a');
  await saveProject(a, 'initial project');
  git(a, 'remote', 'add', 'origin', origin);
  await pushProject(a);
  const b = join(sandbox, 'b');
  git(sandbox, 'clone', origin, b);
  return { a, b, origin };
}
async function diverge(a: string, b: string, ours: Record<string, string>, theirs: Record<string, string>) {
  await edit(a, 'a', ours);
  await edit(b, 'a', theirs);
  await saveProject(a, 'ours');
  await saveProject(b, 'theirs');
  await pushProject(b);
}

describe('native Git status and save scope', () => {
  it('reads an empty project clone without creating folders and can create its first table', async () => {
    const root = join(sandbox, 'empty');
    const original = await initProject(root);
    await saveProject(root, 'empty project');
    const clone = join(sandbox, 'clone');
    git(sandbox, 'clone', root, clone);
    const contents = await readdir(clone);
    expect(contents).not.toContain('schemas');
    expect(contents).not.toContain('tables');

    const empty = await loadProject(clone);
    expect(empty.files.size).toBe(0);
    expect([...empty.sources.keys()]).toEqual(['.gitattributes']);
    expect(empty.diagnostics).toEqual([]);
    expect(empty.revision).toBe(original.revision);
    expect(await readdir(clone)).toEqual(contents);
    const created = await applyStructureEdit(clone, empty.revision, {
      op: 'table-create', table: 'first', key: { code: 'key', label: 'Key' },
    });
    expect(created.changed).toEqual(['schemas/first.yaml', 'tables/first.yaml']);
    expect(created.diagnostics).toEqual([]);
    expect(readPath(await loadProject(clone), 'first')).toMatchObject({ table: { schema: 'first', rows: [] } });
  });

  it.each([undefined, '{}', '{', '{"planning_root":""}', '{"planning_root":1}', '{"planning_root":"./planning"}'])
    ('does not accept a folder without data directories and a valid self-pointing project marker: %s', async marker => {
      const root = join(sandbox, 'not-a-project');
      await mkdir(root);
      if (marker !== undefined) await writeFile(join(root, '.vibe-spec.json'), marker);
      const contents = await readdir(root);
      await expect(loadProject(root)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
      expect(await readdir(root)).toEqual(contents);
    });

  it('lists only files that actually exist before Git initialization', async () => {
    const root = join(sandbox, 'partial');
    await mkdir(join(root, 'tables'), { recursive: true });
    await writeFile(join(root, 'tables/items.yaml'), table);
    expect((await getGitStatus(root)).changes).toEqual(['tables/items.yaml']);
  });
  it('reads a project without a repository and initializes main only on a reasoned save', async () => {
    const root = await project();
    const before = await getGitStatus(root);
    expect(before).toMatchObject({ repository: null, gitDir: null, branch: null, state: 'unsaved', mergeInProgress: false });
    expect(before.changes).toEqual(['.agents/skills/vibe-import/SKILL.md', '.gitattributes', '.gitignore', '.vibe-spec.json', 'AGENTS.md', 'schemas/items.yaml', 'tables/items.yaml']);
    await expect(saveProject(root, ' \n ', before.revision)).rejects.toMatchObject({ code: 'GIT_REASON_REQUIRED' });
    expect((await getGitStatus(root)).repository).toBeNull();
    const saved = await saveProject(root, '첫 저장', before.revision);
    expect(saved).toMatchObject({ completed: true, action: 'save', diagnostics: [], status: { branch: 'main', state: 'unpublished', ahead: 1, changes: [] } });
    expect(saved.status.outgoing).toEqual([{ hash: saved.commit, reason: '첫 저장', otherFiles: false }]);
    expect(git(root, 'log', '-1', '--format=%an <%ae>')).toBe('Core Test <core@example.invalid>');
  });

  it('commits only managed paths and preserves different staged and unstaged code versions', async () => {
    const root = await project();
    await saveProject(root, 'base');
    await writeFile(join(root, 'code.ts'), 'base code\n');
    git(root, 'add', 'code.ts');
    git(root, 'commit', '-m', 'code baseline');
    await writeFile(join(root, 'code.ts'), 'staged code\n');
    git(root, 'add', 'code.ts');
    await writeFile(join(root, 'code.ts'), 'unstaged code\n');
    await writeFile(join(root, 'new.ts'), 'new staged code\n');
    git(root, 'add', 'new.ts');
    await edit(root, 'a', { name: 'edited' });
    const before = await getGitStatus(root);
    expect(before.changes).toEqual(['tables/items.yaml']);
    expect(before.otherChanges).toEqual(['code.ts', 'new.ts']);
    const stagedBefore = git(root, 'diff', '--cached', '--', 'code.ts', 'new.ts');
    const saved = await saveProject(root, 'only planning', before.revision);
    expect(saved.completed).toBe(true);
    expect(git(root, 'show', 'HEAD:code.ts')).toBe('base code');
    expect(git(root, 'diff', '--cached', '--', 'code.ts', 'new.ts')).toBe(stagedBefore);
    expect(git(root, 'show', ':code.ts')).toBe('staged code');
    expect(await readFile(join(root, 'code.ts'), 'utf8')).toBe('unstaged code\n');
    expect(saved.status.outgoing.find(commit => commit.reason === 'code baseline')?.otherFiles).toBe(true);
    expect(saved.status.outgoing.at(-1)?.otherFiles).toBe(false);
  });

  it('includes deleted and renamed managed files without absorbing a staged code deletion', async () => {
    const root = await project();
    await saveProject(root, 'base');
    await writeFile(join(root, 'code.ts'), 'code\n');
    git(root, 'add', 'code.ts');
    git(root, 'commit', '-m', 'code');
    git(root, 'rm', 'code.ts');
    await rename(join(root, 'tables/items.yaml'), join(root, 'tables/catalog.yaml'));
    await rm(join(root, 'AGENTS.md'));
    const saved = await saveProject(root, 'rename table');
    expect(saved.completed).toBe(true);
    expect(git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('tables/catalog.yaml');
    expect(git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('tables/items.yaml');
    expect(git(root, 'show', 'HEAD:code.ts')).toBe('code');
    expect(git(root, 'diff', '--cached', '--name-status')).toBe('D\tcode.ts');
  });

  it('uses the enclosing repository but only manages the selected planning root', async () => {
    const repo = join(sandbox, 'mono');
    await mkdir(repo);
    git(repo, 'init', '-b', 'feature/spec');
    const root = await project('mono/planning');
    await writeFile(join(repo, 'AGENTS.md'), 'workspace instructions\n');
    git(repo, 'add', 'AGENTS.md');
    const saved = await saveProject(root, 'planning only');
    expect(saved.status.branch).toBe('feature/spec');
    expect(saved.status.repository).toBe(await import('node:fs/promises').then(fs => fs.realpath(repo)));
    expect(saved.status.otherChanges).toEqual(['AGENTS.md']);
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').every(path => path.startsWith('planning/'))).toBe(true);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('AGENTS.md');
  });

  it('preserves native absolute paths and literal Korean paths with spaces in a nested repository', async () => {
    const repo = join(sandbox, '저장소 공백 [1]');
    await mkdir(repo);
    git(repo, 'init', '-b', 'main');
    const root = await project('저장소 공백 [1]/기획 공백');
    const before = await loadProject(root);
    await renameResource(root, before.revision, 'table', 'items', '아이템 [1]');
    const saved = await saveProject(root, '한글 경로 저장');
    const paths = git(repo, 'ls-tree', '-rz', '--name-only', 'HEAD').split('\0').filter(Boolean);
    expect(paths).toContain('기획 공백/tables/아이템 [1].yaml');
    expect(saved.status.changes).toEqual([]);
    expect(saved.status.otherChanges).toEqual([]);
    expect(saved.status.outgoing[0]?.otherFiles).toBe(false);
    expect(saved.status.root).toBe(await import('node:fs/promises').then(fs => fs.realpath(root)));
    if (process.platform === 'win32') expect(saved.status.root).toMatch(/^[A-Za-z]:\\/);
    expect(readPath(await loadProject(root), '아이템 [1]/a/name')).toEqual({ value: 'A', present: true });
  });

  it('records a spelling change through an intermediate name and save with core.ignorecase enabled', async () => {
    const root = await project();
    await saveProject(root, 'base');
    git(root, 'config', 'core.ignorecase', 'true');
    for (const [from, to] of [['items', 'intermediate'], ['intermediate', 'Items']] as const) {
      const current = await loadProject(root);
      await renameResource(root, current.revision, 'table', from, to);
      const status = await getGitStatus(root);
      expect(status.changes).toEqual(['tables/' + to + '.yaml', 'tables/' + from + '.yaml'].sort());
      const saved = await saveProject(root, 'rename to ' + to, status.revision);
      expect(saved.status.changes).toEqual([]);
      const paths = git(root, 'ls-tree', '-rz', '--name-only', 'HEAD').split('\0');
      expect(paths).toContain('tables/' + to + '.yaml');
      expect(paths).not.toContain('tables/' + from + '.yaml');
    }
    expect(readPath(await loadProject(root), 'Items/a/name')).toEqual({ value: 'A', present: true });
  });

  it.each(['true', 'false'])('commits LF attributes and checks out managed files as LF with core.autocrlf=%s', async autocrlf => {
    git(sandbox, 'config', '--global', 'core.autocrlf', autocrlf);
    const root = await project();
    const attributes = await readFile(join(root, '.gitattributes'), 'utf8');
    const initial = await getGitStatus(root);
    expect(initial.changes).toContain('.gitattributes');
    const saved = await saveProject(root, 'line ending policy');
    expect(git(root, 'show', 'HEAD:.gitattributes')).toBe(attributes.trim());
    expect(saved.status.otherChanges).toEqual([]);
    expect(saved.status.outgoing[0]?.otherFiles).toBe(false);
    const clone = join(sandbox, 'LF clone 한글');
    git(sandbox, 'clone', root, clone);
    for (const path of ['.gitattributes', '.gitignore', '.vibe-spec.json', 'AGENTS.md', 'schemas/items.yaml', 'tables/items.yaml']) {
      expect(await readFile(join(clone, path), 'utf8')).not.toContain('\r');
    }
    expect((await getGitStatus(clone)).changes).toEqual([]);
    await edit(clone, 'a', { note: '+001.2300E+0002' });
    const edited = await saveProject(clone, 'numeric text');
    expect(edited.status.changes).toEqual([]);
    expect(git(clone, 'diff', 'HEAD^', 'HEAD', '--numstat', '--', 'tables/items.yaml')).toBe('1\t1\ttables/items.yaml');
    expect(readPath(await loadProject(clone), 'items/a/note')).toEqual({ value: '+001.2300E+0002', present: true });
  });

  it('reads legacy CRLF without changes and normalizes an edited file once with autocrlf', async () => {
    const root = await project();
    await rm(join(root, '.gitattributes'), { force: true });
    git(sandbox, 'config', '--global', 'core.autocrlf', 'true');
    await writeFile(join(root, 'schemas/items.yaml'), schema.replaceAll('\n', '\r\n'));
    await writeFile(join(root, 'tables/items.yaml'), table.replaceAll('\n', '\r\n'));
    await saveProject(root, 'legacy CRLF');
    const clone = join(sandbox, 'legacy clone');
    git(sandbox, 'clone', root, clone);
    const original = await readFile(join(clone, 'tables/items.yaml'), 'utf8');
    expect(original).toBe(table.replaceAll('\n', '\r\n'));
    await loadProject(clone);
    expect(await readFile(join(clone, 'tables/items.yaml'), 'utf8')).toBe(original);
    await edit(clone, 'a', { name: '수정' });
    const edited = await readFile(join(clone, 'tables/items.yaml'), 'utf8');
    expect(edited).toBe(table.replace('name: "A"', 'name: "수정"'));
    await saveProject(clone, 'CRLF edit');
    expect(await readFile(join(clone, 'tables/items.yaml'), 'utf8')).toBe(edited);
    expect((await getGitStatus(clone)).changes).toEqual([]);
    expect(git(clone, 'show', 'HEAD:tables/items.yaml')).not.toContain('\r');
  });

  it('returns normal validation diagnostics after saving and rejects stale managed or index state', async () => {
    const root = await project();
    await saveProject(root, 'base');
    const before = await getGitStatus(root);
    await edit(root, 'a', { name: false });
    await expect(saveProject(root, 'stale', before.revision)).rejects.toMatchObject({ code: 'STALE_REVISION' });
    const after = await getGitStatus(root);
    await writeFile(join(root, 'AGENTS.md'), 'changed instructions\n');
    await expect(saveProject(root, 'also stale', after.revision)).rejects.toMatchObject({ code: 'STALE_REVISION' });
    const saved = await saveProject(root, 'invalid cell still saves');
    expect(saved.completed).toBe(true);
    expect(saved.diagnostics).toContainEqual(expect.objectContaining({ code: 'VALUE_TYPE_OR_RANGE' }));
    const current = await getGitStatus(root);
    await writeFile(join(root, 'code.ts'), 'staged\n');
    git(root, 'add', 'code.ts');
    await expect(saveProject(root, 'index changed', current.revision)).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  it('honors user commit hooks and the shared project lock', async () => {
    const root = await project();
    await saveProject(root, 'base');
    const hook = join(root, '.git/hooks/pre-commit');
    await writeFile(hook, '#!/bin/sh\n' +
      'if [ "$GIT_TERMINAL_PROMPT" != "0" ] || [ "$GCM_INTERACTIVE" != "never" ]; then\n' +
      '  echo unexpected-interactive-git >&2\n  exit 1\nfi\n' +
      'echo hook-refused >&2\nexit 1\n');
    // Git for Windows runs /bin/sh hooks itself; chmod is a POSIX requirement.
    if (process.platform !== 'win32') await chmod(hook, 0o755);
    await edit(root, 'a', { note: 'new note' });
    await expect(saveProject(root, 'hook failure')).rejects.toThrow('hook-refused');
    expect(git(root, 'log', '-1', '--format=%s')).toBe('base');
    await writeFile(join(root, '.vibe-spec.lock'), '');
    await expect(saveProject(root, 'locked')).rejects.toMatchObject({ code: 'PROJECT_LOCKED' });
  });

  it('handles a staged managed edit undone in the worktree without an empty commit', async () => {
    const root = await project();
    await saveProject(root, 'base');
    const head = git(root, 'rev-parse', 'HEAD');
    await edit(root, 'a', { name: 'staged' });
    git(root, 'add', 'tables/items.yaml');
    await writeFile(join(root, 'tables/items.yaml'), table);
    const saved = await saveProject(root, 'already undone');
    expect(saved).toMatchObject({ completed: true, status: { changes: [] } });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  });
});

describe('native Git upload and receive', () => {
  it.each([
    { statusCode: 401, helperFailure: '' },
    { statusCode: 403, helperFailure: '' },
    { statusCode: 500, helperFailure: '' },
    { statusCode: 401, helperFailure: 'Cannot prompt because user interactivity has been disabled.' },
    { statusCode: 401, helperFailure: 'Interaction is not allowed.' },
    { statusCode: 401, helperFailure: 'Cannot prompt because terminal prompts have been disabled.' },
  ])('classifies HTTP $statusCode / $helperFailure without changing saved files or commits', async ({ statusCode, helperFailure }) => {
    const root = await project();
    await saveProject(root, 'base');
    // Empty helper/askpass overrides keep this loopback fixture independent of
    // developer credentials and Git for Windows credential-manager UI.
    vi.stubEnv('GIT_ASKPASS', '');
    vi.stubEnv('SSH_ASKPASS', '');
    git(root, 'config', 'http.proxy', '');
    if (helperFailure) {
      vi.stubEnv('VIBE_AUTH_FAILURE', helperFailure);
      // quit=1 prevents Git from falling through to its usual username/prompt
      // error, so this exercises the helper's interaction-disabled wording.
      git(root, 'config', 'credential.helper', '!f() { printf "%s\\n" "$VIBE_AUTH_FAILURE" >&2; printf "quit=1\\n"; }; f');
    }
    const server = createServer((_request, response) => {
      response.writeHead(statusCode, { 'WWW-Authenticate': 'Basic realm="local fixture"', Connection: 'close' });
      response.end('fixture refusal');
    });
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      git(root, 'remote', 'add', 'origin', 'http://127.0.0.1:' + address.port + '/fixture.git');
      const head = git(root, 'rev-parse', 'HEAD');
      const contents = await readFile(join(root, 'tables/items.yaml'));
      const code = statusCode === 500 ? 'GIT_NETWORK_FAILED' : 'GIT_AUTH_FAILED';
      for (const action of [pushProject, pullProject]) {
        const failed = action(root);
        await expect(failed).rejects.toMatchObject({ code });
        if (code === 'GIT_AUTH_FAILED') {
          await expect(failed).rejects.toThrow('gh auth login 후 gh auth setup-git');
          await expect(failed).rejects.toThrow('자격증명을 별도로 저장하지 않습니다');
          if (helperFailure) await expect(failed).rejects.toThrow(helperFailure);
        } else await expect(failed).rejects.not.toThrow('gh auth login');
      }
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
      expect(await readFile(join(root, 'tables/items.yaml'))).toEqual(contents);
      expect(await readdir(root)).not.toContain('.vibe-spec.lock');
    } finally {
      await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
    }
  });

  it('uses an existing credential helper for authenticated HTTP push and pull with prompts disabled', async () => {
    const { a, b, origin } = await pair();
    const helper = '!f() { if [ "$1" = get ] && [ "$GCM_INTERACTIVE" = never ] && [ "$GIT_TERMINAL_PROMPT" = 0 ]; then ' +
      'printf "username=fixture\\npassword=local-only-placeholder\\n"; fi; }; f';
    git(a, 'config', 'credential.helper', helper);
    git(a, 'config', 'http.proxy', '');
    vi.stubEnv('GIT_ASKPASS', '');
    vi.stubEnv('SSH_ASKPASS', '');
    const authorization = 'Basic ' + Buffer.from('fixture:local-only-placeholder').toString('base64');
    const accepted: string[] = [];
    const failures: string[] = [];
    // System Git implements the HTTP transport too; this server only supplies
    // loopback Basic authentication and passes CGI requests to http-backend.
    const server = createServer((request, response) => {
      if (request.headers.authorization !== authorization) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="local fixture"', Connection: 'close' });
        response.end();
        return;
      }
      const url = new URL(request.url!, 'http://127.0.0.1');
      accepted.push(url.pathname);
      const child = execFile('git', ['http-backend'], {
        cwd: sandbox, encoding: 'buffer', timeout: 10_000,
        env: { ...process.env, GIT_PROJECT_ROOT: sandbox, GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method!,
          CONTENT_TYPE: request.headers['content-type'] ?? '', CONTENT_LENGTH: request.headers['content-length'] ?? '',
          REMOTE_USER: 'fixture', REMOTE_ADDR: '127.0.0.1' },
      }, (error, stdout, stderr) => {
        const separator = stdout.indexOf('\r\n\r\n');
        if (error || separator < 0) {
          failures.push(error?.message ?? stderr.toString('utf8'));
          response.writeHead(500); response.end(); return;
        }
        for (const line of stdout.subarray(0, separator).toString('utf8').split('\r\n')) {
          const colon = line.indexOf(':');
          const name = line.slice(0, colon), value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === 'status') response.statusCode = Number(value.slice(0, 3));
          else response.setHeader(name, value);
        }
        response.end(stdout.subarray(separator + 4));
      });
      child.stdin!.on('error', () => { /* execFile reports transport failures. */ });
      request.pipe(child.stdin!);
    });
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      git(a, 'remote', 'set-url', 'origin', 'http://127.0.0.1:' + address.port + '/remote.git');
      const config = await readFile(join(a, '.git/config'));
      await edit(a, 'a', { name: 'authenticated push' });
      const saved = await saveProject(a, 'helper upload');
      expect((await pushProject(a)).completed).toBe(true);
      expect(git(origin, 'rev-parse', 'main')).toBe(saved.commit);
      await pullProject(b);
      await edit(b, 'z', { name: 'authenticated pull' });
      await saveProject(b, 'helper receive');
      await pushProject(b);
      expect((await pullProject(a)).completed).toBe(true);
      expect(readPath(await loadProject(a), 'items/z/name')).toEqual({ value: 'authenticated pull', present: true });
      expect(accepted).toContain('/remote.git/git-receive-pack');
      expect(accepted).toContain('/remote.git/git-upload-pack');
      expect(failures).toEqual([]);
      expect(await readFile(join(a, '.git/config'))).toEqual(config);
    } finally {
      await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
    }
  }, 30_000);

  it.each(['nested', 'separate'] as const)('keeps planning save scope and native repository transfer scope in a %s repository', async layout => {
    const origin = join(sandbox, 'scope.git');
    git(sandbox, 'init', '--bare', '--initial-branch=main', origin);
    const repositoryA = join(sandbox, 'scope-a');
    git(sandbox, 'clone', origin, repositoryA);
    const a = await project(layout === 'nested' ? 'scope-a/기획 공백' : 'scope-a');
    const game = layout === 'nested' ? repositoryA : join(sandbox, 'separate-game');
    if (layout === 'separate') {
      await mkdir(game);
      git(game, 'init', '-b', 'main');
    }
    await writeFile(join(game, 'game.ts'), 'staged game code\n');
    git(game, 'add', 'game.ts');
    const staged = git(game, 'diff', '--cached', '--', 'game.ts');
    const saved = await saveProject(a, 'planning only');
    const paths = git(repositoryA, 'ls-tree', '-rz', '--name-only', 'HEAD').split('\0').filter(Boolean);
    expect(paths).not.toContain('game.ts');
    if (layout === 'nested') expect(paths.every(path => path.startsWith('기획 공백/'))).toBe(true);
    expect(git(game, 'diff', '--cached', '--', 'game.ts')).toBe(staged);
    expect(saved.status.outgoing).toEqual([expect.objectContaining({ reason: 'planning only', otherFiles: false })]);
    git(game, 'commit', '-m', 'game code');
    const gameHead = git(game, 'rev-parse', 'HEAD');
    const status = await getGitStatus(a);
    expect(status.outgoing.some(commit => commit.otherFiles)).toBe(layout === 'nested');
    if (layout === 'nested') expect(status.outgoing).toContainEqual({ hash: gameHead, reason: 'game code', otherFiles: true });
    expect((await pushProject(a)).completed).toBe(true);
    expect(git(origin, 'ls-tree', '-rz', '--name-only', 'main').split('\0').includes('game.ts')).toBe(layout === 'nested');
    const repositoryB = join(sandbox, 'scope-b');
    git(sandbox, 'clone', origin, repositoryB);
    const b = layout === 'nested' ? join(repositoryB, '기획 공백') : repositoryB;
    await edit(b, 'a', { name: 'second clone' });
    await saveProject(b, 'second clone edit');
    expect((await getGitStatus(b)).outgoing).toEqual([expect.objectContaining({ reason: 'second clone edit', otherFiles: false })]);
    await pushProject(b);
    const received = await pullProject(a);
    expect(received).toMatchObject({ completed: true, status: { changes: [], outgoing: [] } });
    expect(readPath(await loadProject(a), 'items/a/name')).toEqual({ value: 'second clone', present: true });
    expect(await readFile(join(game, 'game.ts'), 'utf8')).toBe('staged game code\n');
    if (layout === 'separate') expect(git(game, 'rev-parse', 'HEAD')).toBe(gameHead);
  }, 30_000);

  it('can read and add a new table after pulling deletion of the final table and schema', async () => {
    const { a, b } = await pair();
    const before = await loadProject(a);
    await applyStructureEdit(a, before.revision, { op: 'table-delete', table: 'items' });
    await saveProject(a, 'delete final table');
    await pushProject(a);
    const received = await pullProject(b);
    expect(received).toMatchObject({ completed: true, diagnostics: [], status: { changes: [] } });
    const contents = await readdir(b);
    expect(contents).not.toContain('schemas');
    expect(contents).not.toContain('tables');
    const empty = await loadProject(b);
    expect(empty.files.size).toBe(0);
    expect([...empty.sources.keys()]).toEqual(['.gitattributes']);
    expect(await readdir(b)).toEqual(contents);
    const created = await applyStructureEdit(b, empty.revision, {
      op: 'table-create', table: 'replacement', key: { code: 'key', label: 'Key' },
    });
    expect(created.diagnostics).toEqual([]);
    expect(readPath(await loadProject(b), 'replacement')).toMatchObject({ table: { rows: [] } });
  });

  it('ignores its own lock and temporary siblings even without gitignore rules', async () => {
    const { a, b } = await pair();
    await writeFile(join(a, '.gitignore'), '');
    await saveProject(a, 'no ignore rules');
    await pushProject(a);
    await pullProject(b);
    await writeFile(join(b, 'tables/items.yaml.vibe-tmp'), 'interrupted temporary write');
    const before = await getGitStatus(b);
    expect(before.otherChanges).toEqual([]);
    const received = await pullProject(b);
    expect(received.completed).toBe(true);
    expect(await readFile(join(b, 'tables/items.yaml.vibe-tmp'), 'utf8')).toBe('interrupted temporary write');
  });
  it('uploads the actual branch with explicit upstream and reports all outgoing commits', async () => {
    const root = await project();
    await saveProject(root, 'base');
    git(root, 'branch', '-m', 'feature/spec');
    const origin = join(sandbox, 'remote.git');
    git(sandbox, 'init', '--bare', origin);
    git(root, 'remote', 'add', 'only-remote', origin);
    await writeFile(join(root, 'code.ts'), 'code\n');
    git(root, 'add', 'code.ts');
    git(root, 'commit', '-m', 'code commit');
    const status = await getGitStatus(root);
    expect(status.remote?.name).toBe('only-remote');
    expect(status.outgoing).toContainEqual(expect.objectContaining({ reason: 'code commit', otherFiles: true }));
    const pushed = await pushProject(root);
    expect(pushed.status).toMatchObject({ state: 'published', branch: 'feature/spec', ahead: 0, behind: 0, outgoing: [] });
    expect(git(root, 'config', 'branch.feature/spec.merge')).toBe('refs/heads/feature/spec');
    expect(git(origin, 'rev-parse', 'refs/heads/feature/spec')).toBe(pushed.commit);
  });

  it('keeps a saved commit when non-fast-forward upload fails and refuses dirty receive without fetching', async () => {
    const { a, b } = await pair();
    await diverge(a, b, { note: 'ours' }, { note: 'theirs' });
    const saved = git(a, 'rev-parse', 'HEAD');
    await expect(pushProject(a)).rejects.toMatchObject({ code: 'GIT_PUSH_REJECTED' });
    expect(git(a, 'rev-parse', 'HEAD')).toBe(saved);
    await writeFile(join(a, 'untracked.ts'), 'do not lose\n');
    const before = git(a, 'rev-parse', 'origin/main');
    await expect(pullProject(a)).rejects.toMatchObject({ code: 'GIT_DIRTY' });
    expect(git(a, 'rev-parse', 'origin/main')).toBe(before);
    expect(await readFile(join(a, 'untracked.ts'), 'utf8')).toBe('do not lose\n');
  });

  it('merges different rows and adjacent fields of the same row, preserving numeric text', async () => {
    const { a, b } = await pair();
    await edit(a, 'a', { name: 'ours name' });
    await edit(b, 'a', { note: '+001.2300E+0002' });
    await edit(b, 'z', { name: 'theirs last row' });
    await saveProject(a, 'ours');
    await saveProject(b, 'theirs');
    await pushProject(b);
    const merged = await pullProject(a);
    expect(merged).toMatchObject({ completed: true, diagnostics: [], status: { conflicts: [], mergeInProgress: false } });
    const p = await loadProject(a);
    expect(readPath(p, 'items/a')).toEqual({ key: 'a', name: 'ours name', note: '+001.2300E+0002' });
    expect(readPath(p, 'items/z/name')).toEqual({ value: 'theirs last row', present: true });
    expect(git(a, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
  });

  it.each(['base', 'ours', 'theirs'] as const)('rebuilds conflicts from Git and selects %s while retaining nonconflicting fields', async choice => {
    const { a, b } = await pair();
    await diverge(a, b, { name: 'ours', note: 'keep ours note' }, { name: 'theirs' });
    const merged = await pullProject(a);
    expect(merged.completed).toBe(false);
    const current = await getGitStatus(a);
    expect(current.conflicts).toEqual([{
      kind: 'row', file: 'tables/items.yaml', table: 'items', key: 'a',
      base: { key: 'a', name: 'A', note: 'base note' },
      ours: { key: 'a', name: 'ours', note: 'keep ours note' },
      theirs: { key: 'a', name: 'theirs', note: 'base note' },
    }]);
    expect(current.mergeInProgress).toBe(true);
    expect(git(a, 'ls-files', '--unmerged')).toContain('tables/items.yaml');
    await expect(resolveProject(a, current.revision, [])).rejects.toMatchObject({ code: 'GIT_CHOICES_REQUIRED' });
    const resolved = await resolveProject(a, current.revision, [{ file: 'tables/items.yaml', key: 'a', choice }]);
    expect(resolved).toMatchObject({ completed: true, diagnostics: [], status: { conflicts: [], mergeInProgress: false } });
    expect(readPath(await loadProject(a), 'items/a')).toEqual({ key: 'a', name: { base: 'A', ours: 'ours', theirs: 'theirs' }[choice], note: 'keep ours note' });
    expect(git(a, 'ls-files', '--unmerged')).toBe('');
  });

  it('saves, receives and resolves conflicts for a maximum-length filename', async () => {
    const { a, b } = await pair();
    const name = 'a'.repeat(250), file = 'tables/' + name + '.yaml';
    const current = await loadProject(a);
    await renameResource(a, current.revision, 'table', 'items', name);
    await saveProject(a, 'long table name');
    await pushProject(a);
    expect((await pullProject(b)).completed).toBe(true);
    for (const [root, value] of [[a, 'ours'], [b, 'theirs']]) {
      const before = await loadProject(root!);
      await applyEdits(root!, before.revision, [{ op: 'update', table: name, key: 'a', values: { name: value! } }]);
      await saveProject(root!, value!);
    }
    await pushProject(b);
    const pending = await pullProject(a);
    expect(pending.status.conflicts).toEqual([expect.objectContaining({ file, key: 'a', kind: 'row' })]);
    const result = await resolveProject(a, pending.status.revision, [{ file, key: 'a', choice: 'theirs' }]);
    expect(result).toMatchObject({ completed: true, diagnostics: [] });
    expect(readPath(await loadProject(a), name + '/a/name')).toMatchObject({ value: 'theirs' });
    expect(await readdir(join(a, 'tables'))).toEqual([name + '.yaml']);
  });

  it('rejects an external edit after conflict display without overwriting bytes or losing Git stages', async () => {
    const { a, b } = await pair();
    await diverge(a, b, { name: 'ours' }, { name: 'theirs' });
    const pending = await pullProject(a);
    const index = git(a, 'ls-files', '--unmerged');
    await writeFile(join(a, 'tables/items.yaml'), table + '# external writer\n');
    await expect(resolveProject(a, pending.status.revision, [{ file: 'tables/items.yaml', key: 'a', choice: 'ours' }]))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(await readFile(join(a, 'tables/items.yaml'), 'utf8')).toBe(table + '# external writer\n');
    expect(git(a, 'ls-files', '--unmerged')).toBe(index);
  });

  it('falls back to a complete file for duplicate Keys without losing duplicate rows', async () => {
    const { a, b } = await pair();
    await writeFile(join(a, 'tables/items.yaml'), table.replace('name: "A"', 'name: "ours"').replace('key: "z"', 'key: "a"'));
    await edit(b, 'a', { name: 'theirs' });
    await saveProject(a, 'duplicate Key');
    await saveProject(b, 'theirs');
    await pushProject(b);
    const pending = await pullProject(a);
    expect(pending.status.conflicts).toEqual([expect.objectContaining({ kind: 'file', managed: true, file: 'tables/items.yaml' })]);
    const resolved = await resolveProject(a, pending.status.revision, [{ file: 'tables/items.yaml', choice: 'ours' }]);
    expect(resolved.completed).toBe(true);
    expect(resolved.diagnostics).toContainEqual(expect.objectContaining({ code: 'KEY_DUPLICATE' }));
    expect((readPath(await loadProject(a), 'items') as { table: { rows: unknown[] } }).table.rows).toHaveLength(2);
  });

  it('shows unmanaged conflicts and leaves their contents untouched even with a file choice', async () => {
    const { a, b } = await pair();
    for (const root of [a, b]) {
      await writeFile(join(root, 'code.ts'), root === a ? 'ours\n' : 'theirs\n');
      git(root, 'add', 'code.ts');
      git(root, 'commit', '-m', 'code');
    }
    await pushProject(b);
    const pending = await pullProject(a);
    expect(pending.completed).toBe(false);
    expect(pending.status.conflicts).toEqual([expect.objectContaining({ kind: 'file', file: 'code.ts', managed: false })]);
    const code = await readFile(join(a, 'code.ts'), 'utf8');
    await expect(resolveProject(a, pending.status.revision, [{ file: 'code.ts', choice: 'ours' }]))
      .rejects.toMatchObject({ code: 'GIT_EXTERNAL_CONFLICT' });
    expect(await readFile(join(a, 'code.ts'), 'utf8')).toBe(code);
    git(a, 'checkout', '--ours', '--', 'code.ts');
    git(a, 'add', 'code.ts');
    const resolved = await resolveProject(a, (await getGitStatus(a)).revision, []);
    expect(resolved.completed).toBe(true);
  });

  it('reports an old Key reference after merging a rename without inventing aliases', async () => {
    const { a, b } = await pair();
    const current = await loadProject(a);
    await renameResource(a, current.revision, 'key', 'items/a', 'renamed');
    await writeFile(join(b, 'schemas/links.yaml'), 'primary_key: key\ncolumns:\n  key:\n    type: string\n  target:\n    type: ref\n    table: items\n');
    await writeFile(join(b, 'tables/links.yaml'), 'schema: links\nrows:\n  - key: "link"\n    target: "a"\n');
    await saveProject(a, 'rename');
    await saveProject(b, 'old Key reference');
    await pushProject(b);
    const merged = await pullProject(a);
    expect(merged.completed).toBe(true);
    expect(merged.diagnostics).toContainEqual(expect.objectContaining({ code: 'REF_MISSING', path: 'links/link/target' }));
    expect(readPath(await loadProject(a), 'links/link/target')).toEqual({ value: 'a', present: true });
  });

  it('reports already replaced files on a later replacement failure and resumes from remaining Git stages', async () => {
    const { a, b } = await pair();
    await writeFile(join(a, 'tables/other.yaml'), table);
    await saveProject(a, 'second table');
    await pushProject(a);
    await pullProject(b);
    for (const root of [a, b]) {
      const value = root === a ? 'ours' : 'theirs';
      await edit(root, 'a', { name: value });
      await writeFile(join(root, 'tables/other.yaml'), table.replace('name: "A"', 'name: "' + value + '"'));
      await saveProject(root, value);
    }
    await pushProject(b);
    const pending = await pullProject(a);
    expect(pending.status.conflicts).toHaveLength(2);
    const temporary = join(a, 'tables/other.yaml.vibe-tmp');
    await writeFile(temporary, 'existing temporary file');
    await expect(resolveProject(a, pending.status.revision, [
      { file: 'tables/items.yaml', key: 'a', choice: 'ours' },
      { file: 'tables/other.yaml', key: 'a', choice: 'ours' },
    ])).rejects.toMatchObject({ code: 'WRITE_FAILED', written: ['tables/items.yaml'], message: expect.stringContaining('Git') });
    expect(await readFile(temporary, 'utf8')).toBe('existing temporary file');
    expect(readPath(await loadProject(a), 'items/a/name')).toEqual({ value: 'ours', present: true });
    const remaining = await getGitStatus(a);
    expect(remaining.conflicts).toHaveLength(1);
    expect(remaining.conflicts[0]?.file).toBe('tables/other.yaml');
    await rm(temporary);
    const resolved = await resolveProject(a, remaining.revision, [{ file: 'tables/other.yaml', key: 'a', choice: 'ours' }]);
    expect(resolved.completed).toBe(true);
  });
});

describe('conservative row merge', () => {
  const merge = (b: unknown[], o: unknown[], t: unknown[], schemas = [schema, schema, schema]) => mergeTable('tables/items.yaml', 'items',
    [b, o, t].map(rows => JSON.stringify({ schema: 'items', rows })), schemas);
  it('requires complete choices for delete/modify and differing concurrent additions', () => {
    const b = [{ key: 'a', name: 'base' }];
    const plan = merge(b, [], [{ key: 'a', name: 'changed' }])!;
    expect(plan.conflicts).toEqual([expect.objectContaining({ key: 'a', ours: null, theirs: { key: 'a', name: 'changed' } })]);
    expect(parseYaml(plan.source([{ file: 'tables/items.yaml', key: 'a', choice: 'ours' }])).data).toEqual({ schema: 'items', rows: [] });
    const added = merge([], [{ key: 'new', name: 'ours' }], [{ key: 'new', note: 'theirs' }])!;
    expect(added.conflicts).toHaveLength(1);
    expect(added.source([{ file: 'tables/items.yaml', key: 'new', choice: 'theirs' }])).not.toContain('ours');
  });
  it('falls back for missing schema, duplicate Keys, invalid cells and different Key declarations', () => {
    expect(merge([], [], [], [schema, '', schema])).toBeNull();
    expect(merge([], [{ key: 'a' }, { key: 'a' }], [])).toBeNull();
    expect(merge([], [{ key: 'a', name: ['not scalar'] }], [])).toBeNull();
    expect(merge([], [], [], [schema, schema.replace('primary_key: key', 'primary_key: name'), schema])).toBeNull();
  });
  it('preserves absent/null cells and local row order, then appends incoming rows', () => {
    const plan = merge([{ key: 'a', name: 'base' }], [{ key: 'z' }, { key: 'a', name: 'base', note: null }],
      [{ key: 'a', name: 'changed' }, { key: 'b' }])!;
    expect(plan.conflicts).toEqual([]);
    const text = plan.source([]);
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
    expect(text.indexOf('"z"')).toBeLessThan(text.indexOf('"a"'));
    expect(text).toContain('note: null');
  });
});
