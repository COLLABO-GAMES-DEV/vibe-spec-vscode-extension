import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import * as vscode from 'vscode';
import { loadProject, type exportMarkdown, type GitResult, type GitStatus, type Project } from '@vibe-spec/core';

type MarkdownExport = Awaited<ReturnType<typeof exportMarkdown>>;

interface ExtensionApi {
  getProject(): Project | undefined;
  git: { status?: GitStatus };
}

async function eventually(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

// Send Escape through VS Code's actual quick-input command until the picker opens
// and cancellation reaches the extension. No product picker or filesystem is mocked.
async function cancelWorkspacePick(command: string, planning: vscode.Uri) {
  let completed = false;
  const operation = Promise.resolve(vscode.commands.executeCommand(command, planning)).finally(() => { completed = true; });
  await eventually(async () => {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    return completed;
  }, 'Cancelling the workspace picker did not finish the command.');
  await operation;
}

suite('vibe-spec multiple workspace folders in VS Code', function () {
  let api: ExtensionApi;
  let first: vscode.WorkspaceFolder, second: vscode.WorkspaceFolder;
  let firstConfig: string, secondConfig: string, initialConfig: string;
  let originalPlanning: string, selectedPlanning: string, changedPlanning: string, emptyPlanning: string;

  suiteSetup(async function () {
    // The normal single-folder suite also collects this file. Run these scenarios
    // with: vscode-test --config test/multi-root.config.mjs
    if (vscode.workspace.workspaceFolders?.length !== 2) this.skip();
    [first, second] = vscode.workspace.workspaceFolders! as [vscode.WorkspaceFolder, vscode.WorkspaceFolder];
    firstConfig = join(first.uri.fsPath, '.vibe-spec.json');
    secondConfig = join(second.uri.fsPath, '.vibe-spec.json');
    initialConfig = await readFile(firstConfig, 'utf8');
    originalPlanning = resolve(first.uri.fsPath, JSON.parse(initialConfig).planning_root);
    selectedPlanning = join(second.uri.fsPath, '선택한 기획');
    changedPlanning = join(second.uri.fsPath, '변경한 기획');
    emptyPlanning = join(second.uri.fsPath, '초기화할 빈 폴더');
    const fixture = join(process.env.VIBE_REPO_ROOT!, 'packages/core/test/fixtures/project');
    await cp(fixture, selectedPlanning, { recursive: true });
    await cp(fixture, changedPlanning, { recursive: true });
    await mkdir(emptyPlanning);
    api = await vscode.extensions.getExtension<ExtensionApi>('ijun17.vibe-spec')!.activate();
  });

  teardown(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });

  test('does not adopt the first saved configuration, and cancelling selection or initialization changes no files', async () => {
    assert.equal(api.getProject(), undefined);
    await cancelWorkspacePick('vibe.selectFolder', vscode.Uri.file(selectedPlanning));
    await cancelWorkspacePick('vibe.initFolder', vscode.Uri.file(emptyPlanning));
    assert.equal(api.getProject(), undefined);
    assert.equal(await readFile(firstConfig, 'utf8'), initialConfig);
    await assert.rejects(readFile(secondConfig), { code: 'ENOENT' });
    assert.deepEqual(await readdir(emptyPlanning), []);
    await assert.rejects(async () => { await vscode.commands.executeCommand('vibe.export'); }, /먼저 기획 폴더를 선택/);
  });

  test('writes only the chosen workspace config and routes import, save, push and pull to its planning folder', async () => {
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(selectedPlanning), second.uri);
    assert.equal(api.getProject()?.root, selectedPlanning);
    assert.equal(await readFile(firstConfig, 'utf8'), initialConfig);
    const selectedConfig = JSON.parse(await readFile(secondConfig, 'utf8')) as { planning_root: string };
    assert.equal(resolve(second.uri.fsPath, selectedConfig.planning_root), selectedPlanning);

    const source = vscode.Uri.file(join(process.env.VIBE_REPO_ROOT!, 'packages/core/test/fixtures/import/items.csv'));
    const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('vibe.import', source);
    assert.equal(panel?.title, '불러오기');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: selectedPlanning, encoding: 'utf8' }).trim();
    const remote = join(second.uri.fsPath, '선택한 원격.git');
    git('init', '-b', 'main'); git('config', 'user.name', 'Workspace Test'); git('config', 'user.email', 'workspace@example.invalid');
    git('config', 'commit.gpgsign', 'false'); git('init', '--bare', '-b', 'main', remote);
    git('remote', 'add', 'origin', remote);
    const saved = await vscode.commands.executeCommand<GitResult>('vibe.save', '선택한 두 번째 프로젝트 저장');
    assert.equal(await realpath(saved.status.root), await realpath(selectedPlanning));
    assert.equal(git('log', '-1', '--format=%s'), '선택한 두 번째 프로젝트 저장');
    for (const command of ['vibe.push', 'vibe.pull']) {
      const result = await vscode.commands.executeCommand<GitResult>(command);
      assert.equal(await realpath(result.status.root), await realpath(selectedPlanning));
      assert.equal(result.completed, true);
    }
    await assert.rejects(readFile(join(originalPlanning, '.git', 'HEAD')), { code: 'ENOENT' });
  });

  test('watches the selected config, can switch projects, and never falls back to a parent config after deletion', async () => {
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(selectedPlanning), second.uri);
    await writeFile(secondConfig, JSON.stringify({ planning_root: relative(second.uri.fsPath, changedPlanning) }) + '\n');
    await eventually(() => api.getProject()?.root === changedPlanning,
      'Editing the second workspace config did not switch the active project.');
    await eventually(async () => Boolean(api.git.status && await realpath(api.git.status.root) === await realpath(changedPlanning)),
      'Git status did not follow the selected planning folder.');
    await rm(secondConfig);
    await eventually(() => api.getProject() === undefined,
      'Deleting the second workspace config fell back to the first folder configuration.');
    assert.equal(await readFile(firstConfig, 'utf8'), initialConfig);
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(originalPlanning), first.uri);
    assert.equal(api.getProject()?.root, originalPlanning);
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(selectedPlanning), second.uri);
    assert.equal(api.getProject()?.root, selectedPlanning);
  });

  test('a remembered choice still opens the picker, and initialization can explicitly target the second workspace', async () => {
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(selectedPlanning), second.uri);
    const before = await readFile(secondConfig, 'utf8');
    await cancelWorkspacePick('vibe.selectFolder', vscode.Uri.file(originalPlanning));
    await cancelWorkspacePick('vibe.initFolder', vscode.Uri.file(emptyPlanning));
    assert.equal(await readFile(secondConfig, 'utf8'), before);
    assert.equal(await readFile(firstConfig, 'utf8'), initialConfig);
    assert.equal(api.getProject()?.root, selectedPlanning);
    assert.deepEqual(await readdir(emptyPlanning), []);
    await vscode.commands.executeCommand('vibe.initFolder', vscode.Uri.file(emptyPlanning), second.uri);
    assert.equal(api.getProject()?.root, emptyPlanning);
    assert.equal(await readFile(firstConfig, 'utf8'), initialConfig);
    const config = JSON.parse(await readFile(secondConfig, 'utf8')) as { planning_root: string };
    assert.equal(resolve(second.uri.fsPath, config.planning_root), emptyPlanning);
    assert.deepEqual(await readdir(join(emptyPlanning, 'tables')), []);
  });

  test('Markdown export follows the chosen planning root and its output setting across workspace switches', async () => {
    const firstOutput = '첫 번째 개발 문서', secondOutput = '두 번째 개발 문서';
    await writeFile(join(originalPlanning, '.vibe-spec.json'), JSON.stringify({ planning_root: '.', export_directory: firstOutput }) + '\n');
    await writeFile(join(selectedPlanning, '.vibe-spec.json'), JSON.stringify({ planning_root: '.', export_directory: secondOutput }) + '\n');
    const sourcePath = join(selectedPlanning, 'tables/items.yaml');
    await writeFile(sourcePath, (await readFile(sourcePath, 'utf8')).replace('name: "골드"', 'name: "두 번째 기획 골드"'));
    const firstBefore = await loadProject(originalPlanning), secondBefore = await loadProject(selectedPlanning);
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(selectedPlanning), second.uri);
    const exportedSecond = await vscode.commands.executeCommand<MarkdownExport>('vibe.export');
    assert.equal(await realpath(exportedSecond.directory), await realpath(join(selectedPlanning, secondOutput)));
    assert.equal(exportedSecond.revision, secondBefore.revision);
    assert.match(await readFile(join(exportedSecond.directory, 'items.md'), 'utf8'), /두 번째 기획 골드/);
    const offers = await readFile(join(exportedSecond.directory, 'offers.md'), 'utf8');
    assert.match(offers, /## Schema/);
    assert.ok(offers.includes('900719925474099312345'));
    await assert.rejects(readFile(join(originalPlanning, firstOutput, 'items.md')), { code: 'ENOENT' });

    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(originalPlanning), first.uri);
    const exportedFirst = await vscode.commands.executeCommand<MarkdownExport>('vibe.export');
    assert.equal(await realpath(exportedFirst.directory), await realpath(join(originalPlanning, firstOutput)));
    assert.equal(exportedFirst.revision, firstBefore.revision);
    assert.doesNotMatch(await readFile(join(exportedFirst.directory, 'items.md'), 'utf8'), /두 번째 기획 골드/);
    for (const before of [firstBefore, secondBefore]) {
      const after = await loadProject(before.root);
      assert.equal(after.revision, before.revision);
      assert.deepEqual(after.sources, before.sources);
    }
  });
});
