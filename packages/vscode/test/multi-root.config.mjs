import { defineConfig } from '@vscode/test-cli';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'vibe 다중 workspace-'));
const first = join(root, '첫 번째 프로젝트'), second = join(first, '두 번째 프로젝트');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
mkdirSync(second, { recursive: true });
cpSync(join(repo, 'packages/core/test/fixtures/project'), join(first, '기존 기획'), { recursive: true });
writeFileSync(join(first, '.vibe-spec.json'), JSON.stringify({ planning_root: '기존 기획' }) + '\n');
const workspaceFolder = join(root, '다중 폴더.code-workspace');
writeFileSync(workspaceFolder, JSON.stringify({ folders: [{ path: first }, { path: second }] }));
process.on('exit', () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

export default defineConfig({
  files: '../dist/test/multi-root.test.cjs', extensionDevelopmentPath: '..',
  version: '1.141.0', workspaceFolder,
  ...(process.env.VSCODE_EXECUTABLE ? { useInstallation: { fromPath: process.env.VSCODE_EXECUTABLE } } : {}),
  launchArgs: ['--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox'],
  env: { VIBE_REPO_ROOT: repo, TEST_NODE_BINARY: process.execPath },
  mocha: { timeout: 20_000, ui: 'tdd' },
});
