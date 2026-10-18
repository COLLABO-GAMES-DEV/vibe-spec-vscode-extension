import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@vibe-spec/core';
import { afterEach, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const roots: string[] = [];
type Runner = 'node' | 'powershell.exe' | 'pwsh.exe';
interface Reply {
  ok: boolean;
  revision: string;
  data: unknown;
  diagnostics: Diagnostic[];
  error?: { code: string; message: string };
}
function powershell(shell: Exclude<Runner, 'node'>, script: string, cwd: string, variables: NodeJS.ProcessEnv) {
  const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n" +
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n' +
      'Set-Location -LiteralPath $env:VIBE_TEST_CWD\n' + script, 'utf16le').toString('base64')], {
    cwd, env: { ...process.env, ...variables, VIBE_TEST_CWD: cwd }, encoding: 'utf8', timeout: 30_000,
  });
  // A missing/broken shell on Windows is a failure, never a skipped test.
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return result;
}
function cli(runner: Runner, cwd: string, args: string[]) {
  const result = runner === 'node'
    ? spawnSync(process.execPath, [entry, ...args, '--json'], { cwd, encoding: 'utf8', timeout: 15_000 })
    : powershell(runner, [
      '$cliArgs = ConvertFrom-Json -InputObject $env:VIBE_TEST_ARGS',
      '& $env:VIBE_TEST_NODE $env:VIBE_TEST_ENTRY @cliArgs',
      'exit $LASTEXITCODE',
    ].join('\n'), cwd, {
      VIBE_TEST_NODE: process.execPath, VIBE_TEST_ENTRY: entry,
      VIBE_TEST_ARGS: JSON.stringify([...args, '--json']),
    });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  const reply = JSON.parse(result.stdout) as Reply;
  expect(reply).toMatchObject({ ok: expect.any(Boolean), diagnostics: expect.any(Array) });
  return { status: result.status, reply };
}
async function input(runner: Runner, directory: string, value: unknown) {
  const path = join(directory, "요청 O'Brien [입력].json");
  if (runner === 'node') await writeFile(path, '\uFEFF' + JSON.stringify(value) + '\r\n');
  else {
    const result = powershell(runner, [
      // PowerShell 5.1 can wrap a ConvertFrom-Json array in {value, Count}
      // when serializing it again. Write the literal request without conversion.
      '$env:VIBE_TEST_JSON | Out-File -LiteralPath $env:VIBE_TEST_INPUT -Encoding utf8',
    ].join('\n'), directory, { VIBE_TEST_JSON: JSON.stringify(value), VIBE_TEST_INPUT: path });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  }
  const bytes = await readFile(path);
  expect(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))).toEqual(value);
  // Windows PowerShell 5.1 emits a BOM for -Encoding utf8; PowerShell 7 does not.
  expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(runner !== 'pwsh.exe');
  return path;
}
async function sources(root: string): Promise<Record<string, string>> {
  const files = ['.agents/skills/vibe-import/SKILL.md', '.gitattributes', '.gitignore', '.vibe-spec.json', 'AGENTS.md'];
  for (const directory of ['schemas', 'tables']) {
    files.push(...(await readdir(join(root, directory))).sort().map(name => directory + '/' + name));
  }
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(root, file), 'utf8')] as const)));
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// Native process coverage runs on every OS. Only actual Windows shell execution
// is OS-specific, and both Windows PowerShell and PowerShell 7 must work there.
describe.each<Runner>(['node', 'powershell.exe', 'pwsh.exe'])('%s portable CLI workflow', { timeout: 90_000 }, runner => {
  it.skipIf(runner !== 'node' && process.platform !== 'win32')(
    'initializes, reads, edits, applies, renames, validates and formats Korean paths with exact numeric strings', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'vibe CLI Windows 한글 '));
      roots.push(directory);
      const root = join(directory, "기획 폴더 O'Brien [초안]");
      const initialized = cli(runner, directory, ['init', relative(directory, root)]);
      expect(initialized).toMatchObject({ status: 0, reply: { ok: true, data: { root: expect.any(String) }, diagnostics: [] } });
      const initializedRoot = (initialized.reply.data as { root: string }).root;
      expect(isAbsolute(initializedRoot)).toBe(true);
      expect(await realpath(initializedRoot)).toBe(await realpath(root));
      if (process.platform === 'win32') expect(initializedRoot).toMatch(/^[a-z]:\\/i);
      let revision = initialized.reply.revision;
      function command(args: string[]) {
        const result = cli(runner, directory, [...args, '--project', root]);
        expect(result, JSON.stringify(result)).toMatchObject({ status: 0, reply: { ok: true, diagnostics: [] } });
        revision = result.reply.revision;
        return result.reply;
      }
      async function edit(value: unknown, operation = 'edit') {
        return command([operation, '--input', await input(runner, directory, value), '--expect-revision', revision]);
      }
      await edit({ op: 'table-create', table: '보상 표', key: { code: 'key', label: 'CON: 표시명 / 허용' } });
      for (const [column, type] of [['price', 'decimal'], ['count', 'integer']] as const) {
        await edit({ op: 'column-add', table: '보상 표', column, definition: { type } });
      }
      const count = '900719925474099312345678901234567890';
      const price = '+000.1234567890123456789012345678900E+0002';
      await edit({ op: 'create', table: '보상 표', row: { key: 'CON', price, count } });
      expect(command(['read', '보상 표/CON']).data).toEqual({ key: 'CON', price, count });
      await edit([
        { op: 'update', table: '보상 표', key: 'CON', values: { price: '-000.45000e+001' } },
        { op: 'create', table: '보상 표', row: { key: 'con', price: '-0.000', count: '00042' } },
      ], 'apply');
      // File-name restrictions do not apply to Key values or display labels.
      command(['rename', 'key', '보상 표/CON', '--to', 'NUL:보상', '--expect-revision', revision]);
      command(['rename', 'table', '보상 표', '--to', '최종 보상', '--expect-revision', revision]);
      command(['rename', 'schema', '보상 표', '--to', '최종 스키마', '--expect-revision', revision]);
      expect(command(['read', '최종 보상/NUL:보상']).data)
        .toEqual({ key: 'NUL:보상', price: '-000.45000e+001', count });
      expect(command(['read', '최종 보상/con']).data).toEqual({ key: 'con', price: '-0.000', count: '00042' });
      expect(cli(runner, directory, ['read', '최종 보상', '--project', relative(directory, root)]).status).toBe(0);
      if (process.platform === 'win32') {
        expect(cli(runner, directory, ['read', '최종 보상', '--project', root.replace(/\\/g, '/')]).status).toBe(0);
      }
      const nested = join(root, '작업 하위', '더 아래');
      await mkdir(nested, { recursive: true });
      const discovered = cli(runner, nested, ['validate']);
      expect(discovered, JSON.stringify(discovered)).toMatchObject({ status: 0, reply: { ok: true } });
      command(['validate']);
      command(['fmt']);
      const before = await sources(root);
      for (const [file, source] of Object.entries(before)) {
        expect(source, file).not.toContain('\r');
        expect(source.startsWith('\uFEFF'), file).toBe(false);
      }
      const previousRevision = revision;
      expect(command(['fmt', '--check']).data).toEqual({ changed: [] });
      expect(command(['fmt']).data).toEqual({ changed: [] });
      expect(revision).toBe(previousRevision);
      expect(await sources(root)).toEqual(before);

      // Ignoring a leading BOM must not make malformed JSON silently acceptable.
      const malformed = join(directory, '잘못된 입력.json');
      await writeFile(malformed, '\uFEFF{broken\r\n');
      expect(cli(runner, directory, ['edit', '--input', malformed, '--expect-revision', revision, '--project', root]))
        .toMatchObject({ status: 2, reply: { data: { applied: false }, error: { code: 'COMMAND_FAILED' } } });
      expect(await sources(root)).toEqual(before);
    },
  );
});
