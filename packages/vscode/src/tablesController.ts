import * as vscode from 'vscode';
import { applyStructureEdit, inspectStructure, renameResource, tableSummaries, VibeError } from '@vibe-spec/core';
import type { Project, StructurePreview } from '@vibe-spec/core';
import type { TablesClientMessage, TablesHostMessage, TablesMode } from '../../webview/src/tablesProtocol.js';
import { webviewHtml } from './webview.js';

interface CommandInput { table: string; key?: { code: string; label: string }; to?: string; confirmed?: boolean; revision?: string; folder?: string }
export class TablesController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelRoot: string | undefined;
  private mode: TablesMode = 'list';
  private selected: string | undefined;
  private createFolder = '';
  private preview: StructurePreview | undefined;
  private commands: vscode.Disposable[];
  private log = vscode.window.createOutputChannel('vibe-spec 테이블 이름 변경');
  constructor(private context: vscode.ExtensionContext, private project: () => Project | undefined,
    private refreshProject: () => Promise<void>, private openTable: (name: string) => Promise<unknown>, private closeTable: (name: string) => void,
    private selectedFolder: (input?: { folder?: string }) => string = () => '') {
    const command = (name: string, handler: (input?: CommandInput | vscode.TreeItem | string) => Promise<unknown>) =>
      vscode.commands.registerCommand(name, async input => { try { return await handler(input); }
        catch (error) { void vscode.window.showErrorMessage((error as Error).message); throw error; } });
    const tableName = (input?: CommandInput | vscode.TreeItem | string) => typeof input === 'string' ? input
      : input && 'table' in input ? input.table : input && typeof input.label === 'string' ? input.label : undefined;
    this.commands = [
      command('vibe.newTable', async input => input && typeof input === 'object' && 'table' in input && input.key
        ? this.create(input) : this.open('create', undefined, this.selectedFolder(typeof input === 'object' && 'folder' in input ? input as { folder?: string } : undefined))),
      command('vibe.renameTable', async input => input && typeof input === 'object' && 'table' in input && input.to
        ? this.rename(input) : this.open('rename', tableName(input))),
      command('vibe.deleteTable', async input => input && typeof input === 'object' && 'table' in input && input.confirmed
        ? this.remove(input) : this.open('delete', tableName(input))),
    ];
  }
  private current() { const project = this.project(); if (!project) throw new Error('먼저 기획 폴더를 선택해 주세요.'); return project; }
  private post(message: TablesHostMessage) { if (this.panel) void this.panel.webview.postMessage(message); }
  async refresh(notice?: string) {
    const project = this.project();
    if (this.panelRoot && this.panelRoot !== project?.root) { this.panel?.dispose(); this.preview = undefined; return; }
    if (project) this.post({ type: 'tablesState', revision: project.revision, tables: tableSummaries(project), mode: this.mode,
      ...(this.selected ? { selected: this.selected } : {}), ...(this.preview ? { preview: this.preview } : {}), ...(notice ? { notice } : {}) });
  }
  private async create(input: CommandInput) {
    const project = this.current();
    if (!input.key) throw new VibeError('INVALID_EDIT', 'Key 열을 입력해 주세요.');
    const result = await applyStructureEdit(project.root, input.revision ?? project.revision, { op: 'table-create', table: input.table, key: input.key, folder: input.folder ?? this.selectedFolder() });
    await this.refreshProject(); await this.refresh('새 테이블을 만들었습니다.'); await this.openTable(input.table); return result;
  }
  private async rename(input: CommandInput) {
    const project = this.current();
    if (!input.to) throw new VibeError('INVALID_EDIT', '새 이름을 입력해 주세요.');
    const result = await renameResource(project.root, input.revision ?? project.revision, 'table', input.table, input.to);
    this.closeTable(input.table); this.selected = input.to;
    await this.refreshProject(); await this.refresh('테이블 이름을 바꿨습니다.'); await this.openTable(input.to);
    if (result.candidates.length) {
      this.log.clear();
      for (const candidate of result.candidates) this.log.appendLine(`${candidate.file}:${candidate.line} ${candidate.text}`);
      void vscode.window.showInformationMessage('기존 이름이 적힌 본문 ' + result.candidates.length + '곳은 직접 확인해 주세요.', '후보 보기')
        .then(choice => { if (choice) this.log.show(); });
    }
    return result;
  }
  private async remove(input: CommandInput) {
    const project = this.current();
    if (!input.confirmed) throw new VibeError('CONFIRMATION_REQUIRED', '삭제할 내용을 먼저 확인해 주세요.');
    const result = await applyStructureEdit(project.root, input.revision ?? project.revision, { op: 'table-delete', table: input.table });
    this.closeTable(input.table); this.selected = undefined; this.preview = undefined; this.mode = 'list';
    await this.refreshProject(); await this.refresh('테이블을 삭제했습니다.'); return result;
  }
  async open(mode: TablesMode, table?: string, folder?: string) {
    if (mode === 'create') this.createFolder = folder ?? this.selectedFolder();
    const project = this.current();
    if (mode !== 'create' && mode !== 'list' && !table) {
      table = await vscode.window.showQuickPick(tableSummaries(project).map(item => item.name), { placeHolder: '테이블 선택' });
      if (!table) return;
    }
    this.mode = mode; this.selected = table; this.preview = mode === 'delete' && table
      ? await inspectStructure(project, { op: 'table-delete', table }) : undefined;
    if (this.panel && this.panelRoot === project.root) { this.panel.title = mode === 'create' && this.createFolder ? '새 테이블 · ' + this.createFolder : '테이블 관리'; this.panel.reveal(vscode.ViewColumn.One); await this.refresh(); return this.panel; }
    this.panelRoot = project.root;
    const panel = vscode.window.createWebviewPanel('vibe.tablesEditor', mode === 'create' && this.createFolder ? '새 테이블 · ' + this.createFolder : '테이블 관리', vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    });
    this.panel = panel;
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    panel.webview.onDidReceiveMessage(async (message: TablesClientMessage) => {
      try {
        const current = this.current();
        if (current.root !== this.panelRoot) throw new Error('기획 폴더가 바뀌었습니다. 관리 창을 다시 열어 주세요.');
        if (message.type === 'ready' || message.type === 'tablesRefresh') { await this.refresh(); return; }
        if (message.type === 'tableSelect') { await this.open(message.mode, message.table); return; }
        if (message.type === 'tableOpen') { await this.openTable(message.table); return; }
        if (message.type === 'tableCreate') { await this.create({ ...message, folder: this.createFolder }); return; }
        if (message.type === 'tableRename') { await this.rename(message); return; }
        if (message.type === 'tablePreviewDelete') {
          this.mode = 'delete'; this.selected = message.table;
          this.preview = await inspectStructure(current, { op: 'table-delete', table: message.table }); await this.refresh(); return;
        }
        if (message.type === 'tableDelete') {
          if (!this.preview || this.preview.operation.table !== message.table || this.preview.revision !== message.revision) {
            throw new VibeError('CONFIRMATION_REQUIRED', '삭제 미리보기를 다시 확인해 주세요.');
          }
          await this.remove(message);
        }
      } catch (error) {
        await this.refreshProject();
        if (this.selected && this.mode === 'delete') {
          try { this.preview = await inspectStructure(this.current(), { op: 'table-delete', table: this.selected }); await this.refresh(); }
          catch { /* Retain the original operation error if its table disappeared. */ }
        }
        this.post({ type: 'error', code: error instanceof VibeError ? error.code : 'TABLE_FAILED', message: (error as Error).message });
      }
    });
    panel.webview.html = webviewHtml(this.context, panel, 'tables'); return panel;
  }
  dispose() { this.panel?.dispose(); this.log.dispose(); for (const item of this.commands) item.dispose(); }
}
