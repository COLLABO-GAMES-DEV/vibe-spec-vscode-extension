import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceFolder = mkdtempSync(join(tmpdir(), 'vibe VS Code 한글-'));
process.on('exit', () => rmSync(workspaceFolder, { recursive: true, force: true, maxRetries: 3 }));
export default defineConfig({
  files: 'dist/test/**/*.test.cjs', version: '1.141.0', workspaceFolder,
  ...(process.env.VSCODE_EXECUTABLE ? { useInstallation: { fromPath: process.env.VSCODE_EXECUTABLE } } : {}),
  launchArgs: ['--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox'],
  env: { VIBE_REPO_ROOT: fileURLToPath(new URL('../../', import.meta.url)), TEST_NODE_BINARY: process.execPath },
  mocha: { timeout: 20_000, ui: 'tdd' },
});
