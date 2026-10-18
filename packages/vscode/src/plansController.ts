import * as vscode from 'vscode';
import { approvePlan, getPlan, listPlans, loadProject, setPlanStatus, VibeError } from '@vibe-spec/core';
import type { Project } from '@vibe-spec/core';
import { planStatusLabels, type PlansClientMessage, type PlansHostMessage } from '../../webview/src/plansProtocol.js';
import { webviewHtml } from './webview.js';

export class PlansController implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly tree: vscode.TreeView<vscode.TreeItem>;
  private panel: vscode.WebviewPanel | undefined;
  private panelRoot: string | undefined;
  private selected: string | undefined;
  constructor(private readonly context: vscode.ExtensionContext,
    private readonly getProject: () => Project | undefined, private readonly refreshProject: () => Promise<void>) {
    this.tree = vscode.window.createTreeView('vibe.plans', { treeDataProvider: this });
  }
  getTreeItem(item: vscode.TreeItem) { return item; }
  getChildren(): vscode.TreeItem[] {
    const project = this.getProject();
    if (!project) return [];
    try { return listPlans(project).map(plan => {
      const item = new vscode.TreeItem(plan.title);
      item.contextValue = 'vibe-plan';
      item.description = planStatusLabels[plan.status] + (plan.selected ? ' · ' + plan.selected + '안 선택' : '');
      item.tooltip = `plans/${plan.name}/ · ${plan.name}`;
      item.iconPath = new vscode.ThemeIcon(plan.status === 'approved' ? 'archive' : 'git-compare');
      item.command = { command: 'vibe.openPlan', title: '기획 비교', arguments: [plan.name] };
      return item;
    }); } catch (error) {
      const item = new vscode.TreeItem('기획 파일을 확인해 주세요.');
      item.tooltip = (error as Error).message; item.iconPath = new vscode.ThemeIcon('error');
      return [item];
    }
  }
  private post(message: PlansHostMessage) { void this.panel?.webview.postMessage(message); }
  private state(project: Project, replace = false, notice?: string) {
    const plans = listPlans(project);
    this.post({ type: 'plansState', revision: project.revision, plans, replace,
      ...(this.selected ? { selected: this.selected } : {}),
      ...(plans.some(plan => plan.name === this.selected) ? { view: getPlan(project, this.selected!) } : {}),
      ...(notice ? { notice } : {}) });
  }
  refresh() {
    this.changed.fire();
    if (!this.panel) return;
    const project = this.getProject();
    if (!project || project.root !== this.panelRoot) { this.panel.dispose(); return; }
    try { this.state(project); }
    catch (error) { this.post({ type: 'error', code: error instanceof VibeError ? error.code : 'PLAN_FAILED', message: (error as Error).message }); }
  }
  async open(name?: string): Promise<vscode.WebviewPanel> {
    const current = this.getProject();
    if (!current) throw new Error('먼저 기획 폴더를 선택해 주세요.');
    const project = await loadProject(current.root);
    if (name !== undefined) getPlan(project, name);
    if (this.panel && this.panelRoot !== project.root) this.panel.dispose();
    this.selected = name;
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.One); this.state(project, true); return this.panel; }
    const root = project.root;
    const assets = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel('vibe.plan', '기획 비교', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assets] });
    this.panel = panel; this.panelRoot = root;
    panel.webview.html = webviewHtml(this.context, panel, 'plans');
    panel.onDidDispose(() => {
      if (this.panel === panel) { this.panel = undefined; this.panelRoot = undefined; this.selected = undefined; }
    });
    panel.webview.onDidReceiveMessage(async (message: PlansClientMessage) => {
      if (!message || typeof message !== 'object' || this.panel !== panel || this.getProject()?.root !== root) return;
      try {
        let project = await loadProject(root);
        if (message.type === 'planOpen') { getPlan(project, message.name); this.selected = message.name; }
        else if (message.type === 'planStatus' || message.type === 'planApprove') {
          if (message.name !== this.selected || typeof message.revision !== 'string') throw new VibeError('INVALID_EDIT', '열린 기획을 선택해 주세요.');
          if (message.type === 'planApprove' && message.confirmed !== true) throw new VibeError('INVALID_EDIT', '확정할 안을 확인해 주세요.');
          if (message.type === 'planStatus' && message.status !== 'draft' && message.status !== 'review') throw new VibeError('INVALID_EDIT', '기획 상태를 선택해 주세요.');
          const result = message.type === 'planStatus'
            ? await setPlanStatus(root, message.revision, message.name, message.status)
            : await approvePlan(root, message.revision, message.name, message.variant);
          project = result.project;
          await this.refreshProject();
        } else if (!['ready', 'plansRefresh', 'planReload'].includes(message.type)) return;
        if (this.panel !== panel || this.getProject()?.root !== root) return;
        this.state(project, message.type !== 'plansRefresh', message.type === 'planApprove' ? '기준안에 반영하고 변경분을 보관했습니다.' : undefined);
      } catch (error) {
        if (this.panel !== panel) return;
        this.post({ type: 'error', code: error instanceof VibeError ? error.code : 'PLAN_FAILED', message: (error as Error).message });
        await this.refreshProject();
      }
    });
    return panel;
  }
  dispose() { this.panel?.dispose(); this.tree.dispose(); this.changed.dispose(); }
}
