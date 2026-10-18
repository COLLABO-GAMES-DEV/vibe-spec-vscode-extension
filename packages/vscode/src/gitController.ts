import * as vscode from 'vscode';
import { watch, type FSWatcher } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, relative, sep } from 'node:path';
import { getGitStatus, loadProject, pullProject, pushProject, resolveProject, saveProject, VibeError } from '@vibe-spec/core';
import type { GitResult, GitStatus, WriteResult } from '@vibe-spec/core';
import type { GitClientMessage, GitHostMessage } from '../../webview/src/gitProtocol.js';
import { webviewHtml } from './webview.js';

const exec = promisify(execFile);
// File flushes intentionally change the worktree status, but never HEAD or index.
async function gitFence(status: GitStatus) {
  if (!status.repository) return { control: '', changes: [] as string[] };
  const git = async (...args: string[]) => (await exec('git', ['-C', status.repository!, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;
  const [head, index, changes] = await Promise.all([git('rev-parse', '--revs-only', 'HEAD'), git('ls-files', '--stage', '-z'),
    git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')]);
  return { control: JSON.stringify([status.repository, status.branch, status.mergeInProgress, head, index]), changes: changes.split('\0').filter(Boolean) };
}
const labels = { unsaved: '저장 전', unpublished: '올리기 전', published: '올리기 완료', conflict: '충돌 해결 필요' };
export class GitController implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  status: GitStatus | undefined;
  private drafts = new Set<string>();
  private documentDrafts = new Set<string>();
  private panel: vscode.WebviewPanel | undefined;
  private panelRoot: string | undefined;
  private currentRoot: string | undefined;
  private watcher: vscode.Disposable | undefined;
  private watched: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticket = 0;
  private busy = false;
  private refreshing: Promise<void> = Promise.resolve();
  private error = '';
  private disposables: vscode.Disposable[] = [];
  constructor(private context: vscode.ExtensionContext, private root: () => string | undefined,
    private refreshProject: () => Promise<void>,
    private flushDocuments?: (root: string, beforeWrite: () => Promise<void>) => Promise<WriteResult | undefined>) {
    this.disposables.push(vscode.window.createTreeView('vibe.delivery', { treeDataProvider: this }),
      vscode.commands.registerCommand('vibe.save', async (reason?: string) => {
        const planningRoot = this.root();
        if (!planningRoot) throw new Error('먼저 기획 폴더를 선택해 주세요.');
        const status = await getGitStatus(planningRoot);
        reason ??= await vscode.window.showInputBox({ title: '변경 사유와 함께 저장', prompt: '이번 변경의 이유를 적어 주세요.',
          validateInput: text => text.trim() ? undefined : '변경 사유를 입력해 주세요.' });
        if (!reason?.trim()) return;
        return this.save(planningRoot, reason, status.revision);
      }),
      vscode.commands.registerCommand('vibe.push', async () => {
        await this.refresh();
        if (this.status?.outgoing.some(commit => commit.otherFiles)) {
          await this.open();
          void vscode.window.showInformationMessage('기획 외 파일을 포함한 저장 내용이 있습니다. 목록을 확인한 뒤 올려 주세요.');
          return;
        }
        return this.run('push', pushProject);
      }),
      vscode.commands.registerCommand('vibe.pull', () => this.run('pull', root => { this.requireFinishedDrafts(); this.requireNoDocumentDrafts(); return pullProject(root); })),
      vscode.commands.registerCommand('vibe.git', () => this.open()),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) void this.refresh(); }));
  }
  getTreeItem(item: vscode.TreeItem) { return item; }
  getChildren() {
    if (!this.root()) return [new vscode.TreeItem('먼저 기획 폴더를 선택해 주세요.')];
    const state = new vscode.TreeItem(this.busy ? '처리 중…' : (this.drafts.size || this.documentDrafts.size) ? '편집 중' : this.error || (this.status ? labels[this.status.state] : '상태 확인 중…'));
    state.command = { command: 'vibe.git', title: '저장·올리기 상태 보기' };
    if (this.status) {
      state.description = `저장 전 ${this.status.changes.length}파일 · 올릴 저장 ${this.status.outgoing.length}건`;
      state.tooltip = this.status.remote ? '마지막 원격 확인 기준 · ' + this.status.remote.url : '원격이 연결되지 않았습니다.';
    }
    return [state, ...[
      ['변경 사유와 함께 저장', 'vibe.save', 'save'], ['올리기', 'vibe.push', 'cloud-upload'], ['받아오기', 'vibe.pull', 'cloud-download'],
    ].map(([label, command, icon]) => {
      const item = new vscode.TreeItem(label!); item.command = { command: command!, title: label! }; item.iconPath = new vscode.ThemeIcon(icon!); return item;
    })];
  }
  draft(table: string, active: boolean) {
    if (active) this.drafts.add(table); else this.drafts.delete(table);
    this.changed.fire(); this.postState();
  }
  documentDraft(key: string, active: boolean) {
    if (active) this.documentDrafts.add(key); else this.documentDrafts.delete(key);
    this.changed.fire(); this.postState();
  }
  private requireFinishedDrafts() {
    if (this.drafts.size) throw new VibeError('EDITING_DRAFT', '입력 중인 칸이나 새 행을 먼저 확정하거나 취소해 주세요.');
  }
  private requireNoDocumentDrafts() {
    if (this.documentDrafts.size) throw new VibeError('EDITING_DRAFT', '편집 중인 문서를 먼저 저장해 주세요.');
  }
  private post(message: GitHostMessage) { if (this.panel) void this.panel.webview.postMessage(message); }
  private postState(result?: GitResult) {
    if (this.status) this.post({ type: 'gitState', status: this.status, editing: this.drafts.size > 0 || this.documentDrafts.size > 0, ...(result ? { result } : {}) });
  }
  refresh(): Promise<void> {
    const task = this.refreshNow();
    this.refreshing = task;
    return task.then(async () => { if (this.refreshing !== task) await this.refreshing; });
  }
  private async refreshNow() {
    if (this.busy) return;
    const root = this.root(), ticket = ++this.ticket;
    if (this.currentRoot !== root) { this.panel?.dispose(); this.drafts.clear(); this.documentDrafts.clear(); this.currentRoot = root; this.status = undefined; this.error = ''; this.changed.fire(); }
    if (!root) { this.status = undefined; this.watcher?.dispose(); this.watched = null; this.changed.fire(); return; }
    try {
      const status = await getGitStatus(root);
      if (ticket !== this.ticket || root !== this.root()) return;
      this.status = status; this.error = '';
      const watched = status.gitDir ? JSON.stringify([status.gitDir, status.branch]) : null;
      if (this.watched !== watched) {
        this.watcher?.dispose(); this.watcher = undefined; this.watched = null;
        if (status.gitDir) {
          // Watch directories so Git's atomic file replacements keep producing events.
          // Node watchers are independent of VS Code's workspace watcher exclusions.
          const targets = [{ directory: status.gitDir, files: new Set(['HEAD', 'index', 'MERGE_HEAD', 'packed-refs']) }];
          if (status.branch) {
            const ref = join(status.gitDir, 'refs', 'heads', status.branch);
            targets.push({ directory: dirname(ref), files: new Set([basename(ref)]) });
          }
          const update = () => { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.refresh(); }, 120); };
          const watchers: FSWatcher[] = [];
          try {
            for (const target of targets) {
              const watcher = watch(target.directory, { persistent: false }, (_, file) => {
                if (file === null || target.files.has(file.toString())) update();
              });
              watcher.on('error', error => {
                if (this.watched !== watched) return;
                this.watcher?.dispose(); this.watched = null;
                this.error = '상태 감시 실패'; this.changed.fire();
                this.post({ type: 'error', code: 'GIT_WATCH_FAILED', message: error.message });
              });
              watchers.push(watcher);
            }
            this.watcher = new vscode.Disposable(() => { for (const watcher of watchers) watcher.close(); });
            this.watched = watched;
          } catch (error) { for (const watcher of watchers) watcher.close(); throw error; }
        }
      }
      this.changed.fire(); this.postState();
    } catch (error) {
      if (ticket !== this.ticket) return;
      this.error = '상태 확인 실패'; this.changed.fire();
      this.post({ type: 'error', code: 'GIT_STATUS_FAILED', message: (error as Error).message });
    }
  }
  private async save(planningRoot: string, reason: string, expected: string, native = true) {
    return this.run('save', async root => {
      this.requireFinishedDrafts();
      const validate = async () => {
        this.requireFinishedDrafts();
        if (root !== planningRoot || this.root() !== root || (await getGitStatus(root)).revision !== expected) {
          throw new VibeError('STALE_REVISION', '사유 입력 또는 문서 수집 중 파일이나 Git 상태가 바뀌었습니다. 다시 저장해 주세요.');
        }
      };
      await validate();
      const beforeStatus = await getGitStatus(root), fence = await gitFence(beforeStatus);
      await validate();
      const flushed = await this.flushDocuments?.(root, validate);
      try {
        let commitRevision = expected;
        if (flushed) {
          const status = await getGitStatus(root), after = await gitFence(status);
          const prefix = status.repository ? relative(status.repository, status.root).split(sep).filter(Boolean).join('/') : '';
          const own = new Set(flushed.changed.map(file => (prefix ? prefix + '/' : '') + file));
          const unrelated = (changes: string[]) => JSON.stringify(changes.filter(change => !own.has(change.slice(3))).sort());
          if (this.root() !== root || (await loadProject(root)).revision !== flushed.planned.revision ||
            fence.control !== after.control || unrelated(fence.changes) !== unrelated(after.changes)) {
            throw new VibeError('STALE_REVISION', '문서 반영 중 다른 파일이나 Git 상태가 바뀌었습니다.');
          }
          commitRevision = status.revision;
        }
        this.requireFinishedDrafts();
        if (this.root() !== root) throw new VibeError('PROJECT_CHANGED', '기획 폴더가 바뀌었습니다.');
        return await saveProject(root, reason, commitRevision);
      } catch (error) {
        if (flushed?.changed.length) throw new VibeError(error instanceof VibeError ? error.code : 'GIT_FAILED',
          '문서 파일에는 반영했지만 Git 커밋하지 못했습니다. 반영한 값은 유지됩니다. ' + (error as Error).message);
        throw error;
      }
    }, native);
  }

  private async run(action: string, operation: (root: string) => Promise<GitResult>, native = true) {
    const root = this.root();
    if (!root) throw new Error('먼저 기획 폴더를 선택해 주세요.');
    if (this.busy) throw new VibeError('OPERATION_RUNNING', '이전 작업이 끝난 뒤 다시 시도해 주세요.');
    this.busy = true; this.changed.fire();
    try {
      const result = await operation(root);
      if (this.root() === root) {
        await this.refreshProject(); this.status = result.status; this.postState(result);
        if (!result.completed && result.status.conflicts.length) await this.open();
      }
      if (native) void vscode.window.showInformationMessage(result.completed
        ? action === 'save' ? '변경 사유와 함께 저장했습니다.' : action === 'push' ? '올리기를 완료했습니다.' : '받아오기를 완료했습니다.'
        : '충돌한 행의 값을 선택해 주세요.');
      return result;
    } catch (error) {
      const prefix = action === 'push' ? '올리기에 실패했습니다. 로컬 저장 내용은 유지됩니다. ' : action === 'save' ? '저장하지 못했습니다. ' : '받아오기를 완료하지 못했습니다. ';
      const message = prefix + (error as Error).message;
      this.post({ type: 'error', action, code: error instanceof VibeError ? error.code : 'GIT_FAILED', message });
      if (native) void vscode.window.showErrorMessage(message);
      throw error;
    } finally { this.busy = false; await this.refresh(); }
  }
  async open() {
    const root = this.root(); if (!root) throw new Error('먼저 기획 폴더를 선택해 주세요.');
    if (this.panel && this.panelRoot === root) { this.panel.reveal(vscode.ViewColumn.One); this.postState(); return this.panel; }
    this.panelRoot = root;
    const panel = vscode.window.createWebviewPanel('vibe.git', '저장·올리기·받아오기', vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    });
    this.panel = panel;
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    panel.webview.onDidReceiveMessage(async (message: GitClientMessage) => {
      try {
        if (this.root() !== root) throw new Error('기획 폴더가 바뀌었습니다. 상태 창을 다시 열어 주세요.');
        if (message.type === 'ready' || message.type === 'gitRefresh') { await this.refresh(); this.postState(); }
        else if (message.type === 'gitSave') { if (message.reason.trim()) await this.save(root, message.reason, message.revision, false); }
        else if (message.type === 'gitPush') await this.run('push', pushProject, false);
        else if (message.type === 'gitPull') { this.requireFinishedDrafts(); this.requireNoDocumentDrafts(); await this.run('pull', pullProject, false); }
        else if (message.type === 'gitResolve') await this.run('resolve', root => resolveProject(root, message.revision, message.choices), false);
      } catch (error) { this.post({ type: 'error', code: error instanceof VibeError ? error.code : 'GIT_FAILED', message: (error as Error).message }); }
    });
    panel.webview.html = webviewHtml(this.context, panel, 'git');
    return panel;
  }
  dispose() { clearTimeout(this.timer); this.watcher?.dispose(); this.panel?.dispose(); this.changed.dispose(); for (const item of this.disposables) item.dispose(); }
}
