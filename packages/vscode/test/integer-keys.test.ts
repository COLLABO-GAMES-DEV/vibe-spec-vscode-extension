import { replaceTestFile } from './replaceTestFile.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { initProject, readPath, type Project } from '@vibe-spec/core';
import type { ClientMessage, HostMessage, Snapshot } from '../../webview/src/protocol.js';

interface ExtensionApi {
  getProject(): Project | undefined;
  tables: vscode.TreeDataProvider<unknown>;
  errors: vscode.TreeDataProvider<unknown>;
}
async function eventually(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
async function items(provider: vscode.TreeDataProvider<unknown>) {
  return Promise.all(((await provider.getChildren()) ?? []).map(item => provider.getTreeItem(item)));
}
function label(item: vscode.TreeItem) { return typeof item.label === 'string' ? item.label : item.label?.label; }

// Observe snapshots through the real native Webview transport, as in documents.test.ts.
// Browser tests separately exercise React's rendering and explicit numeric sorting.
function bridge(panel: vscode.WebviewPanel) {
  const messages: HostMessage[] = [];
  const listeners = new Set<() => void>();
  const subscription = panel.webview.onDidReceiveMessage(message => {
    if (message?.type !== 'integerNativeObservation') return;
    messages.push(message.message as HostMessage);
    for (const notify of listeners) notify();
  });
  const snapshot = (predicate: (snapshot: Snapshot) => boolean, after = 0) => new Promise<Snapshot>((resolve, reject) => {
    const finish = () => {
      const found = messages.slice(after).find((message): message is Snapshot => message.type === 'snapshot' && predicate(message));
      if (!found) return;
      clearTimeout(timer); listeners.delete(finish); resolve(found);
    };
    const timer = setTimeout(() => {
      listeners.delete(finish);
      reject(new Error('No matching integer Key snapshot: ' + JSON.stringify(messages.slice(after))));
    }, 10_000);
    listeners.add(finish); finish();
  });
  panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-integer-native-test'"></head><body>
    <script nonce="integer-native-test">
      const host = acquireVsCodeApi();
      addEventListener('message', event => {
        if (event.data.type === 'integerNativeRequest') host.postMessage(event.data.message);
        else host.postMessage({ type: 'integerNativeObservation', message: event.data });
      });
      host.postMessage({ type: 'ready' });
    </script></body></html>`;
  return { snapshot, mark: () => messages.length,
    send: (message: ClientMessage) => panel.webview.postMessage({ type: 'integerNativeRequest', message }),
    dispose: () => subscription.dispose() };
}

suite('integer Keys and source row order in native VS Code', function () {
  this.timeout(30_000);
  let api: ExtensionApi, workspaceRoot: string, projectRoot: string;
  const bridges: ReturnType<typeof bridge>[] = [];
  suiteSetup(async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'The native test runner must open a temporary workspace.');
    workspaceRoot = workspace.uri.fsPath;
    projectRoot = await mkdtemp(join(workspaceRoot, 'integer Key fixture-'));
    await initProject(projectRoot);
    await writeFile(join(projectRoot, 'schemas/levels.yaml'), 'primary_key: level\ncolumns:\n  level:\n    type: integer\n  note:\n    type: text\n');
    await writeFile(join(projectRoot, 'tables/levels.yaml'), 'schema: "levels"\nrows:\n' + ['10', '2', '1', '001'].map(key => `  - level: "${key}"\n    note: "Level ${key}"\n`).join(''));
    await writeFile(join(projectRoot, 'schemas/quests.yaml'), 'primary_key: key\ncolumns:\n  key:\n    type: string\n  level:\n    type: ref\n    table: levels\n');
    await writeFile(join(projectRoot, 'tables/quests.yaml'), 'schema: "quests"\nrows:\n  - key: "first"\n    level: "1"\n');
    await mkdir(join(projectRoot, 'documents'));
    await writeFile(join(projectRoot, 'documents/guide.md'), '# Levels\n\n[Level](levels/1).\n');
    const extension = vscode.extensions.getExtension<ExtensionApi>('ijun17.vibe-spec');
    assert.ok(extension);
    api = await extension.activate();
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(projectRoot));
    assert.equal(api.getProject()?.root, projectRoot);
  });
  teardown(async () => {
    for (const page of bridges.splice(0)) page.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  suiteTeardown(async () => {
    if (workspaceRoot) await rm(join(workspaceRoot, '.vibe-spec.json'), { force: true });
    if (api) await eventually(() => api.getProject() === undefined, 'Integer Key fixture cleanup did not release the project.');
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true, maxRetries: 3 });
  });
  async function open(table: string) {
    const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('vibe.openTable', table);
    assert.ok(panel);
    assert.equal(panel.title, table);
    assert.match(panel.webview.html, /data-mode="table"/);
    const page = bridge(panel); bridges.push(page);
    return { page, state: await page.snapshot(state => state.table === table) };
  }

  test('opens integer rows in source order, renames through the Webview and watches external replacement and filename rename', async () => {
    const tableItems = await items(api.tables);
    const table = tableItems.find(item => label(item) === 'levels');
    assert.ok(table);
    assert.equal(table.description, '오류 0개');
    assert.equal(table.command?.command, 'vibe.openTable');
    assert.deepEqual(await items(api.errors), []);
    const file = join(projectRoot, 'tables/levels.yaml');
    const original = await readFile(file, 'utf8');
    const { page, state } = await open('levels');
    assert.equal(state.schema.primary_key, 'level');
    assert.equal(state.schema.columns.level!.type, 'integer');
    assert.deepEqual(state.rows.map(row => row.level), ['10', '2', '1', '001']);
    assert.deepEqual(state.diagnostics, []);
    assert.equal(await readFile(file, 'utf8'), original);

    let after = page.mark();
    await page.send({ type: 'rename', requestId: 'integer-key-rename', revision: state.revision, key: '1', to: '3' });
    const renamed = await page.snapshot(snapshot => snapshot.requestId === 'integer-key-rename', after);
    assert.deepEqual(renamed.rows.map(row => row.level), ['10', '2', '3', '001']);
    assert.notEqual(renamed.revision, state.revision);
    assert.deepEqual(renamed.diagnostics, []);
    assert.equal(await readFile(file, 'utf8'), original.replace('level: "1"', 'level: "3"'));
    assert.deepEqual(readPath(api.getProject()!, 'quests/first/level'), { present: true, value: '3' });
    assert.deepEqual(readPath(api.getProject()!, 'levels/001/note'), { present: true, value: 'Level 001' });
    assert.equal(await readFile(join(projectRoot, 'documents/guide.md'), 'utf8'), '# Levels\n\n[Level](levels/3).\n');

    after = page.mark();
    const external = (await readFile(file, 'utf8')).replace('Level 2', 'Externally edited');
    await writeFile(file + '.tmp', external);
    await replaceTestFile(file + '.tmp', file);
    const watched = await page.snapshot(snapshot => snapshot.rows.some(row => row.level === '2' && row.note === 'Externally edited'), after);
    assert.deepEqual(watched.rows.map(row => row.level), ['10', '2', '3', '001']);
    assert.notEqual(watched.revision, renamed.revision);
    assert.equal(await readFile(file, 'utf8'), external);

    // Raw external filename changes are observed, even when they leave refs for the user to repair.
    const moved = join(projectRoot, 'tables/level-order.yaml');
    await replaceTestFile(file, moved);
    await eventually(async () => {
      const names = (await items(api.tables)).map(label);
      return names.includes('level-order') && !names.includes('levels');
    }, 'The watcher did not observe the integer table filename rename.');
    const reopened = await open('level-order');
    assert.deepEqual(reopened.state.rows.map(row => row.level), ['10', '2', '3', '001']);
    assert.equal(reopened.state.schema.columns.level!.type, 'integer');
    after = reopened.page.mark();
    await writeFile(moved, external.replace('Externally edited', 'Edited after file rename'));
    const changedAgain = await reopened.page.snapshot(snapshot => snapshot.rows.some(row => row.note === 'Edited after file rename'), after);
    assert.deepEqual(changedAgain.rows.map(row => row.level), ['10', '2', '3', '001']);
  });
});
