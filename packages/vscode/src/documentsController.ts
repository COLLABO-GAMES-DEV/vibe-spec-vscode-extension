import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  addDocumentImage, compareResourceNames, createDocument, deleteDocument, editDocument, getDocumentView,
  listDocuments, loadProject, renameResource, resourceEntries, resourceFile, saveDocumentSnapshots, VibeError, whereUsed,
} from '@vibe-spec/core';
import type { DocumentView, Project, WriteResult } from '@vibe-spec/core';
import { resourceNameError, resourceNameKey, suggestResourceName } from '@vibe-spec/core/names';
import type { DocumentsClientMessage, DocumentsHostMessage, DocumentsState } from '../../webview/src/documentsProtocol.js';
import { webviewHtml } from './webview.js';

interface CommandInput { name: string; revision: string; to?: string; confirmed?: boolean; folder?: string }
type Selection = CommandInput | vscode.TreeItem | string;
interface DocumentPanel {
  readonly panel: vscode.WebviewPanel;
  readonly root: string;
  name: string;
  focusPath: string | undefined;
  stateWork: Promise<void>;
  generation: number;
  pendingOpen: boolean;
  usagePath: string | undefined;
  dirty: boolean;
  flush?: { received?: boolean; requestId: string; resolve: (message: Extract<DocumentsClientMessage, { type: 'documentSnapshot' }>) => void; reject: (error: Error) => void };
}

function selectedName(input?: Selection): string | undefined {
  if (typeof input === 'string') return input;
  if (input && 'name' in input) return input.name;
  return typeof input?.label === 'string' ? input.label : input?.label?.label;
}
function requireRevision(revision: unknown): asserts revision is string {
  if (typeof revision !== 'string' || !revision) throw new VibeError('INVALID_EDIT', '문서를 읽었을 때의 revision이 필요합니다.');
}
function imageBytes(data: string): Uint8Array {
  if (typeof data !== 'string') throw new VibeError('INVALID_EDIT', '이미지 데이터를 확인해 주세요.');
  const base64 = data.replace(/^data:image\/(?:png|jpeg|gif|webp);base64,/, '');
  if (base64.length > Math.ceil(20 * 1024 * 1024 / 3) * 4) throw new VibeError('IMAGE_TOO_LARGE', '이미지는 20 MB 이하로 넣어 주세요.');
  if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new VibeError('INVALID_EDIT', '올바른 base64 이미지 데이터가 필요합니다.');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) throw new VibeError('INVALID_EDIT', '이미지 데이터를 확인해 주세요.');
  return bytes;
}

export class DocumentsController implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly commands: vscode.Disposable[];
  private readonly log = vscode.window.createOutputChannel('vibe-spec 문서');
  private readonly panels = new Map<string, DocumentPanel>();
  private flushing = false;
  private flushTimeout = 10_000;

  constructor(private readonly context: vscode.ExtensionContext,
    private readonly getProject: () => Project | undefined,
    private readonly refreshProject: () => Promise<void>,
    private readonly navigate: (path: string) => unknown | Promise<unknown>,
    private readonly selectedFolder: (input?: { folder?: string }) => string = () => '',
    private readonly draftChanged: (key: string, dirty: boolean) => void = () => {}) {
    const command = (name: string, handler: (...args: any[]) => Promise<unknown>) =>
      vscode.commands.registerCommand(name, async (...args: unknown[]) => {
        try { return await handler(...args); }
        catch (error) { void vscode.window.showErrorMessage((error as Error).message); throw error; }
      });
    this.commands = [
      command('vibe.openDocument', (input?: Selection, path?: string) => this.open(selectedName(input), path)),
      command('vibe.newDocument', (input?: CommandInput | (vscode.TreeItem & { folder?: string })) => this.create(input)),
      command('vibe.renameDocument', (input?: Selection) => this.rename(input)),
      command('vibe.deleteDocument', (input?: Selection) => this.remove(input)),
      command('vibe.documentUsage', (input?: Selection) => this.usage(input)),
    ];
  }

  getTreeItem(item: vscode.TreeItem) { return item; }
  getChildren(): vscode.TreeItem[] {
    const project = this.getProject();
    if (!project) return [];
    try {
      return listDocuments(project).sort((a, b) => compareResourceNames(a.name, b.name)).map(document => {
        const item = new vscode.TreeItem(document.name);
        item.contextValue = 'vibe-document';
        item.description = `오류 ${document.errors}개` + (document.warnings ? ` · 경고 ${document.warnings}개` : '');
        item.tooltip = resourceFile(project, 'document', document.name);
        item.iconPath = new vscode.ThemeIcon(document.errors ? 'error' : document.warnings ? 'warning' : 'markdown');
        item.command = { command: 'vibe.openDocument', title: '문서 열기', arguments: [document.name] };
        return item;
      });
    } catch (error) {
      const item = new vscode.TreeItem('문서 파일을 확인해 주세요.');
      item.tooltip = (error as Error).message; item.iconPath = new vscode.ThemeIcon('error');
      return [item];
    }
  }

  private current() {
    const project = this.getProject();
    if (!project) throw new Error('먼저 기획 폴더를 선택해 주세요.');
    return project;
  }
  private requireRoot(root: string) {
    if (this.getProject()?.root !== root) throw new VibeError('PROJECT_CHANGED', '기획 폴더가 바뀌었습니다.');
  }
  private key(root: string, name: string) { return JSON.stringify([root, name]); }
  private requireRenameTargetClosed(root: string, name: string, to: string) {
    if (to !== name && this.panels.has(this.key(root, to))) {
      throw new VibeError('DOCUMENT_OPEN', '해당 이름의 문서 탭이 열려 있습니다. 해당 탭의 초안을 확인하고 닫은 뒤 다시 시도해 주세요.');
    }
  }
  private live(session: DocumentPanel) {
    return this.panels.get(this.key(session.root, session.name)) === session && this.getProject()?.root === session.root;
  }
  private post(session: DocumentPanel, message: DocumentsHostMessage) {
    if (this.live(session)) void session.panel.webview.postMessage(message);
  }
  private renamed(session: DocumentPanel, name: string) {
    if (!this.live(session)) return;
    this.panels.delete(this.key(session.root, session.name));
    session.name = name; session.focusPath = undefined; session.usagePath = undefined; session.generation++;
    session.panel.title = name;
    this.panels.set(this.key(session.root, name), session);
  }
  private nameError(project: Project, name: string, replacing?: string) {
    const names = resourceEntries(project).filter(entry => entry.kind !== 'schema'
      && !(entry.kind === 'document' && entry.name === replacing)).map(entry => entry.name);
    const error = resourceNameError(name)
      ?? (names.some(other => resourceNameKey(other) === resourceNameKey(name)) ? '테이블 또는 문서 이름이 이미 있습니다.' : undefined);
    return error ? error + ' 이름 제안: ' + suggestResourceName(name, names) : undefined;
  }

  private async assets(project: Project, view: DocumentView | undefined, panel: vscode.WebviewPanel) {
    const result: Record<string, string> = {};
    let root: string, directory: string;
    try {
      root = await realpath(project.root);
      directory = await realpath(join(root, 'documents', 'assets'));
      // Neither documents nor assets may redirect the resource root through a symlink.
      if (relative(join(root, 'documents', 'assets'), directory) !== '') return result;
    } catch { return result; }
    for (const file of project.assets?.keys() ?? []) {
      if (!/^documents\/assets\/[^/\\]+\.(png|jpe?g|gif|webp)$/i.test(file)) continue;
      try {
        const actual = await realpath(join(root, file));
        const child = relative(directory, actual);
        if (!child || child === '..' || child.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(child)) continue;
        result[file.slice('documents/'.length)] = panel.webview.asWebviewUri(vscode.Uri.file(actual)).toString();
      } catch { /* A removed or inaccessible asset is reported by core, never loaded externally. */ }
    }
    for (const link of view?.links ?? []) {
      if (link.kind !== 'image') continue;
      try {
        const decoded = decodeURIComponent(link.destination);
        if (Object.hasOwn(result, decoded)) result[link.destination] = result[decoded]!;
      } catch { /* Invalid URL encoding is not an asset alias. */ }
    }
    return result;
  }

  private state(session: DocumentPanel, project: Project, replace = false, notice?: string, focus = replace): Promise<void> {
    const { panel, name, focusPath, generation } = session;
    const current = () => this.live(session) && session.name === name && session.generation === generation;
    // Serialize replies within each document. A watcher must not cancel the write
    // reply that releases this editor's pending draft, or replace another draft.
    const task = session.stateWork.then(async () => {
      if (!current()) return;
      const documents = listDocuments(project);
      const view = documents.some(document => document.name === name) ? getDocumentView(project, name) : undefined;
      const assets = await this.assets(project, view, panel);
      if (!current()) return;
      this.post(session, { type: 'documentsState', revision: project.revision, documents, assets, replace,
        ...(view ? { view } : {}), ...(focus && focusPath ? { focusPath } : {}), ...(notice ? { notice } : {}) });
    });
    session.stateWork = task.catch(() => {});
    return task;
  }
  async refresh() {
    this.changed.fire();
    const project = this.getProject();
    await Promise.all([...this.panels.values()].map(async session => {
      if (!project || project.root !== session.root) {
        session.flush?.reject(new VibeError('PROJECT_CHANGED', '기획 폴더가 바뀌었습니다. 초안을 유지합니다.'));
        if (!session.dirty && !session.flush) session.panel.dispose();
        return;
      }
      this.draftChanged(this.key(session.root, session.name), session.dirty);
      try { await this.state(session, project); }
      catch (error) { this.error(session, error); }
    }));
  }
  private error(session: DocumentPanel, error: unknown) {
    this.post(session, { type: 'error', code: error instanceof VibeError ? error.code : 'DOCUMENT_FAILED', message: (error as Error).message });
  }
  private async usage(input?: Selection) {
    const project = await loadProject(this.current().root);
    const name = selectedName(input) ?? await vscode.window.showQuickPick(
      listDocuments(project).map(document => document.name).sort(compareResourceNames), { placeHolder: '문서 선택' });
    if (!name) return;
    getDocumentView(project, name);
    this.requireRoot(project.root);
    const usages = await whereUsed(project, name);
    this.requireRoot(project.root);
    const panel = await this.open(name);
    if (!panel) return;
    const session = this.panels.get(this.key(project.root, name));
    if (session) {
      session.usagePath = name;
      if (!session.pendingOpen) this.post(session, { type: 'documentUsages', path: name, usages });
    }
    return usages;
  }
  private showCandidates(result: WriteResult) {
    if (!result.candidates.length) return;
    this.log.clear();
    for (const candidate of result.candidates) this.log.appendLine(`${candidate.file}:${candidate.line} ${candidate.text}`);
    void vscode.window.showInformationMessage(`기존 이름이 적힌 본문 ${result.candidates.length}곳은 직접 확인해 주세요.`, '후보 보기')
      .then(choice => { if (choice) this.log.show(); });
  }

  async create(input?: CommandInput | (vscode.TreeItem & { folder?: string })) {
    const explicit = input && 'name' in input ? input : undefined;
    const folder = this.selectedFolder(input);
    const project = await loadProject(this.current().root);
    const name = explicit?.name ?? await vscode.window.showInputBox({ prompt: '새 문서 이름', validateInput: name => this.nameError(project, name) });
    if (name === undefined) return;
    const revision = explicit ? explicit.revision : project.revision;
    requireRevision(revision);
    this.requireRoot(project.root);
    const result = await createDocument(project.root, revision, name, '', { folder });
    await this.refreshProject();
    if (this.getProject()?.root === project.root) await this.open(name);
    return result;
  }
  async rename(input?: Selection) {
    const project = await loadProject(this.current().root);
    const name = selectedName(input) ?? await vscode.window.showQuickPick(listDocuments(project).sort((a, b) => compareResourceNames(a.name, b.name)).map(document => document.name), { placeHolder: '문서 선택' });
    if (!name) return;
    getDocumentView(project, name);
    const explicit = input && typeof input === 'object' && 'name' in input ? input : undefined;
    const to = explicit?.to ?? await vscode.window.showInputBox({ prompt: '새 문서 이름', value: name, validateInput: to => this.nameError(project, to, name) });
    if (to === undefined) return;
    const revision = explicit ? explicit.revision : project.revision;
    requireRevision(revision);
    this.requireRoot(project.root);
    const session = this.panels.get(this.key(project.root, name));
    this.requireRenameTargetClosed(project.root, name, to);
    const result = await renameResource(project.root, revision, 'document', name, to);
    if (session) this.renamed(session, to);
    await this.refreshProject();
    if (this.getProject()?.root === project.root) await this.open(to);
    this.showCandidates(result);
    return result;
  }
  async remove(input?: Selection) {
    const project = await loadProject(this.current().root);
    const name = selectedName(input) ?? await vscode.window.showQuickPick(listDocuments(project).sort((a, b) => compareResourceNames(a.name, b.name)).map(document => document.name), { placeHolder: '문서 선택' });
    if (!name) return;
    getDocumentView(project, name);
    const explicit = input && typeof input === 'object' && 'name' in input ? input : undefined;
    const confirmed = explicit ? explicit.confirmed === true
      : await vscode.window.showWarningMessage(`문서 '${name}'을 삭제할까요?`, { modal: true }, '삭제') === '삭제';
    if (!confirmed) {
      if (explicit) throw new VibeError('CONFIRMATION_REQUIRED', '삭제할 문서를 확인해 주세요.');
      return;
    }
    const revision = explicit ? explicit.revision : project.revision;
    requireRevision(revision);
    this.requireRoot(project.root);
    const result = await deleteDocument(project.root, revision, name);
    this.panels.get(this.key(project.root, name))?.panel.dispose();
    await this.refreshProject();
    return result;
  }

  async open(name?: string, path?: string): Promise<vscode.WebviewPanel | undefined> {
    const project = await loadProject(this.current().root);
    name ??= await vscode.window.showQuickPick(listDocuments(project).map(document => document.name).sort(compareResourceNames), { placeHolder: '문서 선택' });
    if (!name) return;
    getDocumentView(project, name);
    if (path && path !== name && !path.startsWith(name + '/')) throw new VibeError('PATH_INVALID', '열 문서의 경로를 선택해 주세요.');
    this.requireRoot(project.root);
    for (const session of this.panels.values()) if (session.root !== project.root && !session.dirty && !session.flush) session.panel.dispose();
    const existing = this.panels.get(this.key(project.root, name));
    if (existing) {
      existing.focusPath = path;
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.One);
      await this.state(existing, project, false, undefined, Boolean(path));
      return existing.panel;
    }
    const root = project.root;
    const panel = vscode.window.createWebviewPanel('vibe.document', name, vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'), vscode.Uri.file(join(root, 'documents', 'assets'))],
    });
    const session: DocumentPanel = { panel, root, name, focusPath: path, stateWork: Promise.resolve(),
      generation: 0, pendingOpen: true, usagePath: undefined, dirty: false };
    this.panels.set(this.key(root, name), session);
    panel.onDidDispose(() => {
      const key = this.key(root, session.name);
      if (this.panels.get(key) === session) this.panels.delete(key);
      session.flush?.reject(new VibeError('DOCUMENT_CLOSED', '저장 중 문서가 닫혔습니다. 다시 저장해 주세요.'));
      this.draftChanged(this.key(root, session.name), false);
      session.generation++;
    });
    panel.webview.onDidReceiveMessage((message: DocumentsClientMessage) => this.receive(session, message));
    panel.webview.html = webviewHtml(this.context, panel, 'documents');
    return panel;
  }

  private async receive(session: DocumentPanel, message: DocumentsClientMessage) {
    const { root } = session;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'documentDraft') {
      session.dirty = message.dirty === true;
      if (this.live(session)) this.draftChanged(this.key(root, session.name), session.dirty);
      return;
    }
    if (message.type === 'documentSnapshot' || message.type === 'documentSnapshotError') {
      const pending = session.flush;
      if (!pending || pending.received || message.requestId !== pending.requestId) return;
      pending.received = true;
      if (!this.live(session)) { pending.reject(new VibeError('PROJECT_CHANGED', '기획 폴더가 바뀌었습니다.')); return; }
      if (message.type === 'documentSnapshotError') pending.reject(new VibeError('DOCUMENT_SNAPSHOT_FAILED', message.message));
      else if (message.name !== session.name || typeof message.dirty !== 'boolean' || !Array.isArray(message.blocks)) {
        pending.reject(new VibeError('INVALID_EDIT', '열린 문서의 저장 응답이 아닙니다.'));
      } else {
        session.dirty = message.dirty;
        this.draftChanged(this.key(root, session.name), session.dirty);
        pending.resolve(message);
      }
      return;
    }
    if (!this.live(session)) return;
    if (message.type === 'documentSaveRequest') {
      try { await vscode.commands.executeCommand('vibe.save', message.reason); }
      catch (error) { this.error(session, error); }
      return;
    }
    if (session.flush && !['ready', 'documentsRefresh', 'documentNavigate', 'documentUsage'].includes(message.type)) {
      this.error(session, new VibeError('OPERATION_RUNNING', '저장이 끝난 뒤 다시 시도해 주세요.')); return;
    }
    if (!['ready', 'documentsRefresh', 'documentOpen', 'documentCreate', 'documentEdit', 'documentDelete',
      'documentRename', 'documentImage', 'documentNavigate', 'documentUsage'].includes(message.type)) return;
    const selection = session.generation;
    try {
      const project = await loadProject(root);
      if (!this.live(session) || selection !== session.generation) return;
      if (message.type === 'documentOpen') { await this.open(message.name, message.path); return; }
      if (message.type === 'documentNavigate') {
        if (typeof message.path !== 'string') throw new VibeError('PATH_INVALID', '이동할 경로를 선택해 주세요.');
        if (/^(?:https?:|mailto:)/i.test(message.path)) await vscode.env.openExternal(vscode.Uri.parse(message.path));
        else if (/^[a-z][a-z\d+.-]*:/i.test(message.path)) throw new VibeError('PATH_INVALID', '지원하지 않는 링크입니다.');
        else await this.navigate(message.path);
        return;
      }
      if (message.type === 'documentUsage') {
        const usages = await whereUsed(project, message.path);
        if (this.live(session) && selection === session.generation) this.post(session, { type: 'documentUsages', path: message.path, usages });
        return;
      }
      if (message.type === 'ready' || message.type === 'documentsRefresh') {
        const focus = message.type === 'ready' && session.pendingOpen;
        if (message.type === 'ready') session.pendingOpen = false;
        await this.state(session, project, false, undefined, focus);
        if (message.type === 'ready' && session.usagePath) {
          const path = session.usagePath;
          this.post(session, { type: 'documentUsages', path, usages: await whereUsed(project, path) });
        }
        return;
      }
      if (!('revision' in message)) throw new VibeError('INVALID_EDIT', '문서를 읽었을 때의 revision이 필요합니다.');
      requireRevision(message.revision);
      if (message.type === 'documentImage') {
        if (!session.name) throw new VibeError('INVALID_EDIT', '이미지를 넣을 문서를 열어 주세요.');
        getDocumentView(project, session.name);
        const bytes = imageBytes(message.data);
        if (project.revision !== message.revision) throw new VibeError('STALE_REVISION', '이미지를 넣기 전에 파일이 바뀌었습니다.');
        const result = await addDocumentImage(root, message.revision, { name: message.name, bytes });
        if (!this.live(session)) return;
        const after = await loadProject(root), expectedAssets = new Map(project.assets);
        expectedAssets.set('documents/' + result.path, bytes);
        if (after.revision !== result.revision || after.sources.size !== project.sources.size ||
          [...project.sources].some(([file, source]) => after.sources.get(file) !== source) ||
          JSON.stringify(after.directories) !== JSON.stringify(project.directories) || after.assets?.size !== expectedAssets.size ||
          [...expectedAssets].some(([file, bytes]) => !Buffer.from(after.assets?.get(file) ?? []).equals(Buffer.from(bytes)))) {
          throw new VibeError('STALE_REVISION', '이미지 업로드 중 파일이 바뀌었습니다. 초안을 유지합니다.');
        }
        if (selection === session.generation) this.post(session, { type: 'documentImageAdded', path: result.path, revision: result.revision });
        // Uploading an asset must not discard the block draft that will insert it.
        await this.refreshProject(); await this.state(session, this.current()); return;
      }
      let result: WriteResult;
      if (message.type === 'documentCreate') {
        result = await createDocument(root, message.revision, message.name, '');
      } else if (message.type === 'documentRename') {
        if (!['document', 'heading', 'tag'].includes(message.kind) || !session.name || typeof message.path !== 'string'
          || (message.kind === 'document' ? message.path !== session.name : !message.path.startsWith(session.name + '/'))) {
          throw new VibeError('INVALID_EDIT', '열린 문서의 이름·제목·이름표를 선택해 주세요.');
        }
        if (message.kind === 'document') this.requireRenameTargetClosed(root, session.name, message.to);
        result = await renameResource(root, message.revision, message.kind, message.path, message.to);
      } else {
        if (!session.name || message.name !== session.name) throw new VibeError('INVALID_EDIT', '열린 문서만 편집할 수 있습니다.');
        if (message.type === 'documentDelete') {
          if (message.confirmed !== true) throw new VibeError('CONFIRMATION_REQUIRED', '삭제할 문서를 확인해 주세요.');
          result = await deleteDocument(root, message.revision, message.name);
        } else if (message.type === 'documentEdit') result = await editDocument(root, message.revision, message.name, message.operations);
        else return;
      }
      if (!this.live(session)) return;
      if (selection !== session.generation) { await this.refreshProject(); return; }
      if (message.type === 'documentCreate') { await this.refreshProject(); await this.open(message.name); return; }
      if (message.type === 'documentDelete') { session.panel.dispose(); await this.refreshProject(); return; }
      if (message.type === 'documentRename') {
        if (message.kind === 'document') this.renamed(session, message.to);
        this.showCandidates(result);
      }
      session.focusPath = undefined;
      await this.refreshProject();
      if (this.live(session)) await this.state(session, this.current(), true);
    } catch (error) {
      if (!this.live(session) || selection !== session.generation) return;
      this.error(session, error);
      try { await this.refreshProject(); await this.state(session, this.current()); }
      catch (refreshError) { this.log.appendLine((refreshError as Error).message); }
    }
  }

  /** Query every open frame, including frames whose dirty notification is still in flight. */
  async flush(root: string, beforeWrite: () => Promise<void>): Promise<WriteResult | undefined> {
    if (this.flushing) throw new VibeError('OPERATION_RUNNING', '문서를 저장하고 있습니다.');
    this.requireRoot(root);
    this.flushing = true;
    const sessions = [...this.panels.values()].filter(session => session.root === root);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let written: WriteResult | undefined;
    try {
      const project = await loadProject(root);
      const snapshots = await Promise.all(sessions.map(session => new Promise<Extract<DocumentsClientMessage, { type: 'documentSnapshot' }>>((resolve, reject) => {
        const requestId = randomUUID();
        session.flush = { requestId, resolve, reject };
        timers.push(setTimeout(() => reject(new VibeError('DOCUMENT_FLUSH_TIMEOUT', '문서 편집기가 저장에 응답하지 않습니다. 초안을 유지한 채 다시 시도해 주세요.')), this.flushTimeout));
        void session.panel.webview.postMessage({ type: 'documentFlush', requestId } satisfies DocumentsHostMessage)
          .then(sent => { if (!sent) reject(new VibeError('DOCUMENT_UNAVAILABLE', '문서 편집기를 열고 다시 저장해 주세요.')); }, reject);
      })));
      this.requireRoot(root);
      if (sessions.some(session => !this.live(session)) || [...this.panels.values()].filter(session => session.root === root).length !== sessions.length) {
        throw new VibeError('DOCUMENT_CHANGED', '열린 문서가 바뀌었습니다. 다시 저장해 주세요.');
      }
      const dirty = snapshots.filter(snapshot => snapshot.dirty);
      if (dirty.some(snapshot => snapshot.revision !== project.revision)) throw new VibeError('STALE_REVISION', '문서를 편집하는 동안 파일이 바뀌었습니다. 초안을 유지합니다.');
      await beforeWrite();
      this.requireRoot(root);
      if (sessions.some(session => !this.live(session))) throw new VibeError('DOCUMENT_CLOSED', '저장 중 문서가 닫혔습니다.');
      if (dirty.length) written = await saveDocumentSnapshots(root, project.revision, dirty.map(({ name, blocks }) => ({ name, blocks })), {});
      // A successful file write is acknowledged even if a later Git commit fails.
      const baseline = written?.planned ?? project;
      await Promise.all(sessions.map(session => {
        const requestId = session.flush!.requestId;
        // Drain older watcher states before rebaselining this frame. Later
        // watcher replies must queue after this acknowledgement as well.
        const task = session.stateWork.then(async () => {
          const view = listDocuments(baseline).some(document => document.name === session.name) ? getDocumentView(baseline, session.name) : undefined;
          const state: DocumentsState = { type: 'documentsState', revision: baseline.revision,
            documents: listDocuments(baseline), ...(view ? { view } : {}), assets: await this.assets(baseline, view, session.panel), replace: true };
          session.dirty = false;
          this.draftChanged(this.key(root, session.name), false);
          try { await session.panel.webview.postMessage({ type: 'documentFlushResult', requestId, ok: true, state } satisfies DocumentsHostMessage); }
          catch (error) { this.log.appendLine('파일 반영 후 문서 응답 실패: ' + (error as Error).message); }
        });
        session.stateWork = task.catch(() => {});
        return task;
      }));
      return written;
    } catch (error) {
      for (const session of sessions) if (session.flush) {
        try { await session.panel.webview.postMessage({ type: 'documentFlushResult', requestId: session.flush.requestId, ok: false,
          code: error instanceof VibeError ? error.code : 'DOCUMENT_FAILED', message: (error as Error).message } satisfies DocumentsHostMessage); }
        catch { /* A closed frame cannot receive the release; other frames still must. */ }
      }
      throw error;
    } finally {
      for (const timer of timers) clearTimeout(timer);
      for (const session of sessions) delete session.flush;
      this.flushing = false;
    }
  }

  dispose() { for (const session of this.panels.values()) session.panel.dispose(); this.changed.dispose(); this.log.dispose(); for (const command of this.commands) command.dispose(); }
}
