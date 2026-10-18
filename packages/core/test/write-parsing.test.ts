import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { applyEdits } from '../src/editing.js';
import { loadProject, mutateProject, readPath } from '../src/project.js';
import * as yaml from '../src/yaml.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-parsing-')); roots.push(root);
  await cp(fileURLToPath(new URL('./fixtures/project/', import.meta.url)), root, { recursive: true });
  return loadProject(root);
}

it('bounds repeated parsing of an edited table and retains immutable before/after values', async () => {
  const project = await fixture();
  const original = project.sources.get('tables/items.yaml')!;
  const parse = vi.spyOn(yaml, 'parseYaml');
  const result = await applyEdits(project.root, project.revision, [{
    op: 'update', table: 'items', key: 'currency_gold', values: { name: '새 이름' },
  }]);
  const calls = parse.mock.calls.filter(([, file]) => file === 'tables/items.yaml');
  // Disk verification still reads bytes. It must not repeatedly rebuild the same
  // unchanged AST before replacement or the already-validated AST afterwards.
  expect(calls.filter(([source]) => source === original)).toHaveLength(1);
  expect(calls.filter(([source]) => source !== original).length).toBeLessThanOrEqual(2);
  expect(readPath(result.before, 'items/currency_gold/name')).toEqual({ value: '골드', present: true });
  expect(readPath(result.project, 'items/currency_gold/name')).toEqual({ value: '새 이름', present: true });
  expect(await readFile(join(project.root, 'tables/items.yaml'), 'utf8')).toBe(result.planned.sources.get('tables/items.yaml'));
});

it('rereads actual bytes before replacement even when it can reuse parsed files', async () => {
  const project = await fixture();
  const file = join(project.root, 'tables/items.yaml');
  const original = project.sources.get('tables/items.yaml')!;
  const external = original.replace('name: "골드"', 'name: "외부 수정"');
  await expect(mutateProject(project.root, project.revision, async () => {
    await writeFile(file, external);
    return new Map([['tables/items.yaml', original.replace('name: "골드"', 'name: "내 수정"')]]);
  })).rejects.toMatchObject({ code: 'STALE_REVISION' });
  expect(await readFile(file, 'utf8')).toBe(external);
  expect(readPath(await loadProject(project.root), 'items/currency_gold/name')).toEqual({ value: '외부 수정', present: true });
});
