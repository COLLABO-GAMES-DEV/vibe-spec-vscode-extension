import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import { initProject } from '../src/project.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function initialized() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-agent-files-'));
  roots.push(root);
  await initProject(join(root, 'p'));
  return join(root, 'p');
}
function skillParts(source: string) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  expect(match).not.toBeNull();
  return { meta: parse(match![1]!) as Record<string, unknown>, body: match![2]! };
}

it('points Claude Code at AGENTS.md and the shared import skill instead of copying rules', async () => {
  const root = await initialized();
  const claude = await readFile(join(root, 'CLAUDE.md'), 'utf8');
  expect(claude.split('\n')).toContain('@AGENTS.md');
  const shared = skillParts(await readFile(join(root, '.agents/skills/vibe-import/SKILL.md'), 'utf8'));
  const claudeSkill = skillParts(await readFile(join(root, '.claude/skills/vibe-import/SKILL.md'), 'utf8'));
  expect(claudeSkill.meta).toEqual({ name: shared.meta.name, description: shared.meta.description });
  for (const target of ['AGENTS.md', '.agents/skills/vibe-import/SKILL.md']) {
    expect(claudeSkill.body).toContain(target);
    await access(join(root, target));
  }
  expect(claudeSkill.body.length).toBeLessThan(shared.body.length / 4);
});

it('documents every column type and option a new table can use', async () => {
  const agents = await readFile(join(await initialized(), 'AGENTS.md'), 'utf8');
  for (const type of ['string', 'text', 'integer', 'decimal', 'boolean', 'enum', 'ref']) expect(agents).toContain('| `' + type + '` |');
  for (const option of ['label', 'required', 'nullable', 'values', 'minimum', 'maximum', 'table', 'on_delete']) expect(agents).toContain('`' + option);
  for (const op of ['table-create', 'column-add', 'column-update', 'column-move', 'column-delete', 'table-delete']) expect(agents).toContain('"op":"' + op + '"');
  expect(agents).toContain('상점 안내/상점 안내/스타터 팩');
});
