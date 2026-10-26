import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it('runs document target read/edit/dry-run/conflict/approve through the real CLI', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vibe-cli-doc-alt-')); dirs.push(temp); const root = join(temp, 'planning');
  function run(args: string[], status = 0) {
    const result = spawnSync(process.execPath, [entry, ...args, '--project', root, '--json'], { encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stdout + result.stderr).toBe(status); return JSON.parse(result.stdout);
  }
  const initialized = spawnSync(process.execPath, [entry, 'init', root, '--json'], { encoding: 'utf8' }); expect(initialized.status).toBe(0);
  const rev = () => run(['validate']).revision as string;
  let counter = 0;
  async function input(value: unknown) { const path = join(temp, ++counter + '.json'); await writeFile(path, JSON.stringify(value)); return path; }
  const source = '\uFEFF# Intro\r\n\r\noriginal\r\n\r\n# Outside\r\n\r\nkeep  ';
  const md = join(temp, 'input.md'); await writeFile(md, source);
  run(['document', 'create', 'guide', '--target', 'base', '--input', md, '--expect-revision', rev()]);
  run(['plan', 'create', 'review', '--input', await input({ title: 'Synthetic review', status: 'review' }), '--expect-revision', rev()]);
  run(['plan', 'variant', 'review/A', '--input', await input({ documents: { 'guide/Intro': '# Intro\r\n\r\noriginal' } }), '--expect-revision', rev()]);
  const view = run(['document', 'read', 'guide', '--target', 'review/A']); expect(view.data.target).toBe('review/A');
  const change = await input([{ op: 'replace', block: 1, markdown: 'alternative' }]);
  const args = ['document', 'edit', 'guide', '--target', 'review/A', '--input', change, '--expect-revision', view.revision];
  expect(run([...args, '--dry-run']).data.applied).toBe(false);
  expect(run(['document', 'read', 'guide', '--target', 'review/A']).data.source).toBe(source);
  run(args); expect(await readFile(join(root, 'documents/guide.md'), 'utf8')).toBe(source);
  expect(run(args, 2).error.code).toBe('STALE_REVISION');
  run(['document', 'edit', 'guide', '--target', 'base', '--input', await input([{ op: 'replace', block: 1, markdown: 'current' }]), '--expect-revision', rev()]);
  const plan = run(['plan', 'read', 'review']); expect(plan.diagnostics.some((d: { code: string }) => d.code === 'BASE_CHANGED')).toBe(true);
  expect(plan.data.variants.A.document_base_values['guide/Intro']).toContain('original');
  run(['plan', 'approve', 'review/A', '--expect-revision', rev()]);
  expect(await readFile(join(root, 'documents/guide.md'), 'utf8')).toBe(source.replace('original', 'alternative'));
  expect(run(['fmt', '--check']).data.changed).toEqual([]);
});
