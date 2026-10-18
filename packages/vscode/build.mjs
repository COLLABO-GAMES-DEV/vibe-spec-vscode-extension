import { build } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', external: ['vscode'], outfile: 'dist/extension.cjs' });
// The same CLI is usable by a local agent after installing only the VSIX.
await build({ entryPoints: ['../cli/src/main.ts'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node24', outfile: 'dist/vibe.cjs' });
await cp('../webview/dist', 'dist/webview', { recursive: true });
const tests = (await readdir('test')).filter(file => file.endsWith('.test.ts')).map(file => 'test/' + file);
if (tests.length) await build({ entryPoints: tests, bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', external: ['vscode'], outdir: 'dist/test', outExtension: { '.js': '.cjs' } });
