import { pathParts, pathFromParts } from '@vibe-spec/core/paths';
import { DocumentsController } from './documentsController.js';
import * as vscode from 'vscode';
import { watch as watchDirectory } from 'node:fs';
import { PlanningTree } from './planningTree.js';
import { watchProject } from './projectWatcher.js';
import { webviewHtml } from './webview.js';
import { openImport } from './importPanel.js';
import { GitController } from './gitController.js';
import { TablesController } from './tablesController.js';
import { PlansController } from './plansController.js';
import {
  applyEdits, compareResourceNames, assertCompleteCellInputs, getTableView, initProject, listTables, loadProject, renameResource,
  resolveProjectRoot, selectPlanningRoot, validateProject, VibeError,
  resolveReference, ScreenHistory, whereUsed, resourceEntry, resourceFile,
  inspectStructure, applyStructureEdit, deletionUsages, exportMarkdown,
} from '@vibe-spec/core';
import type { Diagnostic, Project, Usages } from '@vibe-spec/core';
import type { ClientMessage, HostMessage } from '../../webview/src/protocol.js';

class ErrorTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly project: () => Project | undefined) {}
  update() { this.changed.fire(); }
  getTreeItem(item: vscode.TreeItem) { return item; }
  getChildren(): vscode.TreeItem[] {
    const project = this.project();
    return project ? validateProject(project).map(diagnostic => {
      const item = new vscode.TreeItem(diagnostic.path || diagnostic.file);
      item.description = diagnostic.message;
      item.tooltip = diagnostic.file + '\n' + diagnostic.code + ': ' + diagnostic.message;
      item.iconPath = new vscode.ThemeIcon(diagnostic.severity === 'warning' ? 'warning' : 'error');
      item.command = { command: 'vibe.openError', title: '오류 위치로 이동', arguments: [diagnostic] };
      return item;
    }) : [];
  }
  dispose() { this.changed.dispose(); }
}

export async function activate(context: vscode.ExtensionContext) {
  let project: Project | undefined;
  let planningRoot: string | undefined;
  let watcher: vscode.Disposable | undefined;
  let configWatcher: vscode.Disposable | undefined;
  let configFolder: vscode.WorkspaceFolder | undefined;
  const workspaceStateKey = 'vibe.configWorkspaceFolder';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let configurationGeneration = 0;
  const panels = new Map<string, vscode.WebviewPanel>();
  const histories = new Map<string, ScreenHistory>();
  const usages = new Map<string, Usages>();
  const pendingFocus = new Map<string, { key: string; column: string; row?: boolean }>();
  const refreshed = new vscode.EventEmitter<void>();
  const tables = new PlanningTree(context, () => project, refresh);
  const errors = new ErrorTree(() => project);
  const errorView = vscode.window.createTreeView('vibe.errors', { treeDataProvider: errors });
  const log = vscode.window.createOutputChannel('vibe-spec');
  const getProject = () => project;
  const git = new GitController(context, () => planningRoot, refresh, (root, beforeWrite) => documents.flush(root, beforeWrite));
  context.subscriptions.push(git);
  const tableEditor = new TablesController(context, getProject, refresh, openTable, name => panels.get(name)?.dispose(), input => tables.selectedFolder(input));
  context.subscriptions.push(tableEditor);
  const plans = new PlansController(context, getProject, refresh);
  context.subscriptions.push(plans);
  const documents = new DocumentsController(context, getProject, refresh, async path => {
    if (project && resourceFile(project, 'document', pathParts(path)[0]!)) {
      await documents.open(pathParts(path)[0], path); return;
    }
    const [table, key, column] = pathParts(path);
    if (key && column && key !== '*') await openAndFocus(table!, {key,column});
    else if (key && key !== '*' && project) await openAndFocus(table!, {key,column:getTableView(project,table!).schema.primary_key,row:true});
    else await openTable(table);
  }, input => tables.selectedFolder(input), (key, dirty) => git.documentDraft(key, dirty));
  context.subscriptions.push(documents);
  async function chooseWorkspaceFolder(uri?: vscode.Uri) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) throw new Error('먼저 로컬 프로젝트 폴더를 열어 주세요.');
    const folder = uri ? folders.find(folder => folder.uri.scheme === uri.scheme && folder.uri.fsPath === uri.fsPath)
      : folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({
        placeHolder: '기획 폴더 설정을 저장할 프로젝트 폴더를 선택하세요.',
      });
    if (!folder) {
      if (uri) throw new Error('현재 workspace에 열린 프로젝트 폴더를 선택해 주세요.');
      return;
    }
    if (folder.uri.scheme !== 'file') throw new Error('로컬 프로젝트 폴더를 선택해 주세요.');
    return folder;
  }
  function post(panel: vscode.WebviewPanel, message: HostMessage) { void panel.webview.postMessage(message); }
  function snapshot(name: string, panel: vscode.WebviewPanel, requestId?: string) {
    if (!project) return;
    try {
      post(panel, { type: 'snapshot', ...getTableView(project, name),
        history: histories.get(name)?.info() ?? { canUndo: false, canRedo: false }, ...(requestId ? { requestId } : {}) });
    } catch (error) {
      post(panel, { type: 'error', code: 'TABLE_UNAVAILABLE', message: (error as Error).message });
    }
  }
  let refreshing: Promise<void> = Promise.resolve();
  function refresh(): Promise<void> {
    const task = refreshNow();
    refreshing = task;
    return task.then(async () => { if (refreshing !== task) await refreshing; });
  }
  async function refreshNow() {
    const ticket = ++generation;
    if (!planningRoot) return;
    try {
      const next = await loadProject(planningRoot);
      if (ticket !== generation) return;
      project = next;
      tables.update(); errors.update(); plans.refresh();
      const diagnostics = validateProject(next);
      errorView.title = '검증 오류 (' + diagnostics.filter(diagnostic => diagnostic.severity !== 'warning').length
        + ') · 경고 (' + diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length + ')';
      for (const [name, panel] of panels) snapshot(name, panel);
      await git.refresh();
      void documents.refresh();
      await tableEditor.refresh();
      refreshed.fire();
    } catch (error) {
      if (ticket !== generation) return;
      project = undefined;
      tables.update(); errors.update(); plans.refresh();
      errorView.title = '검증 오류 — 폴더 확인 필요';
      for (const panel of panels.values()) post(panel, { type: 'error', code: 'PROJECT_UNAVAILABLE', message: (error as Error).message });
      log.appendLine((error as Error).message);
      await git.refresh();
      void documents.refresh();
      await tableEditor.refresh();
      refreshed.fire();
    }
  }
  function watch(root: string) {
    watcher?.dispose();
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 120);
    };
    watcher = watchProject(root, changed, error => { log.appendLine('파일 감시 실패: ' + error.message); changed(); });
  }
  async function selectFolder(uri?: vscode.Uri, initialize = false, workspaceUri?: vscode.Uri) {
    const workspace = await chooseWorkspaceFolder(workspaceUri);
    if (!workspace) return;
    const selected = uri ?? (await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
      openLabel: initialize ? '빈 기획 폴더 초기화' : '기획 폴더 선택',
    }))?.[0];
    if (!selected) return;
    if (selected.scheme !== 'file') throw new Error('로컬 폴더를 선택해 주세요.');
    if (initialize) await initProject(selected.fsPath);
    const next = await selectPlanningRoot(workspace.uri.fsPath, selected.fsPath);
    if (workspaceUri || (vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
      await context.workspaceState.update(workspaceStateKey, workspace.uri.toString());
    }
    watchConfiguration(workspace);
    project = next;
    if (planningRoot !== selected.fsPath) for (const panel of panels.values()) panel.dispose();
    planningRoot = selected.fsPath;
    watch(planningRoot);
    await refresh();
  }
  async function openTable(name?: string) {
    if (!project) throw new Error('먼저 기획 폴더를 선택해 주세요.');
    name ??= await vscode.window.showQuickPick(listTables(project).map(table => table.name).sort(compareResourceNames), { placeHolder: '테이블 선택' });
    if (!name) return;
    const existing = panels.get(name);
    if (existing) { existing.reveal(vscode.ViewColumn.One); snapshot(name, existing); return existing; }
    const table = name;
    const panelRoot = project.root;
    const history = new ScreenHistory();
    histories.set(table, history);
    const widthKey = 'vibe.widths:' + JSON.stringify([panelRoot, table]);
    const assets = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel('vibe.table', table, vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assets],
    });
    panels.set(table, panel);
    panel.webview.html = webviewHtml(context, panel, 'table');
    panel.onDidDispose(() => { panels.delete(table); pendingFocus.delete(table); histories.delete(table); usages.delete(table); git.draft(table, false); });
    panel.webview.onDidReceiveMessage(async (message: ClientMessage) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready') {
        snapshot(table, panel);
        post(panel, { type: 'viewState', table, widths: context.workspaceState.get<Record<string, number>>(widthKey, {}) });
        const focus = pendingFocus.get(table);
        if (focus) { post(panel, { type: 'focus', ...focus }); pendingFocus.delete(table); }
        return;
      }
      if (!project) return;
      if (project.root !== panelRoot || planningRoot !== panelRoot) return;
      if (message.type === 'draftState') { git.draft(table, message.active); return; }
      try {
        if (message.type === 'copy') {
          await vscode.env.clipboard.writeText(message.text);
          post(panel, { type: 'copied' }); return;
        }
        if (message.type === 'widths') {
          const widths = Object.fromEntries(Object.entries(message.widths).filter(([column, width]) =>
            Object.hasOwn(getTableView(project!, table).schema.columns, column) && Number.isFinite(width) && width >= 48 && width <= 3000));
          await context.workspaceState.update(widthKey, widths);
          post(panel, { type: 'viewState', table, widths }); return;
        }
        if (message.type === 'follow') {
          const target = resolveReference(project, table, message.key, message.column);
          await openAndFocus(target.table, { key: target.key, column: target.column, row: true }); return;
        }
        if (message.type === 'whereUsed') {
          const result = await whereUsed(project, pathFromParts([table, message.key]));
          usages.set(table, result);
          post(panel, { type: 'usages', key: message.key, result }); return;
        }
        if (message.type === 'openUsage') {
          const usage = usages.get(table)?.[message.kind]?.[message.index];
          if (!usage) throw new VibeError('PATH_NOT_FOUND', 'Choose an existing usage result.');
          const [target, key, column, extra] = pathParts(usage.path);
          if (resourceEntry(usage.file)?.kind === 'document') {
            await documents.open(resourceEntry(usage.file)!.name, usage.path || undefined);
          } else if (usage.file.startsWith('tables/') && target && key && column && !extra) {
            await openAndFocus(target, { key, column });
          } else {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.Uri.file(panelRoot), usage.file));
            const line = Math.max(0, usage.line - 1);
            await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
          }
          return;
        }
        if (message.type === 'structurePreview') {
          if (message.operation.table !== table || !message.operation.op.startsWith('column-')) throw new VibeError('INVALID_EDIT', '현재 표의 열을 선택해 주세요.');
          const preview = await inspectStructure(await loadProject(panelRoot), message.operation);
          usages.set(table, preview.usages); post(panel, { type: 'structurePreview', preview }); return;
        }
        if (typeof message.requestId !== 'string' || typeof message.revision !== 'string') return;
        if (message.type === 'apply' && (!Array.isArray(message.operations) || message.operations.some(op => op.table !== table))) {
          throw new VibeError('INVALID_EDIT', '현재 표의 칸만 편집할 수 있습니다.');
        }
        if (message.type === 'apply') assertCompleteCellInputs(project, message.operations);
        let result;
        if (message.type === 'apply') {
          result = await applyEdits(panelRoot, message.revision, message.operations);
          history.recordCells(result, message.operations);
        } else if (message.type === 'rename') {
          result = await renameResource(panelRoot, message.revision, 'key', pathFromParts([table, message.key]), message.to);
          history.recordRename(result, table, message.key, message.to);
        } else if (message.type === 'structureEdit') {
          if (message.operation.table !== table || !message.operation.op.startsWith('column-')) throw new VibeError('INVALID_EDIT', '현재 표의 열을 선택해 주세요.');
          result = await applyStructureEdit(panelRoot, message.revision, message.operation); history.recordStructure(result);
        } else if (message.type === 'columnRename') {
          result = await renameResource(panelRoot, message.revision, 'column', table + '/*/' + message.column, message.to); history.recordStructure(result);
        } else result = await history[message.type](panelRoot, message.revision);
        if (planningRoot !== panelRoot) return;
        project = result.project;
        snapshot(table, panel, message.requestId);
        await refresh();
        if (result.candidates.length && (message.type === 'rename' || message.type === 'columnRename'
          || message.type === 'structureEdit' && message.operation.op === 'column-delete')) {
          log.clear();
          for (const candidate of result.candidates) log.appendLine(`${candidate.file}:${candidate.line} ${candidate.text}`);
          const choice = await vscode.window.showInformationMessage(
            '이름이 적힌 본문 ' + result.candidates.length + '곳은 직접 확인해 주세요.', '후보 보기');
          if (choice) log.show();
        }
      } catch (error) {
        if (planningRoot !== panelRoot) { log.appendLine((error as Error).message); return; }
        let blocked;
        if (error instanceof VibeError && error.code === 'DELETE_RESTRICTED') {
          const current = await loadProject(panelRoot);
          blocked = await deletionUsages(current, error.diagnostics); usages.set(table, blocked.result);
        }
        post(panel, { type: 'error', ...('requestId' in message ? { requestId: message.requestId } : {}),
          code: error instanceof VibeError ? error.code : 'WRITE_FAILED', message: (error as Error).message,
          ...(blocked ? { usages: blocked } : {}) });
        await refresh();
      }
    });
    return panel;
  }
  async function openAndFocus(table: string, target: { key: string; column: string; row?: boolean }) {
    pendingFocus.set(table, target);
    const existed = panels.has(table);
    const panel = await openTable(table);
    if (existed && panel) { post(panel, { type: 'focus', ...target }); pendingFocus.delete(table); }
  }
  async function openError(diagnostic: Diagnostic) {
    if (resourceEntry(diagnostic.file)?.kind === 'document') {
      await documents.open(resourceEntry(diagnostic.file)!.name, diagnostic.path || undefined);
    } else if (diagnostic.file.startsWith('tables/') && pathParts(diagnostic.path).length === 3) {
      const [table, key, column] = pathParts(diagnostic.path);
      await openAndFocus(table!, { key: key!, column: column! });
    } else if (planningRoot) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.Uri.file(planningRoot), diagnostic.file));
      await vscode.window.showTextDocument(document);
    }
  }
  async function configuredRoot() {
    const folder = configFolder, ticket = ++configurationGeneration;
    try {
      if (!folder) throw new Error('기획 폴더 선택에서 설정을 저장할 프로젝트 폴더를 골라 주세요.');
      // CLI discovery may walk up parent directories; a workspace selection owns
      // only its own configuration file, including when that file is deleted.
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, '.vibe-spec.json'));
      const root = await resolveProjectRoot(folder.uri.fsPath);
      if (ticket !== configurationGeneration) return;
      if (planningRoot !== root) {
        for (const panel of panels.values()) panel.dispose();
        planningRoot = root; watch(root);
      }
      await refresh();
    } catch (error) {
      if (ticket !== configurationGeneration) return;
      generation++;
      planningRoot = undefined; project = undefined; clearTimeout(timer); watcher?.dispose();
      for (const panel of panels.values()) panel.dispose();
      tables.update(); errors.update(); plans.refresh();
      log.appendLine((error as Error).message);
      await git.refresh();
      void documents.refresh();
      await tableEditor.refresh();
      refreshed.fire();
    }
  }
  function watchConfiguration(folder: vscode.WorkspaceFolder | undefined) {
    configurationGeneration++;
    if (configWatcher && configFolder?.uri.toString() === folder?.uri.toString()) return;
    configWatcher?.dispose(); configWatcher = undefined;
    configFolder = folder;
    if (!folder) return;
    let disposed = false;
    const changed = () => { if (!disposed && configFolder === folder) void configuredRoot(); };
    // Watch the directory synchronously: config replacement must retain the watch,
    // independently of VS Code watcherExclude changes and backend restarts.
    try {
      const nativeWatcher = watchDirectory(folder.uri.fsPath, { persistent: false }, (_, file) => {
        if (file === null || file.toString() === '.vibe-spec.json') changed();
      });
      configWatcher = new vscode.Disposable(() => { disposed = true; nativeWatcher.close(); });
      nativeWatcher.on('error', error => {
        if (disposed || configFolder !== folder) return;
        configWatcher?.dispose(); configWatcher = undefined;
        log.appendLine('설정 파일 감시 실패: ' + error.message);
        void configuredRoot();
      });
    } catch (error) {
      log.appendLine('설정 파일 감시 실패: ' + (error as Error).message);
    }
  }
  async function workspaceFoldersChanged() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const remembered = context.workspaceState.get<string>(workspaceStateKey);
    const folder = folders.length === 1 ? folders[0] : folders.find(folder => folder.uri.toString() === remembered);
    watchConfiguration(folder?.uri.scheme === 'file' ? folder : undefined);
    await configuredRoot();
  }
  const register = (command: string, action: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(command, async (...args: unknown[]) => {
      try { return await action(...args); }
      catch (error) { void vscode.window.showErrorMessage((error as Error).message); throw error; }
    });
  context.subscriptions.push(tables, errors, errorView, log, refreshed,
    register('vibe.selectFolder', (uri?: vscode.Uri, workspaceUri?: vscode.Uri) => selectFolder(uri, false, workspaceUri)),
    register('vibe.initFolder', (uri?: vscode.Uri, workspaceUri?: vscode.Uri) => selectFolder(uri, true, workspaceUri)),
    register('vibe.import', (uri?: vscode.Uri) => openImport(context, () => planningRoot, refresh, uri)),
    register('vibe.export', async (output?: string) => {
      const root = planningRoot;
      if (!root) throw new Error('먼저 기획 폴더를 선택해 주세요.');
      const result = await exportMarkdown(await loadProject(root), output);
      void vscode.window.showInformationMessage(
        `Markdown으로 테이블 ${result.files.length}개를 내보냈습니다. 출력 폴더: ${result.directory} · 검증 오류 ${result.diagnostics.filter(diagnostic => diagnostic.severity !== 'warning').length}개 · 경고 ${result.diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length}개`,
      );
      return result;
    }),
    register('vibe.openTable', openTable), register('vibe.openPlan', (name?: string) => plans.open(name)),
    register('vibe.openError', openError), register('vibe.refresh', refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void workspaceFoldersChanged(); }),
    { dispose() { clearTimeout(timer); watcher?.dispose(); configWatcher?.dispose(); for (const panel of panels.values()) panel.dispose(); } },
  );
  await workspaceFoldersChanged();
  return { planning: tables, tables, errors, plans, documents, git, refresh, getProject, onDidRefresh: refreshed.event };
}
