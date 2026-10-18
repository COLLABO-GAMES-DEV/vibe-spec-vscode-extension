import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';
import type { GitChoice, GitConflict, GitResult, GitStatus } from './git-types.js';
import { mergeTable } from './git-merge.js';
import type { TableMerge } from './git-merge.js';
import { loadProject, withLock } from './project.js';
import { isRecord, VibeError } from './types.js';
import type { Diagnostic } from './types.js';
import { validateProject } from './validation.js';
import { parseYaml } from './yaml.js';
import { replaceFile as replaceTemporaryFile, temporarySibling } from './file-replacement.js';
import { resourceEntry } from './resources.js';
import { resourceNameKey } from './names.js';

interface GitOutput { stdout: Buffer; stderr: string; code: number }
async function nativeGit(cwd: string, args: string[], network = false): Promise<GitOutput> {
  return new Promise((accept, reject) => {
    execFile('git', process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...args] : args, {
      cwd, encoding: 'buffer', timeout: network ? 60_000 : 30_000, maxBuffer: 64 * 1024 * 1024,
      // Keep the user's system Git credential helpers (including gh/GCM).
      // Disable prompts only; cached credentials remain available to helpers.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
        GIT_MERGE_AUTOEDIT: 'no', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(new VibeError(error.killed ? 'GIT_TIMEOUT' : 'GIT_UNAVAILABLE',
          error.killed ? 'Git timed out; inspect Git status before retrying.' : error.message));
      } else accept({ stdout, stderr: stderr.toString('utf8'), code: error?.code as number ?? 0 });
    });
  });
}
function gitError(result: GitOutput, action: string): VibeError {
  const detail = [result.stderr, result.stdout.toString('utf8')].filter(Boolean).join('\n').trim();
  const code = /authentication failed|could not read (?:Username|Password)|permission denied \(publickey\)|(?:terminal prompts|interaction|interactivity|interactive prompts?) (?:is |has been |have been )?(?:disabled|not (?:allowed|permitted))|returned error: (?:401|403)\b/i.test(detail)
    ? 'GIT_AUTH_FAILED' : /non-fast-forward|fetch first|\[rejected\]/i.test(detail)
      ? 'GIT_PUSH_REJECTED' : /could not resolve|unable to access|unable to connect|connection refused|network is unreachable|does not appear to be a git repository|could not read from remote/i.test(detail)
        ? 'GIT_NETWORK_FAILED' : 'GIT_FAILED';
  const guidance = code === 'GIT_AUTH_FAILED'
    ? '\n시스템 Git의 기존 자격증명을 사용합니다. vibe-spec은 자격증명을 별도로 저장하지 않습니다. ' +
      'GitHub HTTPS 인증이 없다면 터미널에서 gh auth login 후 gh auth setup-git을 실행하고 다시 시도하세요. ' +
      '이미 로그인했다면 저장소 접근 권한을 확인하세요. 다른 호스트나 SSH는 해당 Git 인증 설정을 확인하세요.'
    : '';
  return new VibeError(code, action + ' failed: ' + detail + guidance);
}
async function git(cwd: string, args: string[], network = false): Promise<string> {
  const result = await nativeGit(cwd, args, network);
  if (result.code !== 0) throw gitError(result, 'git ' + args[0]);
  return result.stdout.toString('utf8');
}
async function optional(cwd: string, args: string[]): Promise<string | null> {
  const result = await nativeGit(cwd, args);
  if (result.code === 0) return result.stdout.toString('utf8').trim();
  if (result.code === 1 || result.code === 128) return null;
  throw gitError(result, 'git ' + args[0]);
}
const split0 = (text: string) => text.split('\0').filter(Boolean);
const managedRootFiles = ['AGENTS.md', '.gitattributes', '.gitignore', '.vibe-spec.json', '.agents/skills/vibe-import/SKILL.md'];
const managedPath = (path: string) => resourceEntry(path) !== undefined || /^plans\/[^/]+\/[^/]+\.yaml$/.test(path) ||
  /^(?:schemas|tables|documents)\/(?:[^/]+\/)*\.gitkeep$/.test(path) && !path.startsWith('documents/assets/') ||
  /^documents\/assets\/[^/]+\.(png|jpe?g|gif|webp)$/i.test(path) || /^imports\/[a-f0-9]{64}\.json$/.test(path) || managedRootFiles.includes(path);
const temporaryPath = (path: string) => path === '.vibe-spec.lock' ||
  path.endsWith('.vibe-tmp') && managedPath(path.slice(0, -9));
interface Stage { mode: string; hash: string; stage: number }
interface Snapshot {
  root: string; repository: string | null; gitDir: string | null; prefix: string;
  head: string | null; mergeHead: string | null; branch: string | null;
  changed: string[]; stages: Map<string, Stage[]>; contents: Map<string, Buffer | null>; revision: string;
}
function localPath(state: Snapshot, file: string): string | null {
  return file.startsWith(state.prefix) ? file.slice(state.prefix.length) : null;
}
function managed(state: Snapshot, file: string): boolean {
  const path = localPath(state, file);
  return path !== null && managedPath(path);
}
async function bytes(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function managedFiles(root: string): Promise<string[]> {
  const paths = [...managedRootFiles];
  const walk = async (dir: string): Promise<void> => {
    try {
      const info = await lstat(join(root, dir));
      if (!info.isDirectory() || info.isSymbolicLink()) throw new VibeError('FILE_UNSUPPORTED', 'Expected a regular directory: ' + dir);
      for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
        const path = dir + '/' + entry.name;
        if (entry.isSymbolicLink()) throw new VibeError('FILE_UNSUPPORTED', 'Managed folders cannot contain symbolic links: ' + path);
        if (entry.isDirectory() && dir !== 'imports' && dir !== 'documents/assets') await walk(path);
        else if (managedPath(path)) paths.push(path);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  for (const dir of ['schemas', 'tables', 'documents', 'imports']) await walk(dir);
  try {
    for (const plan of await readdir(join(root, 'plans'), { withFileTypes: true })) {
      if (!plan.isDirectory()) continue;
      for (const entry of await readdir(join(root, 'plans', plan.name), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.yaml')) paths.push('plans/' + plan.name + '/' + entry.name);
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return paths.sort();
}
async function snapshot(root: string): Promise<Snapshot> {
  root = await realpath(resolve(root));
  const detection = await nativeGit(root, ['rev-parse', '--show-toplevel']);
  if (detection.code !== 0 && !/not a git repository/i.test(detection.stderr)) throw gitError(detection, 'Read repository');
  const repository = detection.code === 0 ? await realpath(detection.stdout.toString('utf8').trim()) : null;
  const prefix = repository && relative(repository, root) ? relative(repository, root).split(sep).join('/') + '/' : '';
  const state: Snapshot = { root, repository, prefix, gitDir: null, head: null, mergeHead: null,
    branch: null, changed: [], stages: new Map(), contents: new Map(), revision: '' };
  const hash = createHash('sha256');
  if (repository) {
    const [gitDir, head, branch, mergeHead, status, index] = await Promise.all([
      git(repository, ['rev-parse', '--absolute-git-dir']),
      optional(repository, ['rev-parse', '--verify', 'HEAD']),
      optional(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      optional(repository, ['rev-parse', '--verify', 'MERGE_HEAD']),
      git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']),
      git(repository, ['ls-files', '--stage', '-z']),
    ]);
    Object.assign(state, { gitDir: gitDir.trim(), head, branch, mergeHead });
    state.changed = split0(status).map(entry => entry.slice(3))
      .filter(path => !path.startsWith(prefix) || !temporaryPath(path.slice(prefix.length)));
    for (const entry of split0(index)) {
      const tab = entry.indexOf('\t');
      const [mode, object, stage] = entry.slice(0, tab).split(' ');
      if (stage === '0') continue;
      const file = entry.slice(tab + 1);
      const stages = state.stages.get(file) ?? [];
      stages.push({ mode: mode!, hash: object!, stage: Number(stage) });
      state.stages.set(file, stages);
    }
    hash.update(JSON.stringify([repository, branch, head, mergeHead, state.changed, index]));
  }
  const paths = new Set((await managedFiles(root)).map(file => prefix + file));
  for (const file of state.stages.keys()) paths.add(file);
  for (const file of [...paths].sort()) {
    const path = join(repository ?? root, file);
    hash.update(file).update('\0');
    try {
      const info = await lstat(path);
      hash.update(String(info.mode)).update('\0');
      const content = info.isSymbolicLink() ? Buffer.from(await readlink(path)) : info.isFile() ? await readFile(path) : Buffer.from('<directory>');
      state.contents.set(file, content);
      hash.update(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state.contents.set(file, null);
      hash.update('<missing>');
    }
    hash.update('\0');
  }
  if (!repository) state.changed = [...state.contents].flatMap(([file, content]) => content === null ? [] : [file]);
  state.revision = hash.digest('hex');
  return state;
}
interface Tracking { remote: { name: string; url: string } | null; target: string | null; upstream: string | null; configured: boolean }
async function tracking(state: Snapshot): Promise<Tracking> {
  if (!state.repository) return { remote: null, target: null, upstream: null, configured: false };
  const repo = state.repository;
  let name = state.branch ? await optional(repo, ['config', '--get', 'branch.' + state.branch + '.remote']) : null;
  const target = state.branch ? await optional(repo, ['config', '--get', 'branch.' + state.branch + '.merge']) : null;
  const configured = name !== null && target !== null;
  if (!name) {
    const names = (await git(repo, ['remote'])).trim().split('\n').filter(Boolean);
    name = names.includes('origin') ? 'origin' : names.length === 1 ? names[0]! : null;
  }
  const url = name === '.' ? repo : name ? await optional(repo, ['remote', 'get-url', '--', name]) : null;
  return {
    remote: name && url ? { name, url } : null,
    target: target ?? (state.branch ? 'refs/heads/' + state.branch : null), configured,
    upstream: state.head && configured ? await optional(repo, ['rev-parse', '--verify', '@{upstream}']) : null,
  };
}
interface ConflictPlan { file: string; stages: Stage[]; sources: (Buffer | null)[]; table: TableMerge | null; conflicts: GitConflict[] }
async function conflictPlans(state: Snapshot): Promise<ConflictPlan[]> {
  if (!state.repository || !state.stages.size) return [];
  const repo = state.repository;
  const bases = state.head && state.mergeHead
    ? (await optional(repo, ['merge-base', '--all', state.head, state.mergeHead]))?.split('\n') ?? [] : [];
  const commits = [bases.length === 1 ? bases[0]! : null, state.head, state.mergeHead];
  const schemaCache = new Map<string, Promise<string | null>>();
  const treeCache = new Map<string, Promise<string[]>>();
  const schemaAt = (commit: string | null, name: string) => {
    if (!commit) return Promise.resolve(null);
    const spec = commit + ':' + name;
    if (!schemaCache.has(spec)) schemaCache.set(spec, (async () => {
      if (!treeCache.has(commit)) treeCache.set(commit, git(repo, ['ls-tree', '-r', '--name-only', '-z', commit, '--', state.prefix + 'schemas/']).then(split0));
      const matches = (await treeCache.get(commit)!).filter(file => file.endsWith('.yaml') &&
        resourceNameKey(posix.basename(file, '.yaml')) === resourceNameKey(name));
      if (matches.length !== 1 || posix.basename(matches[0]!, '.yaml') !== name) return null;
      return optional(repo, ['show', commit + ':' + matches[0]!]);
    })());
    return schemaCache.get(spec)!;
  };
  const plans: ConflictPlan[] = [];
  for (const [file, stages] of state.stages) {
    const sources = await Promise.all([1, 2, 3].map(async stage => {
      const entry = stages.find(entry => entry.stage === stage);
      if (!entry) return null;
      const result = await nativeGit(repo, ['cat-file', '-p', entry.hash]);
      if (result.code !== 0) throw gitError(result, 'Read conflict');
      return result.stdout;
    }));
    const texts = sources.map(source => source?.toString('utf8') ?? null);
    const path = localPath(state, file);
    let table: TableMerge | null = null;
    if (path?.startsWith('tables/') && path.endsWith('.yaml') && managed(state, file) &&
        sources.every(source => source === null || Buffer.from(source.toString('utf8'), 'utf8').equals(source)) &&
        stages.every(stage => ['100644', '100755'].includes(stage.mode))) {
      try {
        const data = parseYaml(texts.find(source => source !== null)!, file).data;
        if (isRecord(data) && typeof data.schema === 'string' && !data.schema.includes('/')) {
          const schemas = await Promise.all(commits.map(commit => schemaAt(commit, data.schema as string)));
          table = mergeTable(file, posix.basename(path, '.yaml'), texts, schemas);
        }
      } catch { /* Malformed input stays a file conflict. */ }
    }
    const conflicts: GitConflict[] = table ? table.conflicts : [{ kind: 'file', file,
      managed: managed(state, file), reason: managed(state, file)
        ? 'Choose the complete file; a safe merge with a common, unique Key is unavailable.'
        : 'Resolve this file outside the planning project with Git, then retry.',
      base: texts[0]!, ours: texts[1]!, theirs: texts[2]!,
    }];
    plans.push({ file, stages, sources, table, conflicts });
  }
  return plans;
}
async function statusFrom(state: Snapshot): Promise<GitStatus> {
  const track = await tracking(state);
  const changes = [...new Set(state.changed.filter(file => managed(state, file)))].sort();
  const otherChanges = [...new Set(state.changed.filter(file => !managed(state, file)))].sort();
  const outgoing: GitStatus['outgoing'] = [];
  let ahead = 0;
  let behind = 0;
  if (state.repository && state.head) {
    const range = track.upstream ? track.upstream + '..' + state.head : state.head;
    const hashes = (await git(state.repository, ['rev-list', '--reverse', range])).trim().split('\n').filter(Boolean);
    ahead = hashes.length;
    if (track.upstream) behind = Number((await git(state.repository, ['rev-list', '--count', state.head + '..' + track.upstream])).trim());
    for (const hash of hashes) {
      const [reason, paths] = await Promise.all([
        git(state.repository, ['show', '-s', '--format=%B', hash]),
        git(state.repository, ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-m', '-z', hash]),
      ]);
      outgoing.push({ hash, reason: reason.trim(), otherFiles: split0(paths).some(file => !managed(state, file)) });
    }
  }
  const conflicts = (await conflictPlans(state)).flatMap(plan => plan.conflicts);
  return { root: state.root, repository: state.repository, gitDir: state.gitDir, branch: state.branch,
    revision: state.revision, state: state.stages.size || state.mergeHead ? 'conflict'
      : changes.length || !state.head ? 'unsaved' : ahead ? 'unpublished' : 'published',
    remote: track.remote, ahead, behind, changes, otherChanges, outgoing, conflicts, mergeInProgress: state.mergeHead !== null };
}
export async function getGitStatus(root: string): Promise<GitStatus> { return statusFrom(await snapshot(root)); }
async function checkRevision(root: string, expected: string): Promise<Snapshot> {
  const current = await snapshot(root);
  if (current.revision !== expected) throw new VibeError('STALE_REVISION', 'Files or Git state changed; read Git status again before writing.');
  return current;
}
function checkContents(current: Snapshot, expected: ReadonlyMap<string, Buffer | null>): void {
  for (const file of new Set([...current.contents.keys(), ...expected.keys()])) {
    const before = expected.get(file) ?? null;
    const after = current.contents.get(file) ?? null;
    if (before === null ? after !== null : after === null || !before.equals(after)) {
      throw new VibeError('STALE_REVISION', 'File changed during the Git operation: ' + file);
    }
  }
}
async function result(root: string, action: GitResult['action'], completed = true, commit?: string): Promise<GitResult> {
  const status = await getGitStatus(root);
  let diagnostics: Diagnostic[];
  try { diagnostics = validateProject(await loadProject(root)); }
  catch (error) {
    // A completed native Git operation remains completed if the resulting
    // project cannot be read or validated (for example a deleted schema folder).
    diagnostics = error instanceof VibeError && error.diagnostics.length ? [...error.diagnostics] : [{
      code: error instanceof VibeError ? error.code : 'PROJECT_READ_FAILED', file: '', path: '', message: (error as Error).message,
    }];
  }
  return { action, completed, status, diagnostics, ...(commit ? { commit } : {}) };
}
function requireRepository(state: Snapshot): asserts state is Snapshot & { repository: string } {
  if (!state.repository) throw new VibeError('GIT_NOT_INITIALIZED', 'Save the project before using Git transfer operations.');
}
function requireBranch(state: Snapshot): asserts state is Snapshot & { branch: string } {
  if (!state.branch) throw new VibeError('GIT_DETACHED_HEAD', 'Select a Git branch before saving or transferring changes.');
}
function noMerge(state: Snapshot) {
  if (state.mergeHead || state.stages.size) throw new VibeError('GIT_CONFLICT', 'Finish the current Git conflict before this operation.');
}

export async function saveProject(root: string, reason: string, expectedRevision?: string): Promise<GitResult> {
  if (typeof reason !== 'string' || !reason.trim()) throw new VibeError('GIT_REASON_REQUIRED', 'Enter a nonempty reason for saving.');
  return withLock(root, async () => {
    let state = await snapshot(root);
    if (expectedRevision !== undefined && expectedRevision !== state.revision) throw new VibeError('STALE_REVISION', 'Files or Git state changed; read Git status again before saving.');
    noMerge(state);
    if (!state.repository) {
      await checkRevision(root, state.revision);
      await git(root, ['init', '-b', 'main']);
      state = await snapshot(root);
    }
    requireRepository(state);
    requireBranch(state);
    const paths = state.changed.filter(file => managed(state, file));
    if (!paths.length) return result(root, 'save');
    await checkRevision(root, state.revision);
    await git(state.repository, ['add', '-A', '--', ...paths]);
    const staged = await snapshot(root);
    checkContents(staged, state.contents);
    if (staged.head !== state.head || staged.branch !== state.branch || staged.mergeHead !== state.mergeHead) {
      throw new VibeError('STALE_REVISION', 'Git state changed before committing; read status again.');
    }
    const pending = split0(await git(state.repository, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--', ...paths]));
    if (!pending.length) return result(root, 'save');
    // Native partial commits preserve the pre-existing index entries for all
    // other paths, including staged content that differs from their worktree.
    await git(state.repository, ['commit', '--only', '-m', reason.trim(), '--', ...pending]);
    return result(root, 'save', true, (await git(state.repository, ['rev-parse', 'HEAD'])).trim());
  });
}

export async function pushProject(root: string): Promise<GitResult> {
  return withLock(root, async () => {
    const state = await snapshot(root);
    requireRepository(state);
    requireBranch(state);
    noMerge(state);
    if (!state.head) throw new VibeError('GIT_NOT_SAVED', 'Save a commit before uploading.');
    const track = await tracking(state);
    if (!track.remote || !track.target) throw new VibeError('GIT_REMOTE_REQUIRED', 'Configure origin, a single remote, or this branch’s upstream before uploading.');
    await checkRevision(root, state.revision);
    await git(state.repository, ['push', '--porcelain', '--no-force', '--no-mirror',
      ...(track.configured ? [] : ['--set-upstream']), '--', track.remote.name, 'refs/heads/' + state.branch + ':' + track.target], true);
    return result(root, 'push', true, state.head);
  });
}

// Check every parent before using a temporary sibling; never follow a symlink
// into another folder while resolving a planning file.
async function replaceFile(state: Snapshot, file: string, source: Buffer | null, before: Buffer | null): Promise<void> {
  requireRepository(state);
  const destination = join(state.repository, file);
  let folder = state.repository;
  for (const part of file.split('/').slice(0, -1)) {
    folder = join(folder, part);
    try {
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new VibeError('FILE_UNSUPPORTED', 'Expected a regular directory: ' + folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(folder);
    }
  }
  let mode = 0o666;
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink()) throw new VibeError('FILE_UNSUPPORTED', 'Resolve nonregular files with Git: ' + file);
    mode = info.mode;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const assertCurrent = async () => {
    const current = await bytes(destination);
    if (before === null ? current !== null : current === null || !before.equals(current)) {
      throw new VibeError('STALE_REVISION', 'File changed immediately before replacement: ' + file);
    }
  };
  await assertCurrent();
  if (source === null) { await assertCurrent(); await rm(destination, { force: true }); return; }
  const temporary = temporarySibling(destination);
  let created = false;
  try {
    const handle = await open(temporary, 'wx', mode);
    created = true;
    try { await handle.writeFile(source); } finally { await handle.close(); }
    await replaceTemporaryFile(temporary, destination, assertCurrent);
  } finally { if (created) await rm(temporary, { force: true }); }
}
async function writePlans(state: Snapshot, plans: ConflictPlan[], choices: readonly GitChoice[]) {
  requireRepository(state);
  await checkRevision(state.root, state.revision);
  for (const plan of plans) {
    if (!managed(state, plan.file) || plan.stages.some(stage => !['100644', '100755'].includes(stage.mode))) {
      throw new VibeError('GIT_EXTERNAL_CONFLICT', 'Resolve this non-planning or nonregular file with Git: ' + plan.file);
    }
  }
  let expected = state.revision;
  const contents = new Map(state.contents);
  const written: string[] = [];
  try {
    for (const plan of plans) {
      await checkRevision(state.root, expected);
      const selected = choices.find(choice => choice.file === plan.file && choice.key === undefined);
      const source = plan.table ? Buffer.from(plan.table.source(choices), 'utf8')
        : plan.sources[{ base: 0, ours: 1, theirs: 2 }[selected!.choice]]!;
      await replaceFile(state, plan.file, source, contents.get(plan.file) ?? null);
      written.push(plan.file);
      contents.set(plan.file, source);
      await git(state.repository, ['add', '-A', '--', plan.file]);
      const current = await snapshot(state.root);
      checkContents(current, contents);
      if (current.head !== state.head || current.branch !== state.branch || current.mergeHead !== state.mergeHead) {
        throw new VibeError('STALE_REVISION', 'Git state changed while resolving; read status again.');
      }
      expected = current.revision;
    }
  } catch (error) {
    if (error instanceof VibeError && written.length === 0) throw error;
    throw new VibeError('WRITE_FAILED', (error as Error).message + '; already replaced: ' +
      (written.join(', ') || 'none') + '. Inspect Git status and restore the last Git commit if needed.', [], written);
  }
}
async function finishMerge(root: string, action: 'pull' | 'resolve'): Promise<GitResult> {
  const state = await snapshot(root);
  requireRepository(state);
  if (state.stages.size) return result(root, action, false);
  if (state.mergeHead) {
    await checkRevision(root, state.revision);
    await git(state.repository, ['commit', '--no-edit']);
  }
  return result(root, action, true, (await git(state.repository, ['rev-parse', 'HEAD'])).trim());
}
export async function pullProject(root: string): Promise<GitResult> {
  return withLock(root, async () => {
    const state = await snapshot(root);
    requireRepository(state);
    requireBranch(state);
    if (state.mergeHead || state.stages.size) return result(root, 'pull', false);
    if (state.changed.length) throw new VibeError('GIT_DIRTY', 'Save or handle all local changes before receiving changes; the files were kept.');
    const track = await tracking(state);
    if (!track.remote || !track.target) throw new VibeError('GIT_REMOTE_REQUIRED', 'Configure origin, a single remote, or this branch’s upstream before receiving changes.');
    await git(state.repository, ['fetch', '--no-tags', '--', track.remote.name, track.target], true);
    await checkRevision(root, state.revision);
    const merged = await nativeGit(state.repository, ['merge', '--no-edit', '--no-commit', '--no-autostash', 'FETCH_HEAD']);
    const after = await snapshot(root);
    if (merged.code !== 0 && !after.stages.size) throw gitError(merged, 'Receive changes');
    const plans = await conflictPlans(after);
    const automatic = plans.filter(plan => plan.table && plan.conflicts.length === 0);
    if (automatic.length) await writePlans(after, automatic, []);
    return finishMerge(root, 'pull');
  });
}
export async function resolveProject(root: string, expectedRevision: string, choices: GitChoice[]): Promise<GitResult> {
  if (!expectedRevision) throw new VibeError('REVISION_REQUIRED', 'Read Git status and supply its revision before resolving.');
  return withLock(root, async () => {
    const state = await checkRevision(root, expectedRevision);
    requireRepository(state);
    if (!state.mergeHead) throw new VibeError('GIT_NO_MERGE', 'There is no pending Git merge to resolve.');
    const plans = await conflictPlans(state);
    const conflicts = plans.flatMap(plan => plan.conflicts);
    if (!Array.isArray(choices) || choices.length !== conflicts.length ||
        choices.some(choice => !choice || !['base', 'ours', 'theirs'].includes(choice.choice)) ||
        conflicts.some(conflict => choices.filter(choice => choice.file === conflict.file &&
          choice.key === (conflict.kind === 'row' ? conflict.key : undefined)).length !== 1)) {
      throw new VibeError('GIT_CHOICES_REQUIRED', 'Provide exactly one base/ours/theirs choice for every remaining conflict.');
    }
    await writePlans(state, plans, choices);
    return finishMerge(root, 'resolve');
  });
}
