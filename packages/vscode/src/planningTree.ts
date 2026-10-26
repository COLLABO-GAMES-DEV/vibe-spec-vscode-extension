import { pathParts, pathFromParts, appendPath, pathContains } from '@vibe-spec/core/paths';
import * as vscode from 'vscode';
import { posix } from 'node:path';
import {
  applyFolderEdit, folderStorage, compareResourceNames, folderError, listFolders, loadProject, resourceEntries, resourceFile,
  validateProject, VibeError,
} from '@vibe-spec/core';
import type { FolderOperation, Project } from '@vibe-spec/core';

export class PlanningItem extends vscode.TreeItem {
  constructor(readonly kind: 'folder' | 'table' | 'document', readonly folder: string,
    readonly projectRoot: string, label: string, readonly resource?: string) { super(label); }
}
interface FolderInput {
  path?: string; name?: string; folder?: string; kind?: 'table' | 'document';
  revision?: string; confirmed?: boolean;
  projectRoot?: string; create?: 'folder' | 'table' | 'document';
  table?: string; key?: { code: string; label: string };
}
type Selection = PlanningItem | FolderInput;
const parentFolder = (path: string) => pathFromParts(pathParts(path).slice(0, -1));
const folderLabel = (path: string) => pathParts(path).join(' › ');
const childPath = (folder: string, name: string) => pathFromParts([...(folder ? pathParts(folder) : []), name]);

export class PlanningTree implements vscode.TreeDataProvider<PlanningItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<PlanningItem>;
  private readonly subscriptions: vscode.Disposable[];
  constructor(private readonly context: vscode.ExtensionContext,
    private readonly getProject: () => Project | undefined, private readonly refresh: () => Promise<void>) {
    this.view = vscode.window.createTreeView('vibe.tables', { treeDataProvider: this, showCollapseAll: true });
    const command = (id: string, handler: (input?: Selection) => Promise<unknown>) => vscode.commands.registerCommand(id, async input => {
      try { return await handler(input); }
      catch (error) { void vscode.window.showErrorMessage((error as Error).message); throw error; }
    });
    this.subscriptions = [
      this.view.onDidExpandElement(({ element }) => { void this.setExpanded(element, true); }),
      this.view.onDidCollapseElement(({ element }) => { void this.setExpanded(element, false); }),
      command('vibe.newResource', input => this.create(input)),
      command('vibe.newFolder', input => this.edit('folder-create', input)),
      command('vibe.renameFolder', input => this.edit('folder-rename', input)),
      command('vibe.deleteFolder', input => this.edit('folder-delete', input)),
      command('vibe.moveFolder', input => this.edit('folder-move', input)),
      command('vibe.moveResource', input => this.edit('resource-move', input)),
    ];
  }
  update() { this.changed.fire(); }
  getTreeItem(item: PlanningItem) { return item; }
  private stateKey(root: string, folder: string) { return 'vibe.folderExpanded:' + JSON.stringify([root, folder]); }
  async setExpanded(item: PlanningItem, expanded: boolean) {
    if (item.kind === 'folder') await this.context.workspaceState.update(this.stateKey(item.projectRoot, item.folder), expanded);
  }
  selectedFolder(input?: { folder?: string; projectRoot?: string }): string {
    const root = this.getProject()?.root;
    if (input?.projectRoot && input.projectRoot !== root) throw new VibeError('PROJECT_CHANGED', '기획 폴더가 바뀌었습니다.');
    const selected = this.view.selection[0];
    return input?.folder ?? (selected?.projectRoot === root ? selected?.folder : undefined) ?? '';
  }
  private async create(selection?: Selection) {
    const project = this.getProject();
    if (!project) throw new Error('먼저 기획 폴더를 선택해 주세요.');
    const folder = this.selectedFolder(selection);
    const input = selection instanceof PlanningItem ? undefined : selection;
    const choices = [
      { label: '폴더', command: 'vibe.newFolder', create: 'folder' },
      { label: '표', command: 'vibe.newTable', create: 'table' },
      { label: '문서', command: 'vibe.newDocument', create: 'document' },
    ];
    const choice = input?.create === undefined ? await vscode.window.showQuickPick(choices, {
      title: '새로 만들기: 폴더·표·문서', placeHolder: '만들 위치: ' + (folderLabel(folder) || '최상위 (루트)'),
    }) : choices.find(choice => choice.create === input.create);
    if (!choice) return;
    // Keep the destination captured before the picker, even if selection changes.
    this.selectedFolder({ folder, projectRoot: project.root });
    return vscode.commands.executeCommand(choice.command, { ...input, folder, projectRoot: project.root });
  }
  getParent(item: PlanningItem): PlanningItem | undefined {
    const folder = item.kind === 'folder' ? parentFolder(item.folder) : item.folder;
    return folder ? this.folderItem(item.projectRoot, folder) : undefined;
  }
  private folderItem(root: string, folder: string) {
    const item = new PlanningItem('folder', folder, root, pathParts(folder).at(-1)!);
    item.id = JSON.stringify([root, 'folder', folder]);
    item.contextValue = 'vibe-folder'; item.iconPath = new vscode.ThemeIcon('folder');
    const project = this.getProject();
    const storage = project?.root === root ? folderStorage(project, folder) : folder;
    item.tooltip = 'tables/' + storage + '/\ndocuments/' + storage + '/';
    item.collapsibleState = this.context.workspaceState.get(this.stateKey(root, folder), false)
      ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    return item;
  }
  getChildren(parent?: PlanningItem): PlanningItem[] {
    const project = this.getProject();
    if (!project || parent && (parent.kind !== 'folder' || parent.projectRoot !== project.root)) return [];
    const folder = parent?.folder ?? '';
    const diagnostics = validateProject(project);
    const counts = (files: string[]) => {
      const relevant = diagnostics.filter(diagnostic => files.includes(diagnostic.file));
      const errors = relevant.filter(diagnostic => diagnostic.severity !== 'warning').length;
      const warnings = relevant.length - errors;
      return '오류 ' + errors + '개' + (warnings ? ' · 경고 ' + warnings + '개' : '');
    };
    const entries = resourceEntries(project).filter(entry => entry.kind !== 'schema');
    const diagnosticFiles = (entry: typeof entries[number]) => {
      const data = project.files.get(entry.file)?.data;
      const schema = entry.kind === 'table' && data && typeof data === 'object' && 'schema' in data && typeof data.schema === 'string'
        ? resourceFile(project, 'schema', data.schema) : undefined;
      return schema ? [entry.file, schema] : [entry.file];
    };
    const folders = listFolders(project).filter(path => parentFolder(path) === folder).map(path => {
      const item = this.folderItem(project.root, path);
      item.description = counts(entries.filter(entry => pathContains(path, entry.folder)).flatMap(diagnosticFiles));
      return item;
    });
    const resources = entries.filter(entry => entry.folder === folder).map(entry => {
      const kind = entry.kind as 'table' | 'document';
      const item = new PlanningItem(kind, folder, project.root, entry.name, entry.name);
      item.id = JSON.stringify([project.root, kind, entry.file]); item.contextValue = 'vibe-' + kind;
      item.description = counts(diagnosticFiles(entry)); item.tooltip = entry.file;
      item.iconPath = new vscode.ThemeIcon(kind === 'table' ? 'table' : 'markdown');
      item.command = { command: kind === 'table' ? 'vibe.openTable' : 'vibe.openDocument', title: '열기', arguments: [entry.name] };
      return item;
    }).sort((a, b) => compareResourceNames(String(a.label), String(b.label)));
    return [...folders, ...resources];
  }
  private async edit(op: FolderOperation['op'], selection?: Selection) {
    const current = this.getProject();
    if (!current) throw new Error('먼저 기획 폴더를 선택해 주세요.');
    if (selection instanceof PlanningItem && selection.projectRoot !== current.root) throw new VibeError('PROJECT_CHANGED', '기획 폴더가 바뀌었습니다.');
    const project = await loadProject(current.root);
    const input = selection instanceof PlanningItem ? undefined : selection;
    const folders = listFolders(project);
    let operation: FolderOperation;
    if (op === 'folder-create') {
      let path = input?.path;
      if (path === undefined) {
        const parent = this.selectedFolder(selection);
        const name = input?.name ?? await vscode.window.showInputBox({ prompt: '새 폴더 이름 · ' + (folderLabel(parent) || '최상위'),
          validateInput: name => folderError(childPath(parent, name)) });
        if (name === undefined) return;
        path = childPath(parent, name);
      }
      operation = { op, path };
    } else if (op === 'resource-move') {
      const kind = selection instanceof PlanningItem && selection.kind !== 'folder' ? selection.kind : input?.kind;
      const name = selection instanceof PlanningItem ? selection.resource : input?.name;
      if (!kind || !name || !resourceFile(project, kind, name)) throw new VibeError('PATH_NOT_FOUND', '이동할 표 또는 문서를 선택해 주세요.');
      const folder = input?.folder ?? await this.destination(folders);
      if (folder === undefined) return;
      operation = { op, kind, name, folder };
    } else {
      const path = selection instanceof PlanningItem ? selection.folder : input?.path
        ?? (await vscode.window.showQuickPick(folders.map(folder => ({ label: folderLabel(folder), folder })), { placeHolder: '폴더 선택' }))?.folder;
      if (!path) return;
      if (op === 'folder-rename') {
        const name = input?.name ?? await vscode.window.showInputBox({ prompt: '새 폴더 이름', value: pathParts(path).at(-1)!,
          validateInput: name => folderError(childPath(parentFolder(path), name)) });
        if (name === undefined) return;
        operation = { op, path, name };
      } else if (op === 'folder-move') {
        const folder = input?.folder ?? await this.destination(folders.filter(folder => folder !== path && !pathContains(path, folder)));
        if (folder === undefined) return;
        operation = { op, path, folder };
      } else operation = { op, path };
    }
    const revision = input?.revision ?? project.revision;
    const preview = await applyFolderEdit(project.root, revision, operation, { dryRun: true });
    if (input?.confirmed !== true) {
      const target = operation.op === 'resource-move' || operation.op === 'folder-move' ? operation.folder || '최상위'
        : operation.op === 'folder-rename' ? childPath(parentFolder(operation.path), operation.name) : operation.path;
      const accepted = await vscode.window.showInformationMessage('폴더 작업을 적용할까요?', {
        modal: true, detail: '대상: ' + folderLabel(target) + '\n\n변경 파일:\n' + preview.changed.join('\n'),
      }, '적용');
      if (accepted !== '적용') return;
    }
    if (this.getProject()?.root !== project.root) throw new VibeError('PROJECT_CHANGED', '기획 폴더가 바뀌었습니다.');
    const result = await applyFolderEdit(project.root, revision, operation);
    await this.refresh(); return result;
  }
  private async destination(folders: string[]): Promise<string | undefined> {
    const choice = await vscode.window.showQuickPick([{ label: '최상위', folder: '' }, ...folders.map(folder => ({ label: folderLabel(folder), folder }))],
      { placeHolder: '대상 폴더 선택' });
    return choice?.folder;
  }
  dispose() { this.view.dispose(); this.changed.dispose(); for (const subscription of this.subscriptions) subscription.dispose(); }
}
