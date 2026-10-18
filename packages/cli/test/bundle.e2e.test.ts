import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('runs the self-contained VSIX CLI without a workspace installation or package manager', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibe bundled 한글 '));
  const entry = fileURLToPath(new URL('../../vscode/dist/vibe.cjs', import.meta.url));
  const planning = join(directory, '기획');
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args, '--json'], { cwd: directory, encoding: 'utf8', timeout: 15_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    cli('init', planning);
    const instruction = await readFile(join(planning, 'AGENTS.md'), 'utf8');
    expect(instruction).toContain('code --locate-extension ijun17.vibe-spec');
    let revision = cli('validate', '--project', planning).revision;
    const input = join(directory, '변경.json');
    for (const operation of [
      { op: 'table-create', table: 'rates', key: { code: 'key', label: '등급' } },
      { op: 'column-add', table: 'rates', column: 'chance', definition: { type: 'decimal' } },
      { op: 'create', table: 'rates', row: { key: 'S', chance: '+000.005000E+0002' } },
    ]) {
      await writeFile(input, '\uFEFF' + JSON.stringify(operation) + '\r\n');
      revision = cli('edit', '--project', planning, '--expect-revision', revision, '--input', input).revision;
    }
    expect(cli('read', 'rates/S/chance', '--project', planning).data).toEqual({ value: '+000.005000E+0002', present: true });
    expect(cli('validate', '--project', planning).diagnostics).toEqual([]);
    cli('fmt', '--project', planning);
    expect(cli('fmt', '--check', '--project', planning).data.changed).toEqual([]);
    expect(cli('read', 'rates/S/chance', '--project', planning).data.value).toBe('+000.005000E+0002');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
