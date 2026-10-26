import { replaceTestFile } from './replaceTestFile.js';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { createDocument, renameResource, pathFromParts, validateProject, type Project, type WriteResult } from '@vibe-spec/core';
import type { PlanningItem, PlanningTree } from '../src/planningTree.js';
import { watchProject } from '../src/projectWatcher.js';

interface ExtensionApi {
  planning: PlanningTree;
  tables: PlanningTree;
  getProject(): Project | undefined;
  refresh(): Promise<void>;
}
const label = (item: vscode.TreeItem) => typeof item.label === 'string' ? item.label : item.label?.label;
async function eventually(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

// Observe the real Webview transport without depending on React rendering.
function observe(panel: vscode.WebviewPanel) {
  const messages: { type: string; revision?: string; replace?: boolean; view?: { name: string } }[] = [];
  const subscription = panel.webview.onDidReceiveMessage(message => {
    if (message?.type === 'planningNativeObservation') messages.push(message.message);
  });
  panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-planning-test'"></head><body>
    <script nonce="planning-test">
      const host = acquireVsCodeApi();
      addEventListener('message', event => host.postMessage({ type: 'planningNativeObservation', message: event.data }));
      host.postMessage({ type: 'ready' });
    </script></body></html>`;
  return { messages, dispose: () => subscription.dispose() };
}

suite('vibe-spec unified planning tree in native VS Code', function () {
  this.timeout(30_000);
  let api: ExtensionApi, workspace: string, sandbox: string, fixture: string, root: string;
  let serial = 0;
  suiteSetup(async () => {
    workspace = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    fixture = join(process.env.VIBE_REPO_ROOT!, 'packages/core/test/fixtures/project');
    sandbox = await mkdtemp(join(workspace, 'domain-tree-'));
    api = await vscode.extensions.getExtension<ExtensionApi>('ijun17.vibe-spec')!.activate();
  });
  setup(async () => {
    root = join(sandbox, 'project-' + ++serial);
    await cp(fixture, root, { recursive: true });
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(root));
  });
  teardown(async () => { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); });
  suiteTeardown(async () => {
    await rm(join(workspace, '.vibe-spec.json'), { force: true });
    await eventually(() => api.getProject() === undefined, 'Planning tree cleanup did not release project.');
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3 });
  });
  function children(parent?: PlanningItem) { return api.planning.getChildren(parent); }
  function folder(path: string): PlanningItem {
    let parent: PlanningItem | undefined;
    for (const part of path.split('/')) {
      parent = children(parent).find(item => item.kind === 'folder' && label(item) === part);
      assert.ok(parent, 'Missing folder: ' + path);
    }
    return parent!;
  }
  async function command(id: string, input: Record<string, unknown>) {
    return vscode.commands.executeCommand<WriteResult>('vibe.' + id, {
      revision: api.getProject()!.revision, confirmed: true, ...input,
    });
  }
  async function mixed() {
    await mkdir(join(root, 'tables', '경제', '상점'), { recursive: true });
    await mkdir(join(root, 'documents', '경제', '상점'), { recursive: true });
    await replaceTestFile(join(root, 'tables', 'offers.yaml'), join(root, 'tables', '경제', '상점', 'offers.yaml'));
    await writeFile(join(root, 'documents', '경제', '상점', '안내.md'), '# 안내\n\n[가격](offers/bundle/price)');
    await eventually(() => api.getProject()?.sources.has('documents/경제/상점/안내.md') === true, 'Nested mixed files were not watched.');
  }

  test('shows raw slash folder names and opens escaped document scopes without changing Markdown', async () => {
    await command('newFolder', { path: '분류~1보상' });
    await command('newFolder', { name: '분류/보상', folder: '' });
    const slash = children().find(item => label(item) === '분류/보상');
    assert.ok(slash); assert.ok(children().some(item => label(item) === '분류~1보상'));
    const source = '\uFEFF# 공격 / 방어\r\n\r\n<!-- name: 기본/값~1 -->\r\n내용  ';
    await createDocument(root, api.getProject()!.revision, 'guide', source, { folder: './분류~1보상' });
    await api.refresh();
    const entry = children(slash).find(item => label(item) === 'guide'); assert.ok(entry);
    const path = pathFromParts(['guide', '공격 / 방어', '기본/값~1']);
    const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('vibe.openDocument', 'guide', path);
    assert.equal(panel.title, 'guide');
    const transport = observe(panel);
    await eventually(() => transport.messages.some(message => message.type === 'documentsState' && message.view?.name === 'guide'), 'Escaped scope did not reach the Webview.');
    assert.equal(validateProject(api.getProject()!).length, 0);
    assert.equal([...api.getProject()!.sources].find(([file]) => file.endsWith('/guide.md'))?.[1], source);
    transport.dispose(); panel.dispose();
    await command('renameFolder', { path: './분류~1보상', name: '새/분류' });
    assert.ok(children().some(item => label(item) === '새/분류'));
  });

  test('one contributed tree merges physical folders and preserves resource icons, commands and errors', async () => {
    await mixed();
    await mkdir(join(root, 'documents', '빈 폴더'), { recursive: true });
    await writeFile(join(root, 'documents', '경제', '상점', '오류 문서.md'), '# 중복\n\n# 중복');
    // A recursive load can see the new file after it enumerated the parent folders.
    await eventually(() => api.getProject()?.sources.has('documents/경제/상점/오류 문서.md') === true
      && api.getProject()?.directories?.includes('documents/빈 폴더') === true
      && children().some(item => item.kind === 'folder' && label(item) === '빈 폴더'),
    'Nested diagnostic and empty folder were not loaded.');
    const manifest = vscode.extensions.getExtension('ijun17.vibe-spec')!.packageJSON;
    const views = manifest.contributes.views.vibe as { id: string; name: string }[];
    assert.equal(views.find(view => view.id === 'vibe.tables')?.name, '기획');
    assert.equal(views.some(view => view.id === 'vibe.documents'), false);
    assert.equal(api.tables, api.planning);
    assert.deepEqual(children().filter(item => item.kind === 'folder').map(label).sort(), ['경제', '빈 폴더'].sort());
    const entries = children(folder('경제/상점'));
    assert.deepEqual(entries.map(label).sort(), ['offers', '안내', '오류 문서'].sort());
    for (const [name, icon, command] of [['offers', 'table', 'vibe.openTable'], ['안내', 'markdown', 'vibe.openDocument']]) {
      const item = entries.find(item => label(item) === name)!;
      assert.equal((item.iconPath as vscode.ThemeIcon).id, icon);
      assert.equal(item.command?.command, command);
      assert.deepEqual(item.command?.arguments, [name]);
      assert.match(item.tooltip as string, /경제\/상점\//);
    }
    assert.notEqual(entries.find(item => label(item) === '오류 문서')!.description, '오류 0개');
    assert.notEqual(folder('경제').description, '오류 0개');
    const item = entries.find(item => label(item) === '안내')!;
    const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>(item.command!.command, ...item.command!.arguments!);
    assert.equal(panel.title, '안내');
    const diagnostic = validateProject(api.getProject()!).find(item => item.file === 'documents/경제/상점/오류 문서.md')!;
    await vscode.commands.executeCommand('vibe.openError', diagnostic);
    assert.equal(panel.title, '안내', 'Error navigation must preserve the original document panel.');
    await eventually(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      tab.label === '오류 문서' && tab.input instanceof vscode.TabInputWebview)),
    'Nested physical paths must open a separate document panel by basename.');
    const errorPanel = await vscode.commands.executeCommand<vscode.WebviewPanel>('vibe.openDocument', '오류 문서');
    assert.notEqual(errorPanel, panel);
    assert.equal(errorPanel.title, '오류 문서');
    assert.equal(await vscode.commands.executeCommand('vibe.openDocument', '안내'), panel);
  });

  test('planning toolbar has one clearly named create action and keeps transfers in overflow', () => {
    const manifest = vscode.extensions.getExtension('ijun17.vibe-spec')!.packageJSON;
    const commands = manifest.contributes.commands as { command: string; title: string; icon?: string }[];
    const titleMenus = manifest.contributes.menus['view/title'] as { command: string; when: string; group: string }[];
    const planningMenus = titleMenus.filter(menu => menu.when === 'view == vibe.tables');
    const toolbar = planningMenus.filter(menu => menu.group.startsWith('navigation'));
    assert.deepEqual(toolbar.map(menu => menu.command).sort(), ['vibe.newResource', 'vibe.refresh']);
    assert.equal(toolbar.filter(menu => commands.find(command => command.command === menu.command)?.icon === '$(add)').length, 1);
    assert.equal(commands.find(command => command.command === 'vibe.newResource')?.title, '새로 만들기: 폴더·표·문서',
      'The command title is the native toolbar tooltip.');
    for (const id of ['vibe.import', 'vibe.export']) {
      assert.ok(planningMenus.some(menu => menu.command === id && !menu.group.startsWith('navigation')));
    }
    for (const id of ['vibe.newFolder', 'vibe.newTable', 'vibe.newDocument']) {
      assert.ok(commands.some(command => command.command === id), 'Existing creation commands remain available.');
    }
  });

  test('unified create delegates all three kinds into the selected domain and explicit root', async () => {
    await command('newFolder', { path: '경제/상점' });
    await vscode.commands.executeCommand('vibe.tables.focus');
    await api.planning.view.reveal(folder('경제/상점'), { select: true });
    await eventually(() => api.planning.selectedFolder() === '경제/상점', 'The create destination must use the selected folder.');
    await command('newResource', { create: 'folder', name: '하위' });
    assert.ok(folder('경제/상점/하위'));
    await command('newResource', { create: 'table', table: '선택 표', key: { code: 'code', label: '코드' } });
    await command('newResource', { create: 'document', name: '선택 문서' });
    assert.ok(api.getProject()!.sources.has('tables/경제/상점/선택 표.yaml'));
    assert.ok(api.getProject()!.sources.has('documents/경제/상점/선택 문서.md'));
    await command('newResource', { create: 'folder', folder: '', name: '루트 폴더' });
    assert.ok(folder('루트 폴더'));
    await command('newResource', { create: 'table', folder: '', table: '루트 표', key: { code: 'code', label: '코드' } });
    await command('newResource', { create: 'document', folder: '', name: '루트 문서' });
    assert.ok(api.getProject()!.sources.has('tables/루트 표.yaml'));
    assert.ok(api.getProject()!.sources.has('documents/루트 문서.md'));
  });

  test('create picker labels root and folder destinations, captures selection and accepts cancellation', async () => {
    await command('newFolder', { path: '경제/상점' });
    await command('newFolder', { path: '다른 위치' });
    const optionsSeen: vscode.QuickPickOptions[] = [];
    const picker = mock.method(vscode.window, 'showQuickPick', async (items: readonly vscode.QuickPickItem[], options: vscode.QuickPickOptions) => {
      assert.deepEqual(items.map(item => item.label), ['폴더', '표', '문서']);
      assert.equal(options.title, '새로 만들기: 폴더·표·문서');
      optionsSeen.push(options);
      if (optionsSeen.length === 1) return undefined;
      await api.planning.view.reveal(folder('다른 위치'), { select: true });
      await eventually(() => api.planning.selectedFolder() === '다른 위치', 'Selection did not change while the picker was open.');
      return items[0];
    });
    try {
      const revision = api.getProject()!.revision;
      await command('newResource', { folder: '' });
      assert.equal(api.getProject()!.revision, revision, 'Cancelling creation must not write files.');
      await api.planning.view.reveal(folder('경제/상점'), { select: true });
      await eventually(() => api.planning.selectedFolder() === '경제/상점', 'Nested folder was not selected.');
      await command('newResource', { name: '선택 유지' });
      assert.ok(folder('경제/상점/선택 유지'));
      assert.equal(children(folder('다른 위치')).length, 0);
      assert.deepEqual(optionsSeen.map(options => options.placeHolder), ['만들 위치: 최상위 (루트)', '만들 위치: 경제 › 상점']);
    } finally { picker.mock.restore(); }
  });

  test('create picker rejects a project switch before delegating any write', async () => {
    const original = root;
    const other = join(sandbox, 'create-other-' + serial);
    await cp(fixture, other, { recursive: true });
    const picker = mock.method(vscode.window, 'showQuickPick', async (items: readonly vscode.QuickPickItem[]) => {
      await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(other));
      return items[0];
    });
    try {
      await assert.rejects(command('newResource', { folder: '', name: '차단된 생성' }), /기획 폴더가 바뀌었습니다/);
      for (const project of [original, other]) {
        assert.equal(existsSync(join(project, 'tables/차단된 생성')), false);
        assert.equal(existsSync(join(project, 'documents/차단된 생성')), false);
      }
      await assert.rejects(command('newResource', { create: 'folder', projectRoot: original, name: '오래된 선택' }), /기획 폴더가 바뀌었습니다/);
    } finally { picker.mock.restore(); }
  });

  test('real expansion and collapse events persist by project root and full relative folder', async () => {
    await mixed();
    await vscode.commands.executeCommand('vibe.tables.focus');
    await api.planning.view.reveal(folder('경제'), { expand: true, select: true });
    await eventually(() => folder('경제').collapsibleState === vscode.TreeItemCollapsibleState.Expanded, 'Expansion was not persisted.');
    await api.planning.view.reveal(folder('경제/상점'), { expand: true });
    await eventually(() => folder('경제/상점').collapsibleState === vscode.TreeItemCollapsibleState.Expanded, 'Nested expansion was not persisted.');
    await vscode.commands.executeCommand('workbench.actions.treeView.vibe.tables.collapseAll');
    await eventually(() => folder('경제').collapsibleState === vscode.TreeItemCollapsibleState.Collapsed, 'Collapse event was not persisted.');
    const original = root;
    const other = join(sandbox, 'other-' + serial);
    await cp(root, other, { recursive: true });
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(other));
    assert.equal(folder('경제').collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    await api.planning.view.reveal(folder('경제'), { expand: true });
    await eventually(() => folder('경제').collapsibleState === vscode.TreeItemCollapsibleState.Expanded, 'Second project expansion was not stored.');
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(original));
    assert.equal(folder('경제').collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    await api.refresh();
    assert.equal(folder('경제').collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  });

  test('folder menu commands create, move, delete empty domains and create resources in the selection', async () => {
    const manifest = vscode.extensions.getExtension('ijun17.vibe-spec')!.packageJSON;
    const menus = manifest.contributes.menus['view/item/context'] as { command: string; when: string }[];
    for (const id of ['newFolder', 'renameFolder', 'moveFolder', 'deleteFolder', 'newTable', 'newDocument']) {
      assert.ok(menus.some(menu => menu.command === 'vibe.' + id && menu.when.includes('vibe-folder')), id + ' must be a folder menu.');
    }
    for (const kind of ['table', 'document']) assert.ok(menus.some(menu => menu.command === 'vibe.moveResource' && menu.when.includes('vibe-' + kind)));
    await command('newFolder', { path: '경제/상점' });
    assert.equal(await readFile(join(root, 'tables/경제/상점/.gitkeep'), 'utf8'), '');
    assert.equal(await readFile(join(root, 'documents/경제/상점/.gitkeep'), 'utf8'), '');
    await vscode.commands.executeCommand('vibe.tables.focus');
    await api.planning.view.reveal(folder('경제/상점'), { select: true, expand: true });
    await eventually(() => api.planning.selectedFolder() === '경제/상점', 'Folder selection was not exposed to create commands.');
    await command('newFolder', { name: '하위' });
    assert.ok(folder('경제/상점/하위'));
    await command('deleteFolder', { path: '경제/상점/하위' });
    await command('newTable', { table: '새 표', key: { code: 'code', label: '코드' } });
    await command('newDocument', { name: '새 문서' });
    assert.ok(api.getProject()!.sources.has('tables/경제/상점/새 표.yaml'));
    assert.ok(api.getProject()!.sources.has('documents/경제/상점/새 문서.md'));
    await assert.rejects(command('deleteFolder', { path: '경제/상점' }));
    await command('renameFolder', { path: '경제/상점', name: '판매' });
    await command('newFolder', { path: '목적지' });
    await command('moveFolder', { path: '경제/판매', folder: '목적지' });
    assert.ok(api.getProject()!.sources.has('tables/목적지/판매/새 표.yaml'));
    assert.ok(api.getProject()!.sources.has('documents/목적지/판매/새 문서.md'));
    await command('moveResource', { kind: 'table', name: '새 표', folder: '' });
    await command('moveResource', { kind: 'document', name: '새 문서', folder: '' });
    await command('deleteFolder', { path: '목적지/판매' });
    assert.deepEqual(children(folder('목적지')), []);
    const stale = api.getProject()!.revision;
    await command('newFolder', { path: '새 revision' });
    await assert.rejects(command('newFolder', { path: '오래된 요청', revision: stale }));
    assert.ok(!children().some(item => label(item) === '오래된 요청'));
  });

  test('folder moves retain open table and document panels and exact source bytes', async () => {
    await mixed();
    const table = await vscode.commands.executeCommand<vscode.WebviewPanel>('vibe.openTable', 'offers');
    const tablePage = observe(table);
    // Replacing a hidden Webview's HTML can defer its ready script until reveal.
    // Establish each real transport while visible before testing retained updates.
    await eventually(() => tablePage.messages.some(message => message.type === 'snapshot'),
      'The visible table panel did not send its initial snapshot.');
    const document = await vscode.commands.executeCommand<vscode.WebviewPanel>('vibe.openDocument', '안내');
    const documentPage = observe(document);
    await eventually(() => documentPage.messages.some(message => message.type === 'documentsState'),
      'The visible document panel did not send its initial snapshot.');
    const beforeRevision = api.getProject()!.revision;
    const tableBytes = await readFile(join(root, 'tables/경제/상점/offers.yaml'));
    const documentBytes = await readFile(join(root, 'documents/경제/상점/안내.md'));
    let disposed = false;
    const subscriptions = [table.onDidDispose(() => { disposed = true; }), document.onDidDispose(() => { disposed = true; })];
    await command('renameFolder', { path: '경제', name: '재화' });
    const revision = api.getProject()!.revision;
    assert.notEqual(revision, beforeRevision);
    await eventually(() => tablePage.messages.some(message => message.type === 'snapshot' && message.revision === revision)
      && documentPage.messages.some(message => message.type === 'documentsState' && message.revision === revision
        && message.view?.name === '안내' && message.replace === false), 'Moving a folder did not refresh retained panels without replacing drafts.');
    assert.equal(disposed, false);
    assert.equal(table.title, 'offers'); assert.equal(document.title, '안내');
    assert.equal(await vscode.commands.executeCommand('vibe.openTable', 'offers'), table);
    assert.equal(await vscode.commands.executeCommand('vibe.openDocument', '안내'), document);
    assert.deepEqual(await readFile(join(root, 'tables/재화/상점/offers.yaml')), tableBytes);
    assert.deepEqual(await readFile(join(root, 'documents/재화/상점/안내.md')), documentBytes);
    for (const subscription of subscriptions) subscription.dispose();
    tablePage.dispose(); documentPage.dispose();
  });

  test('nested atomic edits and recreated child directories continue refreshing resources and schemas', async () => {
    await mixed();
    const file = join(root, 'documents/경제/상점/안내.md');
    await writeFile(file + '.tmp', '# 원자 교체'); await replaceTestFile(file + '.tmp', file);
    await eventually(() => api.getProject()?.sources.get('documents/경제/상점/안내.md') === '# 원자 교체', 'Nested atomic edit was missed.');
    await rm(join(root, 'documents/경제'), { recursive: true });
    await eventually(() => !api.getProject()?.sources.has('documents/경제/상점/안내.md'), 'Nested removal was missed.');
    await mkdir(join(root, 'documents/경제/상점'), { recursive: true });
    await writeFile(file, '# 복원');
    await eventually(() => api.getProject()?.sources.get('documents/경제/상점/안내.md') === '# 복원', 'Recreated child was missed.');
    await writeFile(file, '# 복원 뒤 수정');
    await eventually(() => api.getProject()?.sources.get('documents/경제/상점/안내.md') === '# 복원 뒤 수정', 'Recreated child lost its watcher.');
    await mkdir(join(root, 'schemas/공유/중첩'), { recursive: true });
    await replaceTestFile(join(root, 'schemas/items.yaml'), join(root, 'schemas/공유/중첩/items.yaml'));
    await eventually(() => api.getProject()?.sources.has('schemas/공유/중첩/items.yaml') === true, 'Nested schema creation was missed.');
    const schema = await readFile(join(root, 'schemas/공유/중첩/items.yaml'), 'utf8');
    await writeFile(join(root, 'schemas/공유/중첩/items.yaml'), schema + '\n# external schema edit\n');
    await eventually(() => api.getProject()?.sources.get('schemas/공유/중첩/items.yaml')?.endsWith('# external schema edit\n') === true, 'Nested schema edits were missed.');
  });

  test('recursive Node watcher covers all managed roots, replacements and symlink boundaries', async function () {
    const watched = join(sandbox, 'watcher-' + serial);
    await mkdir(watched);
    let observedFile: string;
    let observedBytes: string | undefined;
    let probeError: string | undefined;
    const probeEvents: { file: string | undefined; bytes: string | undefined; error: string | undefined }[] = [];
    let observedDirectory: string;
    let observedRemoval = false;
    const errors: Error[] = [];
    const watcher = watchProject(watched, () => {
      // Capture bytes at notification time: a leftover mkdir event or an event
      // coalesced with another write is not proof of observing this write.
      if (observedFile) {
        try { observedBytes = readFileSync(observedFile, 'utf8'); probeError = undefined; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Windows can notify while write/rename still holds the file. Only a
          // later real notification with readable, matching bytes can pass.
          if (!['ENOENT', 'ENOTDIR'].includes(code ?? '') && !(process.platform === 'win32' && code === 'EPERM')) {
            errors.push(error as Error);
          }
          probeError = (error as Error).message;
          observedBytes = undefined;
        }
      }
      probeEvents.push({ file: observedFile, bytes: observedBytes, error: probeError });
      if (probeEvents.length > 40) probeEvents.shift();
      if (observedDirectory) observedRemoval = !existsSync(observedDirectory);
    }, error => { errors.push(error); });
    async function observeBytes(file: string, bytes: string, action: () => Promise<unknown>, message: string) {
      observedFile = file;
      observedBytes = undefined;
      probeError = undefined;
      await action();
      try {
        await eventually(() => {
          if (errors.length) throw errors[0];
          return observedBytes === bytes;
        }, message);
      } catch (error) {
        throw new Error(message + (probeError ? ': ' + probeError : '') + '\nProbe events: ' + JSON.stringify(probeEvents) + '\nFinal file: ' + JSON.stringify(await readFile(file, 'utf8').catch(String)), { cause: error });
      }
      assert.equal(await readFile(file, 'utf8'), bytes);
    }
    try {
      for (const managed of ['tables', 'schemas', 'documents/assets', 'imports', 'plans']) {
        const directory = join(watched, managed, 'nested', 'child');
        const file = join(directory, 'observed.bin');
        await observeBytes(file, 'first', async () => {
          await mkdir(directory, { recursive: true });
          await writeFile(file, 'first');
        }, 'Did not watch ' + managed);
        await observeBytes(file, 'second', () => writeFile(file, 'second'), 'Did not keep watching ' + managed);
        await observeBytes(file, 'atomic replacement', async () => {
          await writeFile(file + '.tmp', 'atomic replacement');
          await replaceTestFile(file + '.tmp', file);
        }, 'Did not observe atomic replacement: ' + managed);
        observedDirectory = directory;
        observedRemoval = false;
        await rm(directory, { recursive: true });
        await eventually(() => observedRemoval, 'Did not observe removed child: ' + managed);
        await observeBytes(file, 'recreated', async () => {
          await mkdir(directory);
          await writeFile(file, 'recreated');
        }, 'Did not observe recreated child: ' + managed);
        await observeBytes(file, 'recreated edit', () => writeFile(file, 'recreated edit'),
          'Did not reattach recreated child: ' + managed);
      }
      // A symlink loop would recurse indefinitely if the scanner followed links.
      // Windows junctions exercise the same boundary without symlink privileges.
      await symlink(watched, join(watched, 'tables', 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
      const alive = join(watched, 'tables', 'alive.yaml');
      await observeBytes(alive, 'still responsive', () => writeFile(alive, 'still responsive'),
        'Watcher stopped responding after a symlink loop.');
      await observeBytes(alive, 'still watching', () => writeFile(alive, 'still watching'),
        'Watcher lost subsequent edits after a symlink loop.');
      assert.deepEqual(errors, []);
    } finally { watcher.dispose(); }
  });
});

suite('vibe-spec recursive Node watcher lifecycle', () => {
  test('root Git and lock events do not refresh planning data; managed events still do', () => {
    const watched = mkdtempSync(join(tmpdir(), 'vibe-watcher-root-'));
    mkdirSync(join(watched, 'tables'));
    let notifications = 0;
    const handles = new Map<string, EventEmitter>();
    const originalWatch = fs.watch;
    const stub = mock.method(fs, 'watch', (path: string, options: unknown, listener: fs.WatchListener<string>) => {
      if (!path.startsWith(watched)) return originalWatch(path, options as fs.WatchOptionsWithStringEncoding, listener);
      const handle = Object.assign(new EventEmitter(), { close() {} });
      handle.on('change', listener); handles.set(path, handle); return handle;
    });
    let watcher: ReturnType<typeof watchProject> | undefined;
    try {
      watcher = watchProject(watched, () => { notifications++; }, error => { throw error; });
      const root = handles.get(watched)!;
      for (const file of ['.git', '.vibe-spec.lock', 'AGENTS.md', 'migration']) root.emit('change', 'change', file);
      assert.equal(notifications, 0, 'Unmanaged root activity must not launch project/Git refreshes.');
      root.emit('change', 'rename', 'tables');
      root.emit('change', 'change', '.gitattributes');
      assert.equal(notifications, 2);
      handles.get(join(watched, 'tables'))!.emit('change', 'change', 'items.yaml');
      assert.equal(notifications, 3);
    } finally {
      watcher?.dispose(); stub.mock.restore(); rmSync(watched, { recursive: true, force: true });
    }
  });
  for (const lifecycle of ['deleted', 'replaced', 'live'] as const) {
    test('recursive Node watcher handles ' + lifecycle + ' directory errors without losing live watchers', () => {
      const watched = mkdtempSync(join(tmpdir(), 'vibe-watcher-errors-'));
      const directory = join(watched, 'schemas', 'nested');
      mkdirSync(directory, { recursive: true });
      const handles: { path: string; handle: EventEmitter & { closed: boolean; close(): void } }[] = [];
      const errors: Error[] = [];
      // Control OS delivery order while using real lstat/readdir identities.
      // No asynchronous work runs while the built-in is patched.
      const originalWatch = fs.watch;
      const stub = mock.method(fs, 'watch', (path: string, _options: unknown, listener: fs.WatchListener<string>) => {
        if (!path.startsWith(watched)) return originalWatch(path, _options as fs.WatchOptionsWithStringEncoding, listener);
        const handle = Object.assign(new EventEmitter(), { closed: false, close() { this.closed = true; } });
        handle.on('change', listener);
        handles.push({ path, handle });
        return handle;
      });
      let watcher: ReturnType<typeof watchProject> | undefined;
      try {
        watcher = watchProject(watched, () => {}, error => { errors.push(error); });
        const parent = handles.find(item => item.path === join(watched, 'schemas'))!.handle;
        const old = handles.find(item => item.path === directory)!.handle;
        const deleted = Object.assign(new Error('Watched directory was deleted'), { code: 'EPERM' });
        if (lifecycle === 'live') {
          old.emit('error', deleted);
          assert.deepEqual(errors, [deleted], 'EPERM on the same live directory must still report failure.');
          assert.equal(handles.filter(item => item.path === directory).length, 1,
            'A genuine error must not immediately retry the same watch.');
          return;
        }
        if (lifecycle === 'deleted') {
          rmSync(directory, { recursive: true });
          // Windows may deliver the child's EPERM before the parent's rename.
          old.emit('error', deleted);
          assert.deepEqual(errors, [], 'Deletion is a filesystem change, not a watch failure.');
          mkdirSync(directory);
          parent.emit('change', 'rename', 'nested');
        } else {
          // Keep the old inode alive so replacement identity cannot be reused.
          renameSync(directory, join(watched, 'retired'));
          mkdirSync(directory);
          parent.emit('change', 'rename', 'nested');
          old.emit('error', deleted);
          assert.deepEqual(errors, [], 'A retired watcher must not report a live watcher failure.');
        }
        const replacement = handles.filter(item => item.path === directory).at(-1)!.handle;
        assert.notEqual(replacement, old);
        assert.equal(old.closed, true);
        replacement.emit('change', 'change', 'observed.bin');
        assert.equal(handles.filter(item => item.path === directory).length, 2,
          'A stale error must not remove the live replacement from the registry.');
        watcher.dispose();
        assert.equal(replacement.closed, true, 'The live replacement must remain owned for disposal.');
      } finally {
        watcher?.dispose(); stub.mock.restore();
        rmSync(watched, { recursive: true, force: true });
      }
    });
  }
});
