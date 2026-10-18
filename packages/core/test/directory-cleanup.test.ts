import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyFolderEdit } from '../src/folders.js';
import { initProject, loadProject } from '../src/project.js';

vi.mock(import('node:fs/promises'), async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, rmdir: vi.fn(actual.rmdir) };
});
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));

let root: string;
const errno = (code: string) => Object.assign(new Error(code + ': directory cleanup'), { code });
const removal = vi.mocked(rmdir);
const wait = vi.mocked(delay);

beforeEach(async () => {
  removal.mockReset();
  removal.mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rmdir);
  wait.mockReset();
  wait.mockResolvedValue(undefined);
  root = await mkdtemp(join(tmpdir(), 'vibe-directory-cleanup-'));
  await initProject(root);
  await mkdir(join(root, 'tables/상점'));
  await writeFile(join(root, 'tables/상점/.gitkeep'), '');
  vi.stubGlobal('process', { ...process, platform: 'win32' });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

async function renameFolder() {
  return applyFolderEdit(root, (await loadProject(root)).revision,
    { op: 'folder-rename', path: '상점', name: '새상점' });
}

async function expectCleanupFailure() {
  await expect(renameFolder()).rejects.toMatchObject({
    code: 'WRITE_FAILED', message: expect.stringContaining('Directory cleanup failed:'),
    written: expect.arrayContaining(['tables/새상점/.gitkeep', 'tables/상점/.gitkeep']),
  });
  expect(await readFile(join(root, 'tables/새상점/.gitkeep'), 'utf8')).toBe('');
  expect(await readdir(root)).not.toContain('.vibe-spec.lock');
}

it('finishes folder rename after transient Windows EBUSY releases the empty directory', async () => {
  removal.mockRejectedValueOnce(errno('EBUSY')).mockRejectedValueOnce(errno('EBUSY'));
  const result = await renameFolder();
  expect(result.project.directories).toContain('tables/새상점');
  await expect(readdir(join(root, 'tables/상점'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(removal.mock.calls).toEqual(Array.from({ length: 3 }, () => [join(root, 'tables/상점')]));
  expect(wait.mock.calls).toEqual([[20], [40]]);
});

it('bounds permanent Windows EBUSY to six attempts and retains WRITE_FAILED with written paths', async () => {
  removal.mockRejectedValue(errno('EBUSY'));
  await expectCleanupFailure();
  expect(removal).toHaveBeenCalledTimes(6);
  expect(wait.mock.calls).toEqual([[20], [40], [80], [160], [200]]);
  expect(await readdir(join(root, 'tables/상점'))).toEqual([]);
});

it('preserves an external file created during the busy wait and stops on ENOTEMPTY', async () => {
  removal.mockRejectedValueOnce(errno('EBUSY'));
  wait.mockImplementationOnce(async () => {
    await writeFile(join(root, 'tables/상점/external.txt'), 'external bytes');
  });
  await expectCleanupFailure();
  expect(removal).toHaveBeenCalledTimes(2);
  await expect(removal.mock.results[1]!.value).rejects.toMatchObject({ code: 'ENOTEMPTY' });
  expect(wait.mock.calls).toEqual([[20]]);
  expect(await readFile(join(root, 'tables/상점/external.txt'), 'utf8')).toBe('external bytes');
});

it.each(['ENOTEMPTY', 'EPERM', 'EACCES', 'ENOENT'])('rejects Windows %s immediately', async code => {
  removal.mockRejectedValue(errno(code));
  await expectCleanupFailure();
  expect(removal).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});

it.each(['darwin', 'linux'])('does not retry EBUSY on %s', async platform => {
  vi.stubGlobal('process', { ...process, platform });
  removal.mockRejectedValue(errno('EBUSY'));
  await expectCleanupFailure();
  expect(removal).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});
