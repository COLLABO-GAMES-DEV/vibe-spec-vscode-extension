import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkRelease, checkUnpublished } from './release.mjs';

const manifest = { publisher: 'ijun17', name: 'vibe-spec', license: 'UNLICENSED', version: '1.2.3' };
const gallery = versions => ({ publisher: { publisherName: 'ijun17' }, extensionName: 'vibe-spec', versions: versions.map(version => ({ version })) });

test('release tag matches the extension manifest and determines its artifact', () => {
  assert.deepEqual(checkRelease('v1.2.3', manifest), { tag: 'v1.2.3', version: '1.2.3', vsix: 'artifacts/vibe-spec-1.2.3.vsix' });
  for (const tag of ['main', '1.2.3', 'v1.2.4', 'v01.2.3', 'v1.2.3-beta', 'v1.2.3\nvsix=other', 'v$(echo bad)']) {
    assert.throws(() => checkRelease(tag, manifest));
  }
});

test('wrong publisher, extension or license cannot be released', () => {
  for (const change of [{ publisher: 'other' }, { name: 'other' }, { license: 'MIT' }]) {
    assert.throws(() => checkRelease('v1.2.3', { ...manifest, ...change }));
  }
});

test('duplicate detection checks every published version, not only latest', () => {
  assert.doesNotThrow(() => checkUnpublished(manifest, gallery(['1.2.2', '1.0.0'])));
  assert.throws(() => checkUnpublished(manifest, gallery(['2.0.0', '1.2.3', '1.0.0'])), /already exists/);
});

test('unknown or malformed Marketplace responses fail closed', () => {
  for (const value of [null, {}, gallery([]), { ...gallery(['1.0.0']), extensionName: 'other' }, { ...gallery(['1.0.0']), versions: [{}] }]) {
    assert.throws(() => checkUnpublished(manifest, value), /Cannot verify/);
  }
});

test('real release CLI rejects a mismatch without writing step outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-release-'));
  try {
    const output = join(dir, 'outputs');
    const script = fileURLToPath(new URL('./release.mjs', import.meta.url));
    const actual = JSON.parse(readFileSync(new URL('../packages/vscode/package.json', import.meta.url), 'utf8'));
    const env = { ...process.env, GITHUB_OUTPUT: output };
    const good = spawnSync(process.execPath, [script, 'check', `v${actual.version}`], { env, encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    const before = readFileSync(output, 'utf8');
    assert.ok(before.includes(`vsix=artifacts/vibe-spec-${actual.version}.vsix\n`));
    const bad = spawnSync(process.execPath, [script, 'check', 'v999.999.999'], { env, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /does not match/);
    assert.equal(readFileSync(output, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow keeps manual/branch runs and shared checks away from publish credentials', () => {
  const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
  const { parse } = require('yaml');
  const read = name => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const release = read('release');
  const checks = read('check');
  assert.deepEqual(release.on.push, { tags: ['v*'] });
  assert.ok(release.on.workflow_dispatch);
  assert.deepEqual(checks.on.push, { branches: ['**'] });
  assert.equal(checks.on.workflow_call.inputs.platform.default, 'all');
  assert.deepEqual(checks.on.workflow_dispatch.inputs.platform.options, ['windows', 'all']);
  assert.equal(checks.on.workflow_dispatch.inputs.platform.default, 'windows');
  assert.equal(checks.jobs.check.strategy.matrix.os,
    '${{ fromJSON(github.event_name == \'workflow_dispatch\' && inputs.platform == \'windows\' && \'["windows-latest"]\' || (github.event_name == \'workflow_dispatch\' || startsWith(github.ref, \'refs/tags/v\')) && \'["ubuntu-latest","windows-latest"]\' || \'["ubuntu-latest"]\') }}');
  assert.equal(checks.jobs.check.steps.find(step => step.run?.includes('exec playwright test')).run,
    'pnpm --filter @vibe-spec/webview exec playwright test --retries=0');
  assert.deepEqual(checks.jobs.check.strategy.matrix.suite, ['core-cli', 'vscode', 'webview']);
  assert.equal(release.jobs.checks.uses, './.github/workflows/check.yml');
  assert.equal(release.jobs.checks.secrets, undefined);
  assert.equal(release.jobs.package.needs, 'checks');
  assert.equal(release.jobs.publish.needs, 'package');
  assert.equal(release.jobs.publish.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  assert.equal(release.jobs.publish.environment, 'marketplace');
  assert.ok(!JSON.stringify(release.jobs.package).includes('VSCE_PAT'));
  const steps = release.jobs.publish.steps;
  const publish = steps.find(step => step.env?.VSCE_PAT);
  assert.equal(publish.env.VSCE_PAT, '${{ secrets.VSCE_PAT }}');
  assert.match(publish.run, /vsce publish --packagePath/);
  assert.ok(!publish.run.includes('--skip-duplicate'));
  assert.equal(steps.filter(step => step.env?.VSCE_PAT).length, 1);
  assert.ok(steps.findIndex(step => step.run?.includes('gh release create')) < steps.indexOf(publish));
  assert.ok(steps.findIndex(step => step.run?.includes('gh release edit')) > steps.indexOf(publish));
});
