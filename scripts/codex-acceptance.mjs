#!/usr/bin/env node
// Manual acceptance only. --dry-run never starts Codex.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Manual Codex acceptance (no CI integration):
  node scripts/codex-acceptance.mjs --dry-run
  node scripts/codex-acceptance.mjs [--cli-entry <main.js>] [--demo <folder>]
    [--codex <executable>] [--timeout-seconds <1..540>]

CLI entry: --cli-entry, then VIBE_CLI_ENTRY, then packages/cli/dist/main.js.
Each task gets a fresh temporary copy. Reports and logs stay outside the product repository.
The default timeout is 300 seconds per task. No model or reasoning option is overridden.`;
const excluded = new Set(['.git', 'node_modules', '.DS_Store']);
const knownErrors = [
  ['VALUE_TYPE_OR_RANGE', 'tables/grade-rates.yaml', 'grade-rates/B/chance_percent'],
  ['REF_MISSING', 'tables/shop-products.yaml', 'shop-products/shop_003/reward_item'],
  ['VALUE_TYPE_OR_RANGE', 'tables/shop-products.yaml', 'shop-products/shop_007/sale_type'],
];
const newRow = {
  sku: 'shop_acceptance_001', name: '수용 테스트 상품', reward_item: 'demo_token_001',
  bonus_item: 'demo_token_002', price_currency: 'demo_currency_001',
  price: '+000.1234567890123456789012345678900E+0002', quantity: '0002',
  sale_type: 'regular', note: '새 행 원문 보존 확인',
};
const tasks = [
  { id: 'numeric-cell', title: '숫자 원문 한 칸 수정', files: ['tables/shop-products.yaml'], errors: 3,
    instruction: 'shop-products/shop_005/price 한 칸만 문자열 "+0008.120000E+0002"로 바꿔 주세요. 부호, 앞자리와 끝자리 0, 지수 표기를 그대로 보존하세요.' },
  { id: 'new-row', title: '새 상품 행 추가', files: ['tables/shop-products.yaml'], errors: 3,
    instruction: 'shop-products에 다음 행 하나를 추가해 주세요. 숫자도 전부 문자열 원문입니다.\n' + JSON.stringify(newRow, null, 2) },
  { id: 'rename-key', title: '참조된 Key와 연결 이름 변경', files: ['tables/items.yaml', 'tables/shop-products.yaml'], errors: 3,
    instruction: 'items의 Key demo_token_001를 demo_token_renamed로 이름 변경하고 선언된 모든 ref 연결도 함께 갱신해 주세요. 자유 메모와 설명에 적힌 옛 Key는 그대로 두세요.' },
  { id: 'repair-errors', title: '의도한 오류 3개 수정', files: ['tables/grade-rates.yaml', 'tables/shop-products.yaml'], errors: 0,
    instruction: '기존 오류 3개만 고쳐 주세요: shop-products/shop_003/reward_item은 "demo_card_001", shop-products/shop_007/sale_type은 "regular", grade-rates/B/chance_percent는 문자열 "35.000"으로 바꾸세요.' },
];
const diagnosticKeys = items => items.map(({ code, file, path }) => [code, file, path]).sort();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonFile = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function command(binary, args, cwd, env) {
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.signal) throw new Error(`${binary} failed: ${result.error?.message ?? result.signal}`);
  return result;
}
function git(root, args, env) {
  const result = command('git', ['-c', 'core.quotepath=false', ...args], root, env);
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout;
}
function cli(root, args, config) {
  const result = command(process.execPath, [config.entry, ...args, '--project', root, '--json'], root, config.env);
  if (![0, 1].includes(result.status)) throw new Error(`vibe ${args[0]} exited ${result.status}: ${result.stdout}\n${result.stderr}`);
  const reply = JSON.parse(result.stdout);
  if (result.stderr || !Array.isArray(reply.diagnostics) || reply.error) throw new Error(`Invalid CLI reply: ${result.stdout}\n${result.stderr}`);
  return { exitCode: result.status, ...reply };
}
async function inventory(root, source = false, prefix = '') {
  const result = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    if (source ? excluded.has(name) : name === '.git') continue;
    const file = prefix ? prefix + '/' + name : name;
    const path = join(root, file), info = await lstat(path);
    if (info.isSymbolicLink()) result[file] = { symlink: await readlink(path) };
    else if (info.isDirectory()) Object.assign(result, await inventory(root, source, file));
    else if (info.isFile()) result[file] = hash(await readFile(path));
    else throw new Error('Unsupported fixture file: ' + path);
  }
  return result;
}
async function readTables(root, config) {
  const tables = {};
  for (const file of (await readdir(join(root, 'tables'))).sort()) {
    if (file.endsWith('.yaml')) tables[file.slice(0, -5)] = cli(root, ['read', file.slice(0, -5)], config).data;
  }
  return tables;
}
function row(tables, table, key) {
  const view = tables[table];
  const matches = view.table.rows.filter(value => value[view.schema.primary_key] === key);
  if (matches.length !== 1) throw new Error(`Expected exactly one row: ${table}/${key}`);
  return matches[0];
}
function normalized(tables) {
  const result = structuredClone(tables);
  for (const view of Object.values(result)) {
    const key = view.schema.primary_key;
    view.table.rows.sort((a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
  }
  return result;
}
function expectedTables(baseline, task) {
  const expected = structuredClone(baseline);
  if (task.id === 'numeric-cell') row(expected, 'shop-products', 'shop_005').price = '+0008.120000E+0002';
  if (task.id === 'new-row') expected['shop-products'].table.rows.push(newRow);
  if (task.id === 'rename-key') {
    row(expected, 'items', 'demo_token_001').Key = 'demo_token_renamed';
    for (const view of Object.values(expected)) {
      for (const [column, definition] of Object.entries(view.schema.columns)) {
        if (definition.type !== 'ref' || definition.table !== 'items') continue;
        for (const value of view.table.rows) {
          if (value[column] === 'demo_token_001') value[column] = 'demo_token_renamed';
        }
      }
    }
  }
  if (task.id === 'repair-errors') {
    row(expected, 'shop-products', 'shop_003').reward_item = 'demo_card_001';
    row(expected, 'shop-products', 'shop_007').sale_type = 'regular';
    row(expected, 'grade-rates', 'B').chance_percent = '35.000';
  }
  return normalized(expected);
}
function preflight(tables, validation) {
  if (validation.exitCode !== 1 || !isDeepStrictEqual(diagnosticKeys(validation.diagnostics), [...knownErrors].sort())) {
    throw new Error('Demo drift: expected exactly the three documented diagnostics. Inspect preflight.json; do not reset the source demo.');
  }
  const cells = [
    ['shop-products', 'shop_005', 'price', '+001.2300E+0002'],
    ['shop-products', 'shop_003', 'reward_item', 'missing_demo_item'],
    ['shop-products', 'shop_007', 'sale_type', 'archived'],
    ['grade-rates', 'B', 'chance_percent', '120.0000'],
  ];
  for (const [table, key, column, value] of cells) {
    if (row(tables, table, key)[column] !== value) throw new Error(`Demo drift: ${table}/${key}/${column}`);
  }
  for (const key of ['demo_token_001', 'demo_token_002', 'demo_currency_001', 'demo_card_001']) row(tables, 'items', key);
  if (tables.items.schema.primary_key !== 'Key' || tables['shop-products'].schema.primary_key !== 'sku' ||
      tables.items.table.rows.some(value => value.Key === 'demo_token_renamed') ||
      tables['shop-products'].table.rows.some(value => value.sku === newRow.sku)) throw new Error('Demo drift: task Key/schema already changed.');
  const references = [];
  for (const [table, view] of Object.entries(tables)) {
    for (const [column, definition] of Object.entries(view.schema.columns)) {
      if (definition.type === 'ref' && definition.table === 'items') {
        for (const value of view.table.rows) if (value[column] === 'demo_token_001') references.push(`${table}/${value[view.schema.primary_key]}/${column}`);
      }
    }
  }
  if (references.length !== 6) throw new Error('Demo drift: expected six declared references to demo_token_001.');
  return references;
}
async function wrappers(directory, config) {
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const launcher = join(bin, 'vibe.mjs');
  await writeFile(launcher, `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(config.entry)}, ...args], { stdio: 'inherit' });
appendFileSync(process.env.VIBE_ACCEPTANCE_AUDIT, JSON.stringify({ args, cwd: process.cwd(), exitCode: result.status, signal: result.signal, error: result.error?.message }) + '\\n');
process.exitCode = result.status ?? 2;
`);
  await writeFile(join(bin, 'vibe'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(launcher)} "$@"\n`);
  await chmod(join(bin, 'vibe'), 0o755);
  await writeFile(join(bin, 'vibe.cmd'), '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%VIBE_ACCEPTANCE_NODE%" "%~dp0vibe.mjs" %*\r\nexit /b %errorlevel%\r\n');
  const pathKey = Object.keys(config.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  config.env = { ...config.env, [pathKey]: bin + delimiter + (config.env[pathKey] ?? ''), VIBE_ACCEPTANCE_NODE: process.execPath };
  return bin;
}
async function runCodex(taskRoot, taskDirectory, prompt, config) {
  const args = ['exec', '--json', '--ephemeral', '-s', 'workspace-write', '-C', taskRoot, '-'];
  const stdout = await open(join(taskDirectory, 'codex.jsonl'), 'w');
  const stderr = await open(join(taskDirectory, 'codex.stderr.log'), 'w');
  const started = Date.now();
  const result = { command: [config.codex, ...args], timeoutMs: config.timeoutMs, exitCode: null, signal: null, timedOut: false, error: null };
  const env = { ...config.env, VIBE_ACCEPTANCE_AUDIT: join(taskDirectory, 'cli.jsonl'),
    VIBE_ACCEPTANCE_CODEX: config.codex, VIBE_ACCEPTANCE_WORKSPACE: taskRoot };
  try {
    await new Promise(done => {
      // cmd can launch npm's codex.cmd; the prompt stays on stdin, outside shell parsing.
      const child = process.platform === 'win32'
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c',
          '""%VIBE_ACCEPTANCE_CODEX%" exec --json --ephemeral -s workspace-write -C "%VIBE_ACCEPTANCE_WORKSPACE%" -"'],
        { cwd: taskRoot, env, windowsVerbatimArguments: true, stdio: ['pipe', stdout.fd, stderr.fd] })
        : spawn(config.codex, args, { cwd: taskRoot, env, detached: true, stdio: ['pipe', stdout.fd, stderr.fd] });
      let fallback;
      const timer = setTimeout(() => {
        result.timedOut = true;
        try {
          if (process.platform === 'win32') {
            const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true });
            if (killed.status !== 0) child.kill('SIGKILL');
          } else process.kill(-child.pid, 'SIGKILL');
        } catch (error) { result.error = 'Terminate failed: ' + error.message; }
        fallback = setTimeout(() => { result.error ??= 'No process exit after timeout termination'; done(); }, 2000);
      }, config.timeoutMs);
      child.once('error', error => { result.error = error.message; clearTimeout(timer); clearTimeout(fallback); done(); });
      child.once('close', (code, signal) => {
        result.exitCode = code; result.signal = signal;
        clearTimeout(timer); clearTimeout(fallback); done();
      });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') result.error = error.message; });
      child.stdin.end(prompt);
    });
  } finally { await stdout.close(); await stderr.close(); }
  return { ...result, durationMs: Date.now() - started };
}
async function jsonLines(file) {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function judge(root, task, before, baselineHead, execution, taskDirectory, config) {
  const validation = cli(root, ['validate'], config);
  const after = await readTables(root, config);
  const filesAfter = await inventory(root);
  const changed = [...new Set([...Object.keys(before.files), ...Object.keys(filesAfter)])]
    .filter(file => !isDeepStrictEqual(before.files[file], filesAfter[file])).sort();
  const diff = git(root, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'], config.env);
  await writeFile(join(taskDirectory, 'diff.patch'), diff);
  await jsonFile(join(taskDirectory, 'after.json'), { validation, tables: after, files: filesAfter });
  const events = await jsonLines(join(taskDirectory, 'codex.jsonl'));
  const audit = await jsonLines(join(taskDirectory, 'cli.jsonl'));
  const commands = audit.filter(call => [0, 1].includes(call.exitCode)).map(call => call.args[0]);
  const checks = {
    process: execution.exitCode === 0 && !execution.signal && !execution.timedOut && !execution.error,
    completedTurn: events.some(event => event.type === 'turn.completed') && !events.some(event => event.type === 'turn.failed' || event.type === 'error'),
    validation: validation.exitCode === (task.errors ? 1 : 0) &&
      isDeepStrictEqual(diagnosticKeys(validation.diagnostics), task.errors ? diagnosticKeys(before.validation.diagnostics) : []),
    valuesAndReferences: isDeepStrictEqual(normalized(after), expectedTables(before.tables, task)),
    changedFiles: isDeepStrictEqual(changed, [...task.files].sort()),
    gitDiff: diff.length > 0 && isDeepStrictEqual(git(root, ['diff', '--name-only', '-z', 'HEAD', '--'], config.env).split('\0').filter(Boolean).sort(), [...task.files].sort()),
    noCommitOrRemote: git(root, ['rev-parse', 'HEAD'], config.env).trim() === baselineHead && git(root, ['remote'], config.env).trim() === '',
    usedCli: commands.includes('read') && commands.includes('validate') &&
      (task.id === 'rename-key' ? commands.includes('rename') : commands.some(name => name === 'edit' || name === 'apply')) &&
      !audit.some(call => ['save', 'push', 'pull'].includes(call.args[0])),
  };
  if (task.id === 'numeric-cell') checks.oneLineDiff = git(root, ['diff', '--numstat', 'HEAD', '--'], config.env).trim() === '1\t1\ttables/shop-products.yaml';
  return { status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL', checks, changedFiles: changed,
    diagnosticsBefore: before.validation.diagnostics, diagnosticsAfter: validation.diagnostics, execution };
}
async function report(directory, result) {
  await jsonFile(join(directory, 'results.json'), result);
  const lines = ['# Codex acceptance', '', `Mode: ${result.dryRun ? 'DRY RUN — Codex was not started' : 'actual codex exec'}`,
    `Status: ${result.status}`, `Artifacts: ${directory}`, '',
    '| Task | Result | Diagnostics before → after |', '| --- | --- | --- |'];
  for (const task of result.tasks) lines.push(`| ${task.id} | ${task.status} | ${task.diagnosticsBefore?.length ?? '?'} → ${task.diagnosticsAfter?.length ?? 'not run'} |`);
  if (result.error) lines.push('', 'Preparation/checker error: ' + result.error);
  for (const task of result.tasks) if (task.error || task.status === 'FAIL') lines.push('', `## ${task.id}`, '',
    task.error ?? 'Failed checks: ' + Object.entries(task.checks).filter(([, passed]) => !passed).map(([name]) => name).join(', '));
  lines.push('', 'Inspect per-task prompt.md, baseline.json, execution.json, cli.jsonl, codex.jsonl, codex.stderr.log, after.json and diff.patch.',
    'Agent messages are evidence logs, never the success oracle. A dry run is not an acceptance pass.', '');
  await writeFile(join(directory, 'results.md'), lines.join('\n'));
}

async function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
    'cli-entry': { type: 'string' }, demo: { type: 'string' }, codex: { type: 'string' }, 'timeout-seconds': { type: 'string' } } });
  if (values.help) { console.log(usage); return; }
  const timeout = Number(values['timeout-seconds'] ?? 300);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 540) throw new Error('--timeout-seconds must be an integer from 1 to 540.');
  const demo = await realpath(resolve(values.demo ?? join(repository, 'packages/core/test/fixtures/acceptance')));
  const temporaryParent = await realpath(tmpdir());
  for (const forbidden of [await realpath(repository), demo]) {
    const path = relative(forbidden, temporaryParent);
    if (path === '' || !path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path)) {
      throw new Error('Temporary directory must be outside the product repository and source demo. Check TMPDIR/TEMP.');
    }
  }
  const directory = await mkdtemp(join(temporaryParent, 'vibe-codex-acceptance-'));
  const gitConfig = join(directory, 'gitconfig');
  await writeFile(gitConfig, '');
  const config = { entry: resolve(values['cli-entry'] ?? process.env.VIBE_CLI_ENTRY ?? join(repository, 'packages/cli/dist/main.js')),
    codex: values.codex ?? 'codex', timeoutMs: timeout * 1000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: '0' } };
  const result = { dryRun: Boolean(values['dry-run']), status: 'PREPARING', demo, cliEntry: config.entry, timeoutSeconds: timeout, tasks: [] };
  console.log('Artifacts: ' + directory);
  let original;
  try {
    await realpath(config.entry);
    original = await inventory(demo, true);
    const validation = cli(demo, ['validate'], config);
    const tables = await readTables(demo, config);
    await jsonFile(join(directory, 'preflight.json'), { validation, tables, files: original });
    const references = preflight(tables, validation);
    const guideRoot = join(directory, 'generated-guide');
    const initialized = command(process.execPath, [config.entry, 'init', guideRoot, '--json'], directory, config.env);
    if (initialized.status !== 0) throw new Error('init failed: ' + initialized.stdout + initialized.stderr);
    const guide = await readFile(join(guideRoot, 'AGENTS.md'));
    result.agentsSha256 = hash(guide);
    const bin = await wrappers(directory, config);
    const smokeEnv = { ...config.env, VIBE_ACCEPTANCE_AUDIT: join(directory, 'wrapper-smoke.jsonl') };
    const smoke = process.platform === 'win32'
      ? command(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'vibe --help --json'], directory, smokeEnv)
      : command(join(bin, 'vibe'), ['--help', '--json'], directory, smokeEnv);
    if (smoke.status !== 0 || !JSON.parse(smoke.stdout).ok) throw new Error('Temporary vibe wrapper failed: ' + smoke.stderr);
    for (const task of tasks) {
      const taskDirectory = join(directory, task.id), root = join(taskDirectory, 'repo');
      await mkdir(taskDirectory);
      const record = { id: task.id, title: task.title, directory: taskDirectory, status: 'PREPARING' };
      result.tasks.push(record);
      try {
        await cp(demo, root, { recursive: true, filter: async path => {
          if (excluded.has(basename(path))) return false;
          if ((await lstat(path)).isSymbolicLink()) throw new Error('Source symlink is not copied: ' + path);
          return true;
        } });
        const marker = JSON.parse((await readFile(join(root, '.vibe-spec.json'), 'utf8')).replace(/^\uFEFF/, ''));
        if (resolve(root, marker.planning_root) !== root) throw new Error('Copy must use planning_root="."; source configuration was not rewritten.');
        await writeFile(join(root, 'AGENTS.md'), guide);
        git(root, ['init', '--quiet', '--initial-branch=main'], config.env);
        for (const [key, value] of [['user.name', 'Vibe Acceptance'], ['user.email', 'acceptance@example.invalid'],
          ['core.autocrlf', 'false'], ['commit.gpgsign', 'false'], ['core.hooksPath', join(directory, 'no-hooks')]]) git(root, ['config', key, value], config.env);
        git(root, ['add', '--all', '--force'], config.env);
        git(root, ['commit', '--quiet', '-m', 'Acceptance baseline'], config.env);
        const baselineHead = git(root, ['rev-parse', 'HEAD'], config.env).trim();
        const before = { validation: cli(root, ['validate'], config), tables: await readTables(root, config), files: await inventory(root) };
        preflight(before.tables, before.validation);
        if (!isDeepStrictEqual(before.tables, tables)) throw new Error('Copied data differs from the preflight snapshot.');
        await jsonFile(join(taskDirectory, 'baseline.json'), { ...before, baselineHead, references });
        await jsonFile(join(taskDirectory, 'expected.json'), { allowedChangedFiles: task.files, diagnosticCount: task.errors, tables: expectedTables(before.tables, task) });
        const prompt = ['AGENTS.md를 먼저 읽고 그 안내의 vibe CLI로 다음 기획 작업을 해 주세요. vibe는 PATH에 있습니다.', '', task.instruction, '',
          task.errors ? '기존의 의도한 검증 오류 3개는 이번 작업 범위가 아니므로 그대로 두세요.' : '작업 후 검증 오류는 0개여야 합니다.',
          '다른 행과 셀, 스키마, AGENTS.md, README, 제품 소스와 설정은 수정하지 마세요. YAML 원본을 직접 편집하지 말고 CLI를 사용하세요.',
          'Git 커밋·push·pull·save 및 외부 원본 수정은 금지입니다. 이 복사본에서만 작업하고 요청용 임시 JSON 파일은 작업 후 삭제하세요.',
          '변경 후 CLI 검증과 Git diff를 확인하고 바뀐 파일 및 남은 진단을 짧게 보고하세요.', ''].join('\n');
        await writeFile(join(taskDirectory, 'prompt.md'), prompt);
        record.diagnosticsBefore = before.validation.diagnostics;
        if (result.dryRun) record.status = 'NOT_RUN';
        else {
          console.log('Running: ' + task.id);
          const execution = await runCodex(root, taskDirectory, prompt, config);
          record.execution = execution;
          await jsonFile(join(taskDirectory, 'execution.json'), execution);
          Object.assign(record, await judge(root, task, before, baselineHead, execution, taskDirectory, config));
        }
      } catch (error) { record.status = 'FAIL'; record.error = error.stack ?? error.message; }
      await report(directory, result);
      console.log(task.id + ': ' + record.status);
    }
    result.status = result.tasks.some(task => task.status === 'FAIL') ? 'FAIL' : result.dryRun ? 'DRY_RUN_READY' : 'PASS';
  } catch (error) { result.status = 'FAIL'; result.error = error.stack ?? error.message; }
  finally {
    if (original) {
      try {
        result.sourceUnchanged = isDeepStrictEqual(original, await inventory(demo, true));
        if (!result.sourceUnchanged) throw new Error('Source demo changed during the run; inspect it without resetting it.');
      } catch (error) { result.status = 'FAIL'; result.sourceUnchanged = false; result.error = error.message; }
    }
    await report(directory, result);
  }
  console.log(result.status + ': ' + join(directory, 'results.md'));
  if (result.status === 'FAIL') process.exitCode = 1;
}

main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
