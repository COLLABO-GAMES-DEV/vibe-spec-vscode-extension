import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function cli(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args, ...(args[0] === 'init' ? [] : ['--project', root]), '--json'], { encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull(); expect(result.stderr).toBe('');
  return { status: result.status, ...JSON.parse(result.stdout) };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-cli-copy-')); roots.push(root);
  expect(cli(root, 'init', root).status).toBe(0);
  await cp(fileURLToPath(new URL('../../core/test/fixtures/project', import.meta.url)), root, { recursive: true });
  expect(cli(root, 'fmt').status).toBe(0);
  return root;
}

it('duplicates through real CLI, previews without writing, preserves Markdown and keeps old plans untouched', { timeout: 120_000 }, async () => {
  const root = await fixture();
  await mkdir(join(root, 'plans/old'), { recursive: true });
  const old = 'broken: [\n'; await writeFile(join(root, 'plans/old/A.yaml'), old);
  await mkdir(join(root, 'documents/domain'), { recursive: true });
  const source = '\uFEFF# Guide\r\n\r\nOriginal **spacing**  \r\n\r\n[Value](offers/bundle/price)';
  await writeFile(join(root, 'documents/domain/guide.md'), source);
  let revision = cli(root, 'validate').revision;
  const preview = cli(root, 'duplicate', 'table', 'offers', '--to', 'offers_B', '--expect-revision', revision, '--dry-run');
  expect(preview).toMatchObject({ status: 0, data: { applied: false, changed: [] } });
  expect(preview.data.planned).toEqual(['schemas/offers_B.yaml', 'tables/offers_B.yaml']);
  expect(cli(root, 'validate').revision).toBe(revision);
  const copied = cli(root, 'duplicate', 'table', 'offers', '--to', 'offers_B', '--expect-revision', revision);
  expect(copied).toMatchObject({ status: 0, data: { applied: true } });
  expect(cli(root, 'duplicate', 'document', 'guide', '--to', 'guide_B', '--expect-revision', revision).error.code).toBe('STALE_REVISION');
  revision = copied.revision;
  expect(cli(root, 'duplicate', 'document', 'guide', '--to', 'guide_B', '--expect-revision', revision).status).toBe(0);
  expect(await readFile(join(root, 'documents/domain/guide_B.md'))).toEqual(Buffer.from(source));
  expect(cli(root, 'read', 'offers_B/bundle/price').data).toEqual(cli(root, 'read', 'offers/bundle/price').data);
  expect(cli(root, 'validate').status).toBe(0);
  expect(cli(root, 'fmt', '--check')).toMatchObject({ status: 0, data: { changed: [] } });
  expect(cli(root, 'plan', 'approve', 'old/A')).toMatchObject({ status: 2, error: { code: 'INVALID_ARGUMENT' } });
  expect(cli(root, 'read', 'offers', '--target', 'old/A')).toMatchObject({ status: 2, error: { code: 'INVALID_ARGUMENT' } });
  expect(cli(root, 'read', 'offers', '--target', 'base').status).toBe(0);
  expect(await readFile(join(root, 'plans/old/A.yaml'), 'utf8')).toBe(old);
});

it('new agent guidance uses duplication and rejects missing names/revisions without creating files', { timeout: 60_000 }, async () => {
  const root = await fixture();
  expect(cli(root, 'duplicate', 'table', 'items', '--to', 'items_B').error.code).toBe('REVISION_REQUIRED');
  expect(cli(root, 'duplicate', 'table', 'items', '--expect-revision', cli(root, 'validate').revision).error.code).toBe('INVALID_ARGUMENT');
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  expect(agents).toContain('vibe duplicate table');
  expect(agents).not.toContain('vibe plan approve');
  const skill = await readFile(join(root, '.agents/skills/vibe-import/SKILL.md'), 'utf8');
  expect(skill).toContain('import plan');
  expect(skill).not.toContain('vibe plan create');
});

it('save commits copies but preserves staged legacy plan files outside the managed commit', { timeout: 120_000 }, async () => {
  const root = await fixture();
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0); return result.stdout;
  };
  await mkdir(join(root, 'plans/old'), { recursive: true });
  await writeFile(join(root, 'plans/old/A.yaml'), 'old original\n');
  git('init', '-b', 'main'); git('config', 'user.name', 'Synthetic Copy Test');
  git('config', 'user.email', 'copy@example.invalid'); git('config', 'commit.gpgsign', 'false');
  git('add', '.'); git('commit', '-m', 'Synthetic baseline');
  const legacy = 'manual legacy change: [\n';
  await writeFile(join(root, 'plans/old/A.yaml'), legacy); git('add', 'plans/old/A.yaml');
  const copied = cli(root, 'duplicate', 'table', 'offers', '--to', 'copy', '--expect-revision', cli(root, 'validate').revision);
  expect(copied.status).toBe(0);
  expect(cli(root, 'save', '--reason', 'Independent copy', '--expect-revision', cli(root, 'status').revision).status).toBe(0);
  expect(git('show', 'HEAD:plans/old/A.yaml')).toBe('old original\n');
  expect(git('show', ':plans/old/A.yaml')).toBe(legacy);
  expect(await readFile(join(root, 'plans/old/A.yaml'), 'utf8')).toBe(legacy);
  expect(git('show', '--format=', '--name-only', 'HEAD').trim().split('\n').sort()).toEqual(['schemas/copy.yaml', 'tables/copy.yaml']);
});
