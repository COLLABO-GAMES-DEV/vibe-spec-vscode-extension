import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initProject, loadProject, projectWithChanges } from '../src/project.js';
import { getGitStatus, saveProject } from '../src/git.js';
import { createPlan, writeVariant } from '../src/plans.js';
import { applyStructureEdit } from '../src/structure.js';
import { applyEdits } from '../src/editing.js';

let sandbox: string;
beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vibe-plan-storage-'));
  const config = join(sandbox, 'gitconfig');
  await writeFile(config, '[user]\n  name = Plan Test\n  email = plan@example.invalid\n[commit]\n  gpgsign = false\n');
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(sandbox, { recursive: true, force: true }); });

it('includes plan metadata and patches in revision, managed saves and clones', async () => {
  const root = join(sandbox, '기획 폴더');
  let project = await initProject(root);
  project = (await applyStructureEdit(root, project.revision, { op: 'table-create', table: 'rates', key: { code: 'key', label: 'Key' } })).project;
  project = (await applyStructureEdit(root, project.revision, { op: 'column-add', table: 'rates', column: 'chance', definition: { type: 'decimal' } })).project;
  project = (await applyEdits(root, project.revision, [{ op: 'create', table: 'rates', row: { key: 'S', chance: '0.4' } }])).project;
  const baselineRevision = project.revision;
  project = (await createPlan(root, project.revision, '확률', { title: '확률 검토', status: 'review' })).project;
  project = (await writeVariant(root, project.revision, '확률', 'A', { set: { 'rates/S/chance': '0.5' } })).project;
  expect(project.revision).not.toBe(baselineRevision);
  expect(project.sources.has('plans/확률/_plan.yaml')).toBe(true);
  await writeFile(join(root, 'plans/.DS_Store'), 'unmanaged OS metadata');
  await writeFile(join(root, 'plans/README.md'), 'unmanaged notes');
  expect((await loadProject(root)).revision).toBe(project.revision);
  expect((await getGitStatus(root)).changes).toEqual(expect.arrayContaining(['plans/확률/_plan.yaml', 'plans/확률/A.yaml']));
  await writeFile(join(root, 'private-notes.txt'), 'unmanaged');
  await saveProject(root, '기획 대안 저장');
  expect((await getGitStatus(root)).otherChanges).toContain('private-notes.txt');
  const clone = join(sandbox, 'clone');
  execFileSync('git', ['clone', root, clone], { stdio: 'pipe' });
  const copied = await loadProject(clone);
  expect(copied.revision).toBe(project.revision);
  for (const [file, source] of project.sources) expect(await readFile(join(clone, file), 'utf8')).toBe(source);
  await writeFile(join(root, 'plans/확률/A.yaml'), project.sources.get('plans/확률/A.yaml')!.replace('"0.5"', '"0.8"'));
  expect((await loadProject(root)).revision).not.toBe(project.revision);
});

it('validates portable plan and variant names without restricting Korean titles', async () => {
  const project = await initProject(join(sandbox, 'root'));
  expect(() => projectWithChanges(project, new Map([['plans/CON/_plan.yaml', 'title: "확률"\nstatus: "review"\n']]))).toThrow(/이름/);
  expect(() => projectWithChanges(project, new Map([
    ['plans/rate/_plan.yaml', 'title: "확률"\nstatus: "review"\n'],
    ['plans/rate/A.yaml', 'set: {}\nbase_values: {}\nbase_missing: []\n'],
    ['plans/rate/a.yaml', 'set: {}\nbase_values: {}\nbase_missing: []\n'],
  ]))).toThrow(/대소문자/);
  await mkdir(join(project.root, 'plans', '한글 기획'), { recursive: true });
  await writeFile(join(project.root, 'plans', '한글 기획', '_plan.yaml'), 'title: "제목 / 제한 없음"\nstatus: "review"\n');
  expect((await loadProject(project.root)).diagnostics).toEqual([]);
});
