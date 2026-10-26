import { replaceTestFile } from './replaceTestFile.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as vscode from 'vscode';
import { createPlan, getPlan, loadProject, readPath, writeVariant, VibeError, type Diagnostic, type exportMarkdown, type GitStatus, type Project } from '@vibe-spec/core';

type MarkdownExport = Awaited<ReturnType<typeof exportMarkdown>>;

interface ExtensionApi {
  tables: vscode.TreeDataProvider<unknown>;
  errors: vscode.TreeDataProvider<unknown>;
  plans: vscode.TreeDataProvider<unknown>;
  refresh(): Promise<void>;
  getProject(): Project | undefined;
  onDidRefresh: vscode.Event<void>;
  git: { status?: GitStatus; refresh(): Promise<void>; getChildren(): vscode.TreeItem[]; draft(table: string, active: boolean): void };
}

async function treeItems(provider: vscode.TreeDataProvider<unknown>): Promise<vscode.TreeItem[]> {
  const children = await provider.getChildren();
  return Promise.all((children ?? []).map((child) => provider.getTreeItem(child)));
}

function label(item: vscode.TreeItem): string | undefined {
  return typeof item.label === 'string' ? item.label : item.label?.label;
}

async function eventually(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastMissingPath: VibeError | undefined;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      // A watcher can expose truncated YAML before an external write completes.
      if (!(error instanceof VibeError) || error.code !== 'PATH_NOT_FOUND') throw error;
      lastMissingPath = error;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail(message + (lastMissingPath ? `\nLast observed ${lastMissingPath.code}: ${lastMissingPath.message}` : ''));
}

suite('vibe-spec extension in VS Code', function () {
  this.timeout(20_000);

  let api: ExtensionApi;
  let workspaceRoot: string;
  let sandbox: string;
  let outsideSandbox: string;
  let fixture: string;
  let projectRoot: string;
  let fixtureNumber = 0;
  let restoreWatcherExcludes: (() => Thenable<void>) | undefined;

  suiteSetup(async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'The VS Code test runner must open a temporary workspace.');
    workspaceRoot = workspace.uri.fsPath;
    const repoRoot = process.env.VIBE_REPO_ROOT;
    assert.ok(repoRoot, 'The test runner must set VIBE_REPO_ROOT.');
    fixture = join(repoRoot, 'packages/core/test/fixtures/project');
    assert.match(workspaceRoot.normalize('NFC'), /한글/);
    sandbox = await mkdtemp(join(workspaceRoot, '기획 통합 테스트-'));
    // Compare paths in the same spelling as VS Code, including Windows drive case.
    outsideSandbox = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'vibe 외부 기획-'))).fsPath;

    const extension = vscode.extensions.getExtension<ExtensionApi>('ijun17.vibe-spec');
    assert.ok(extension, 'The development extension must be installed.');
    api = await extension.activate();
  });

  setup(async () => {
    projectRoot = join(sandbox, `프로젝트 ${++fixtureNumber}`);
    await cp(fixture, projectRoot, { recursive: true });
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(projectRoot));
    assert.equal(api.getProject()?.root, projectRoot);
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  suiteTeardown(async () => {
    try {
      if (workspaceRoot) {
        await rm(join(workspaceRoot, '.vibe-spec.json'), { force: true });
        if (api) await eventually(() => api.getProject() === undefined, 'Cleanup did not release the selected planning folder.');
      }
      if (sandbox) await rm(sandbox, { recursive: true, force: true, maxRetries: 3 });
      if (outsideSandbox) await rm(outsideSandbox, { recursive: true, force: true, maxRetries: 3 });
    } finally {
      // Restoring watcherExclude can restart VS Code's watcher. First observe the
      // configuration deletion and release the selected project's Git watcher.
      await restoreWatcherExcludes?.();
    }
  });

  test('folder selection persists a relative planning root and loads the project', async () => {
    const config = JSON.parse(await readFile(join(workspaceRoot, '.vibe-spec.json'), 'utf8')) as {
      planning_root: string;
    };
    assert.equal(isAbsolute(config.planning_root), false);
    assert.equal(resolve(workspaceRoot, config.planning_root), projectRoot);
    assert.deepEqual(readPath(api.getProject()!, 'items/currency_gold/name'), {
      value: '골드', present: true,
    });
  });

  test('a planning folder outside the workspace is resolved and its files are watched', async () => {
    const externalRoot = join(outsideSandbox, '외부 기획 # % &');
    await cp(fixture, externalRoot, { recursive: true });
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(externalRoot));
    const config = JSON.parse(await readFile(join(workspaceRoot, '.vibe-spec.json'), 'utf8')) as {
      planning_root: string;
    };
    assert.equal(isAbsolute(config.planning_root), isAbsolute(relative(workspaceRoot, externalRoot)));
    assert.equal(resolve(workspaceRoot, config.planning_root), externalRoot);
    await vscode.commands.executeCommand('vibe.refresh');
    assert.equal(api.getProject()?.root, externalRoot);

    const file = join(externalRoot, 'tables/items.yaml');
    const text = await readFile(file, 'utf8');
    // Make the writer's intermediate truncation visible before its final write.
    await writeFile(file, '');
    await eventually(() => api.getProject()?.root === externalRoot
      && api.getProject()?.sources.get('tables/items.yaml') === '',
    'The filesystem watcher did not load the intermediate empty table outside the workspace.');
    await writeFile(file, text.replace('name: "골드"', 'name: "워크스페이스 밖 수정"'));
    await eventually(() => {
      const project = api.getProject();
      if (!project || project.root !== externalRoot) return false;
      const cell = readPath(project, 'items/currency_gold/name') as { value: unknown };
      return cell.value === '워크스페이스 밖 수정';
    }, 'The filesystem watcher did not load the edit outside the workspace.');
  });

  test('removing the selection configuration clears the loaded project and sidebar', async () => {
    assert.ok(api.getProject());
    assert.equal((await treeItems(api.tables)).length, 2);
    // VS Code coalesces an unobserved create/delete pair. First observe a real config change.
    const configuredRoot = join(sandbox, 'selected-through-config');
    await cp(fixture, configuredRoot, { recursive: true });
    await writeFile(join(workspaceRoot, '.vibe-spec.json'), JSON.stringify({
      planning_root: relative(workspaceRoot, configuredRoot),
    }));
    await eventually(() => api.getProject()?.root === configuredRoot,
      'The configuration watcher did not observe the new planning folder.');
    const refreshedRoots: (string | null)[] = [];
    const subscription = api.onDidRefresh(() => {
      refreshedRoots.push(api.getProject()?.root ?? null);
    });
    try {
      await rm(join(workspaceRoot, '.vibe-spec.json'));
      await eventually(async () => api.getProject() === undefined &&
        (await treeItems(api.tables)).length === 0 && (await treeItems(api.errors)).length === 0,
      'Deleting the configuration did not clear the previous project and sidebar.');
    } catch (error) {
      console.error('Configuration deletion watcher state:', JSON.stringify({
        currentRoot: api.getProject()?.root ?? null,
        refreshedRoots,
      }));
      throw error;
    } finally {
      subscription.dispose();
    }
  });

  test('configuration replacement, deletion and recreation survive watcher exclusions and their restoration', async () => {
    const configuration = vscode.workspace.getConfiguration('files');
    const excludes = configuration.inspect<Record<string, boolean>>('watcherExclude')?.workspaceValue;
    const config = join(workspaceRoot, '.vibe-spec.json');
    const replacement = config + '.replacement';
    const changedRoot = join(outsideSandbox, '설정 교체 기획');
    await cp(fixture, changedRoot, { recursive: true });
    const changedConfig = JSON.stringify({ planning_root: relative(workspaceRoot, changedRoot) }) + '\n';
    const originalConfig = await readFile(config, 'utf8');
    const refreshedRoots: (string | null)[] = [];
    const subscription = api.onDidRefresh(() => refreshedRoots.push(api.getProject()?.root ?? null));
    try {
      for (const phase of ['excluded', 'restored'] as const) {
        await configuration.update('watcherExclude', phase === 'excluded'
          ? { ...excludes, '**/.git/**': true, '**/.vibe-spec.json': true }
          : excludes, vscode.ConfigurationTarget.Workspace);
        assert.deepEqual(vscode.workspace.getConfiguration('files').inspect('watcherExclude')?.workspaceValue,
          phase === 'excluded' ? { ...excludes, '**/.git/**': true, '**/.vibe-spec.json': true } : excludes);
        if (phase === 'restored') {
          await writeFile(config, originalConfig);
          await eventually(() => api.getProject()?.root === projectRoot,
            'Recreating the configuration after restoring exclusions did not reload the project.');
        }
        // Replace the file itself so the watch must survive changes of inode.
        await writeFile(replacement, changedConfig);
        await replaceTestFile(replacement, config);
        assert.equal(await readFile(config, 'utf8'), changedConfig);
        await eventually(() => api.getProject()?.root === changedRoot,
          `Configuration replacement was not observed (${phase}).`);
        await rm(config);
        await assert.rejects(stat(config), { code: 'ENOENT' });
        await eventually(async () => api.getProject() === undefined
          && (await treeItems(api.tables)).length === 0 && (await treeItems(api.errors)).length === 0,
        `Configuration deletion did not release the project and sidebar (${phase}).`);
      }
    } catch (error) {
      console.error('Configuration exclusion watcher state:', JSON.stringify({
        currentRoot: api.getProject()?.root ?? null, refreshedRoots,
        watcherExclude: vscode.workspace.getConfiguration('files').get('watcherExclude'),
      }));
      throw error;
    } finally {
      subscription.dispose();
      await configuration.update('watcherExclude', excludes, vscode.ConfigurationTarget.Workspace);
      await rm(replacement, { force: true });
    }
  });

  test('Windows persists and watches a planning folder on another drive', async function () {
    if (process.platform !== 'win32') this.skip();
    // SUBST supplies a second drive without requiring another physical volume.
    let drive: string | undefined;
    for (const letter of 'ZYXWVUTSRQPONMLKJIHGFED') {
      try { await stat(letter + ':\\'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        drive = letter + ':'; break;
      }
    }
    assert.ok(drive, 'The Windows runner needs one unused drive letter for this regression.');
    execFileSync('subst', [drive, outsideSandbox]);
    try {
      const uri = vscode.Uri.file(join(drive + '\\', '다른 드라이브 기획'));
      await cp(fixture, uri.fsPath, { recursive: true });
      await vscode.commands.executeCommand('vibe.selectFolder', uri);
      const configPath = join(workspaceRoot, '.vibe-spec.json');
      const config = JSON.parse(await readFile(configPath, 'utf8')) as { planning_root: string };
      assert.equal(isAbsolute(config.planning_root), true);
      assert.equal(resolve(workspaceRoot, config.planning_root), uri.fsPath);
      assert.equal(config.planning_root.includes('\\'), false);

      // Make the configuration watcher resolve the saved value after switching away.
      await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(projectRoot));
      await writeFile(configPath, JSON.stringify(config) + '\n');
      await eventually(() => api.getProject()?.root === uri.fsPath,
        'The saved cross-drive path did not reload the selected folder.');
      const file = join(uri.fsPath, 'tables/items.yaml');
      await writeFile(file, (await readFile(file, 'utf8')).replace('name: "골드"', 'name: "다른 드라이브 수정"'));
      await eventually(() => (readPath(api.getProject()!, 'items/currency_gold/name') as { value: unknown }).value === '다른 드라이브 수정',
        'The cross-drive watcher did not load the external edit.');
    } finally {
      try { await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(projectRoot)); }
      finally { execFileSync('subst', [drive, '/D']); }
    }
  });

  test('Korean filenames survive creation, atomic replacement, external rename and deletion', async () => {
    const name = '아이템 보상', renamed = '퀘스트 보상';
    await vscode.commands.executeCommand('vibe.newTable', { table: name, key: { code: 'key', label: '보상 코드' } });
    const schemaFile = join(projectRoot, 'schemas', name + '.yaml');
    const file = join(projectRoot, 'tables', name + '.yaml');
    assert.equal((await stat(schemaFile)).isFile(), true);
    const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('vibe.openTable', name);
    assert.equal(panel?.title, name);
    const source = await readFile(file, 'utf8');
    // The formatter can put an empty sequence on the next line. Write the external
    // edit explicitly instead of depending on the spelling of that empty sequence.
    const updated = `schema: ${JSON.stringify(name)}\nrows:\n  - key: "한글 보상"\n`;
    assert.notEqual(updated, source, 'The external fixture must actually change the table bytes.');
    const temporary = file + '.tmp';
    await writeFile(temporary, updated);
    await replaceTestFile(temporary, file);
    assert.equal(await readFile(file, 'utf8'), updated);
    await eventually(() => {
      const table = readPath(api.getProject()!, name) as { table: { rows: { key: string }[] } };
      return table.table.rows.length === 1 && table.table.rows[0]?.key === '한글 보상';
    }, 'The watcher did not observe atomic replacement of the Korean table filename.');
    await replaceTestFile(file, join(projectRoot, 'tables', renamed + '.yaml'));
    await eventually(async () => {
      const names = (await treeItems(api.tables)).map(label);
      return names.includes(renamed) && !names.includes(name);
    }, 'The watcher did not observe the Korean filename rename.');
    await rm(join(projectRoot, 'tables', renamed + '.yaml'));
    await eventually(async () => !(await treeItems(api.tables)).some(item => label(item) === renamed),
      'The watcher did not observe deletion of the Korean table file.');
  });

  test('the sidebar lists tables and error counts, and its table command opens a Webview', async () => {
    const items = await treeItems(api.tables);
    assert.deepEqual(items.map(label).sort(), ['items', 'offers']);
    for (const item of items) {
      assert.equal(item.description, '오류 0개');
      assert.equal(item.command?.command, 'vibe.openTable');
      assert.deepEqual(item.command?.arguments, [label(item)]);
    }
    assert.deepEqual(await treeItems(api.errors), []);
    const item = items.find((entry) => label(entry) === 'items')!;
    await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
    await eventually(
      () => vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.input instanceof vscode.TabInputWebview)),
      'Opening a table from its sidebar command did not create a Webview editor.',
    );
  });

  test('external file changes refresh the loaded project without a refresh command', async () => {
    const file = join(projectRoot, 'tables/items.yaml');
    const before = api.getProject()!.revision;
    let refreshEvents = 0;
    const subscription = api.onDidRefresh(() => { refreshEvents += 1; });
    try {
      const text = await readFile(file, 'utf8');
      await writeFile(file, text.replace('name: "골드"', 'name: "외부 수정 골드"'));
      await eventually(() => {
        const project = api.getProject();
        if (!project || project.root !== projectRoot || project.revision === before) return false;
        const cell = readPath(project, 'items/currency_gold/name') as { value: unknown };
        return cell.value === '외부 수정 골드';
      }, 'The filesystem watcher did not load the external cell edit.');
      await eventually(() => refreshEvents > 0, 'The watcher must notify the views after reloading.');
    } finally {
      subscription.dispose();
    }
  });

  test('plans sidebar opens comparison and watches first creation, nested patches, deletion and recreation', async () => {
    const name = '가격 검토';
    assert.deepEqual(await treeItems(api.plans), []);
    let project = (await createPlan(projectRoot, api.getProject()!.revision, name, { title: '가격 비교', status: 'draft' })).project;
    await eventually(async () => (await treeItems(api.plans)).some(item => label(item) === '가격 비교'),
      'The first plans directory creation did not appear in the sidebar.');
    const item = (await treeItems(api.plans))[0]!;
    assert.equal(item.description, '기획중');
    assert.equal(item.command?.command, 'vibe.openPlan');
    const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>(item.command!.command, ...item.command!.arguments!);
    assert.ok(panel);
    assert.match(panel.webview.html, /data-mode="plans"/);
    project = (await writeVariant(projectRoot, project.revision, name, 'A', { set: { 'offers/bundle/price': '150.000' } })).project;
    await eventually(() => api.getProject()?.sources.has(`plans/${name}/A.yaml`) === true,
      'A nested variant creation did not refresh the loaded project.');
    const file = join(projectRoot, 'plans', name, 'A.yaml');
    const source = await readFile(file, 'utf8');
    const temporary = file + '.tmp';
    await writeFile(temporary, source.replace('150.000', '180.000'));
    await replaceTestFile(temporary, file);
    await eventually(() => getPlan(api.getProject()!, name).variants.A?.set?.['offers/bundle/price'] === '180.000',
      'Atomic replacement of a nested variant did not refresh its comparison.');
    await writeFile(file, (await readFile(file, 'utf8')).replace('180.000', '190.000'));
    await eventually(() => getPlan(api.getProject()!, name).variants.A?.set?.['offers/bundle/price'] === '190.000',
      'The nested watcher did not survive atomic replacement.');
    await rm(join(projectRoot, 'plans'), { recursive: true });
    await eventually(async () => (await treeItems(api.plans)).length === 0, 'Deleting plans did not clear the sidebar.');
    project = (await createPlan(projectRoot, (await loadProject(projectRoot)).revision, name, { title: '복원된 비교', status: 'review' })).project;
    await eventually(async () => (await treeItems(api.plans)).some(item => label(item) === '복원된 비교' && item.description === '컨펌 전'),
      'Recreating the plans directory did not restore the sidebar.');
    await writeVariant(projectRoot, project.revision, name, 'B', { set: { 'offers/bundle/count': '2' } });
    await eventually(() => api.getProject()?.sources.has(`plans/${name}/B.yaml`) === true,
      'The recreated plans directory did not watch new nested variants.');
  });

  test('sidebar selection replaces the plan in the same panel and clearing selection sends an empty state', async () => {
    let project = api.getProject()!;
    for (const name of ['first', 'second']) project = (await createPlan(projectRoot, project.revision, name,
      { title: name + ' comparison', status: 'review' })).project;
    await api.refresh();
    const items = await treeItems(api.plans);
    assert.ok(items.every(item => (item.iconPath as vscode.ThemeIcon).id === 'git-compare'));
    const open = (item: vscode.TreeItem) => vscode.commands.executeCommand<vscode.WebviewPanel>(item.command!.command, ...item.command!.arguments!);
    const panel = await open(items.find(item => label(item) === 'first comparison')!);
    const received: { type: string; replace?: boolean; view?: { plan: { name: string } } }[] = [];
    const subscription = panel.webview.onDidReceiveMessage(message => {
      if (message.type === 'selectedPlanObservation') received.push(message.state);
    });
    try {
      panel.webview.html = `<!doctype html><script>
        const host = acquireVsCodeApi();
        addEventListener('message', event => host.postMessage({ type: 'selectedPlanObservation', state: event.data }));
        host.postMessage({ type: 'ready' });
      </script>`;
      await eventually(() => received.some(state => state.view?.plan.name === 'first' && state.replace), 'Initial selected plan missing.');
      assert.equal(await open(items.find(item => label(item) === 'second comparison')!), panel);
      await eventually(() => received.some(state => state.view?.plan.name === 'second' && state.replace), 'Second sidebar selection did not replace the center.');
      const count = received.length;
      assert.equal(await vscode.commands.executeCommand('vibe.openPlan'), panel);
      await eventually(() => received.slice(count).some(state => state.type === 'plansState' && state.replace && !state.view), 'No-selection state missing.');
    } finally { subscription.dispose(); panel.dispose(); }
  });

  test('baseline-change warnings use warning icons and do not add table validation errors', async () => {
    let project = (await createPlan(projectRoot, api.getProject()!.revision, 'review', { title: '검토', status: 'review' })).project;
    project = (await writeVariant(projectRoot, project.revision, 'review', 'A', { set: { 'offers/bundle/price': '150' } })).project;
    const file = join(projectRoot, 'tables/offers.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('+001.2300E+0002', '200'));
    await eventually(async () => (await treeItems(api.errors)).some(item => {
      const diagnostic = item.command?.arguments?.[0] as Diagnostic | undefined;
      return diagnostic?.code === 'BASE_CHANGED' && diagnostic.severity === 'warning';
    }), 'The changed baseline did not show its plan warning.');
    const warning = (await treeItems(api.errors)).find(item => (item.command?.arguments?.[0] as Diagnostic).code === 'BASE_CHANGED')!;
    assert.equal((warning.iconPath as vscode.ThemeIcon).id, 'warning');
    assert.equal((await treeItems(api.tables)).find(item => label(item) === 'offers')?.description, '오류 0개');
  });

  test('recreating the selected planning folder tables directory restores tables and watches later cell edits', async () => {
    const directory = join(projectRoot, 'tables');
    const file = join(directory, 'items.yaml');
    const source = await readFile(file, 'utf8');
    // A marked planning root remains valid when Git omits empty data directories.
    await writeFile(join(projectRoot, '.vibe-spec.json'), JSON.stringify({ planning_root: '.' }) + '\n');
    await rm(directory, { recursive: true });
    await eventually(async () => api.getProject()?.root === projectRoot
      && !api.getProject()!.sources.has('tables/items.yaml')
      && (await treeItems(api.tables)).length === 0,
    'Removing the tables directory did not clear the tables while keeping the planning root selected.');

    await mkdir(directory);
    await writeFile(file, source.replace('name: "골드"', 'name: "폴더 복원 골드"'));
    await eventually(async () => {
      const project = api.getProject();
      if (!project || project.root !== projectRoot) return false;
      const cell = readPath(project, 'items/currency_gold/name') as { value: unknown };
      const names = (await treeItems(api.tables)).map(label);
      return cell.value === '폴더 복원 골드' && names.length === 1 && names[0] === 'items';
    }, 'Recreating the tables directory did not restore the table and its data automatically.');

    // Only the file changes now: the recreated directory must have its own watch.
    await writeFile(file, source.replace('name: "골드"', 'name: "복원 후 외부 수정 골드"'));
    await eventually(() => {
      const project = api.getProject();
      if (!project || project.root !== projectRoot) return false;
      return (readPath(project, 'items/currency_gold/name') as { value: unknown }).value === '복원 후 외부 수정 골드';
    }, 'The recreated tables directory did not keep watching later external cell edits.');
  });

  test('a broken reference appears in the error tree and links to its table cell', async () => {
    const file = join(projectRoot, 'tables/offers.yaml');
    const text = await readFile(file, 'utf8');
    // An external writer can truncate the file before writing its final contents.
    // Observe that intermediate diagnostic so an unrelated error cannot satisfy the wait below.
    await writeFile(file, '');
    await eventually(async () => (await treeItems(api.errors)).some(item => {
      const diagnostic = item.command?.arguments?.[0] as Diagnostic | undefined;
      return diagnostic?.code === 'TABLE_SHAPE' && diagnostic.file === 'tables/offers.yaml' && diagnostic.path === '';
    }), 'The filesystem watcher did not display the intermediate empty-file diagnostic.');
    await writeFile(file, text.replace('currency: "currency_gold"', 'currency: "missing_currency"'));
    let errors: vscode.TreeItem[] = [];
    await eventually(async () => {
      errors = await treeItems(api.errors);
      return errors.some(item => {
        const diagnostic = item.command?.arguments?.[0] as Diagnostic | undefined;
        return diagnostic?.code === 'REF_MISSING' && diagnostic.file === 'tables/offers.yaml'
          && diagnostic.path === 'offers/bundle/currency';
      });
    }, 'The filesystem watcher did not display REF_MISSING at offers/bundle/currency.');

    assert.equal(errors.length, 1, 'The completed file must not leave any unrelated diagnostics.');
    const entry = errors.find((item) => item.command?.command === 'vibe.openError');
    assert.ok(entry, 'Diagnostics must expose the error-location command.');
    const diagnostic = entry.command!.arguments?.[0] as Diagnostic | undefined;
    assert.equal(diagnostic?.code, 'REF_MISSING');
    assert.equal(diagnostic?.file, 'tables/offers.yaml');
    assert.equal(diagnostic?.path, 'offers/bundle/currency');
    const tables = await treeItems(api.tables);
    assert.equal(tables.find((item) => label(item) === 'offers')?.description, '오류 1개');
    await vscode.commands.executeCommand(entry.command!.command, ...entry.command!.arguments!);
    await eventually(
      () => vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.input instanceof vscode.TabInputWebview)),
      'The diagnostic command did not open its table editor.',
    );
  });

  test('initializing an empty folder creates a project and selects it', async () => {
    const emptyRoot = join(sandbox, '새 빈 기획 폴더');
    await mkdir(emptyRoot);
    await vscode.commands.executeCommand('vibe.initFolder', vscode.Uri.file(emptyRoot));
    assert.equal(api.getProject()?.root, emptyRoot);
    assert.equal((await stat(join(emptyRoot, 'schemas'))).isDirectory(), true);
    assert.equal((await stat(join(emptyRoot, 'tables'))).isDirectory(), true);
    assert.match(await readFile(join(emptyRoot, 'AGENTS.md'), 'utf8'), /vibe/);
    const config = JSON.parse(await readFile(join(workspaceRoot, '.vibe-spec.json'), 'utf8')) as {
      planning_root: string;
    };
    assert.equal(resolve(workspaceRoot, config.planning_root), emptyRoot);
    assert.deepEqual(await treeItems(api.tables), []);
    assert.deepEqual(await treeItems(api.errors), []);
  });

  for (const extension of ['csv', 'xlsx']) {
    test(`the import command opens an actual ${extension} fixture without changing planning data`, async () => {
      const revision = api.getProject()!.revision;
      const source = vscode.Uri.file(join(outsideSandbox, `불러올 아이템 # % &.${extension}`));
      await cp(join(process.env.VIBE_REPO_ROOT!, 'packages/core/test/fixtures/import/items.' + extension), source.fsPath);
      const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('vibe.import', source);
      assert.ok(panel);
      assert.equal(panel.title, '불러오기');
      assert.match(panel.webview.html, /data-mode="import"/);
      assert.equal(api.getProject()!.revision, revision);
      assert.equal((await treeItems(api.tables)).length, 2);
    });
  }

  test('Markdown export uses the planning config and includes schema and exact numeric values without changing YAML', async () => {
    await writeFile(join(projectRoot, '.vibe-spec.json'), JSON.stringify({ planning_root: '.', export_directory: '개발용 내보내기' }) + '\n');
    const before = await loadProject(projectRoot);
    const originals = await Promise.all([...before.sources.keys()].map(async file => [file, await readFile(join(projectRoot, file))] as const));
    const result = await vscode.commands.executeCommand<MarkdownExport>('vibe.export');
    assert.equal(await realpath(result.directory), await realpath(join(projectRoot, '개발용 내보내기')));
    assert.deepEqual(result.files, ['items.md', 'offers.md']);
    assert.equal(result.revision, before.revision);
    assert.deepEqual(result.diagnostics, []);
    const markdown = await readFile(join(result.directory, 'offers.md'), 'utf8');
    assert.match(markdown, /## Schema/);
    assert.match(markdown, /Schema: offers/);
    assert.match(markdown, /price[^\n]*decimal/);
    assert.match(markdown, /count[^\n]*integer/);
    assert.match(markdown, /currency[^\n]*ref[^\n]*items/);
    for (const value of ['+001.2300E+0002', '900719925474099312345', '-0.000', '001']) assert.ok(markdown.includes(value));
    const after = await loadProject(projectRoot);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.sources, before.sources);
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(join(projectRoot, file)), bytes);
  });

  test('Markdown export accepts an explicit output and exports fresh values with validation errors', async () => {
    await writeFile(join(projectRoot, '.vibe-spec.json'), JSON.stringify({ planning_root: '.', export_directory: '사용하지 않을 출력' }) + '\n');
    const sourcePath = join(projectRoot, 'tables/offers.yaml');
    const changed = (await readFile(sourcePath, 'utf8')).replace('price: "+001.2300E+0002"', 'price: "-1"');
    await writeFile(sourcePath, changed);
    const before = await loadProject(projectRoot);
    const output = join(outsideSandbox, '직접 지정한 문서 # % &');
    const result = await vscode.commands.executeCommand<MarkdownExport>('vibe.export', output);
    assert.equal(await realpath(result.directory), await realpath(output));
    assert.equal(result.revision, before.revision);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.path === 'offers/bundle/price'
      && diagnostic.code === 'VALUE_TYPE_OR_RANGE' && /minimum/.test(diagnostic.message)));
    const markdown = await readFile(join(result.directory, 'offers.md'), 'utf8');
    assert.match(markdown, /\| -1 \|/);
    assert.ok(markdown.includes(`Validation errors: ${result.diagnostics.length}`));
    assert.equal((await loadProject(projectRoot)).revision, before.revision);
    assert.equal(await readFile(sourcePath, 'utf8'), changed);
    await assert.rejects(stat(join(projectRoot, '사용하지 않을 출력')), { code: 'ENOENT' });
    await assert.rejects(stat(join(projectRoot, '.vibe-spec-export')), { code: 'ENOENT' });
  });

  test('the unified sidebar create command creates a Key-only schema and opens its empty grid', async () => {
    const extension = vscode.extensions.getExtension('ijun17.vibe-spec')!;
    assert.ok(extension.packageJSON.contributes.menus['view/title'].some((item: { command: string }) => item.command === 'vibe.newResource'));
    assert.ok((await treeItems(api.tables)).every(item => item.contextValue === 'vibe-table'));
    await vscode.commands.executeCommand('vibe.newResource', { create: 'table', folder: '', table: 'quests', key: { code: 'quest_key', label: '퀘스트 코드' } });
    const data = readPath(api.getProject()!, 'quests') as { schema: { primary_key: string }; table: { rows: unknown[] } };
    assert.equal(data.schema.primary_key, 'quest_key'); assert.deepEqual(data.table.rows, []);
    assert.ok((await treeItems(api.tables)).some(item => label(item) === 'quests'));
    await eventually(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'quests')),
      'The new table did not open its editor tab.');
  });

  test('sidebar table rename updates declared references, and deletion enforces dependencies', async () => {
    await vscode.commands.executeCommand('vibe.renameTable', { table: 'items', to: 'wallets' });
    const offers = readPath(api.getProject()!, 'offers') as { schema: { columns: { currency: { table: string } } } };
    assert.equal(offers.schema.columns.currency.table, 'wallets');
    await assert.rejects(async () => { await vscode.commands.executeCommand('vibe.deleteTable', { table: 'wallets', confirmed: true }); }, /referenc|참조/i);
    assert.ok((await treeItems(api.tables)).some(item => label(item) === 'wallets'));
    await vscode.commands.executeCommand('vibe.deleteTable', { table: 'offers', confirmed: true });
    assert.deepEqual((await treeItems(api.tables)).map(label), ['wallets']);
    assert.equal(api.getProject()!.sources.has('schemas/offers.yaml'), false);
  });

  test('delivery commands save with a reason, show editing state, and watch external Git commits', async () => {
    const configuration = vscode.workspace.getConfiguration('files');
    const excludes = configuration.inspect<Record<string, boolean>>('watcherExclude')?.workspaceValue;
    try {
      await configuration.update('watcherExclude', { ...excludes, '**/.git/**': true }, vscode.ConfigurationTarget.Workspace);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
      git('init', '-b', 'main'); git('config', 'user.name', 'VS Code Test'); git('config', 'user.email', 'vscode@example.invalid');
      git('config', 'commit.gpgsign', 'false'); await api.git.refresh();
      assert.equal(label(api.git.getChildren()[0]!), '저장 전');
      const commands = api.git.getChildren().flatMap(item => item.command?.command ?? []);
      for (const command of ['vibe.save', 'vibe.push', 'vibe.pull']) assert.ok(commands.includes(command));
      await vscode.commands.executeCommand('vibe.save', '최초 기획 저장');
      assert.equal(git('log', '-1', '--format=%s'), '최초 기획 저장');
      assert.equal(label(api.git.getChildren()[0]!), '올리기 전');
      const head = git('rev-parse', 'HEAD');
      api.git.draft('items', true); assert.equal(label(api.git.getChildren()[0]!), '편집 중');
      await assert.rejects(async () => { await vscode.commands.executeCommand('vibe.save', 'draft must remain'); }, /확정|취소/);
      assert.equal(git('rev-parse', 'HEAD'), head); api.git.draft('items', false);
      git('switch', '-c', 'design/review');
      await eventually(() => api.git.status?.branch === 'design/review', 'Git watcher did not observe a branch change.');
      git('commit', '--allow-empty', '-m', 'external save');
      await eventually(() => api.git.status?.outgoing.length === 2, 'Git watcher did not refresh a commit without YAML changes.');
    } finally {
      restoreWatcherExcludes = () => configuration.update('watcherExclude', excludes, vscode.ConfigurationTarget.Workspace);
    }
  });
});
