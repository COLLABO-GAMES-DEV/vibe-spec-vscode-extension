import * as vscode from 'vscode';
import { applyImport, inspectImport, loadProject, planImport, schemaDiagnostics, validateProject, VibeError } from '@vibe-spec/core';
import type { ImportInspection, ImportPlan, TableSchema } from '@vibe-spec/core';
import type { ImportClientMessage, ImportHostMessage } from '../../webview/src/importProtocol.js';
import { webviewHtml } from './webview.js';

export async function openImport(context: vscode.ExtensionContext, getRoot: () => string | undefined, refresh: () => Promise<void>, uri?: vscode.Uri) {
  const root = getRoot();
  if (!root) throw new Error('먼저 기획 폴더를 선택해 주세요.');
  const choose = async () => (await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false,
    filters: { '스프레드시트': ['csv', 'tsv', 'xlsx'] }, openLabel: '불러올 파일 선택' }))?.[0];
  const source = uri ?? await choose();
  if (!source) return;
  if (source.scheme !== 'file') throw new Error('로컬 파일을 선택해 주세요.');
  let inspection: ImportInspection = await inspectImport(source.fsPath);
  let plan: ImportPlan | undefined;
  const panel = vscode.window.createWebviewPanel('vibe.import', '불러오기', vscode.ViewColumn.One, {
    enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
  });
  const post = (message: ImportHostMessage) => { void panel.webview.postMessage(message); };
  async function state(applied = false, changed?: string[]) {
    const project = await loadProject(root!);
    const schemas = Object.fromEntries([...project.files].filter(([path, file]) => path.startsWith('schemas/') && !schemaDiagnostics(file).length)
      .map(([path, file]) => [path.slice(8, -5), file.data as TableSchema]));
    post({ type: 'importState', revision: project.revision, schemas, inspection, diagnostics: validateProject(project), ...(plan ? { plan } : {}),
      ...(applied ? { applied, changed: changed ?? [] } : {}) });
  }
  panel.webview.onDidReceiveMessage(async (message: ImportClientMessage) => {
    try {
      if (getRoot() !== root) throw new VibeError('PROJECT_CHANGED', '선택한 기획 폴더가 바뀌었습니다. 불러오기 창을 다시 열어 주세요.');
      if (message.type === 'importPick') {
        const selected = await choose();
        if (!selected) { await state(); return; }
        inspection = await inspectImport(selected.fsPath); plan = undefined;
      }
      if (message.type === 'importPlan') {
        inspection = await inspectImport(inspection.file);
        plan = planImport(await loadProject(root), inspection, message.mapping);
      }
      if (message.type === 'importApply') {
        if (!plan) throw new VibeError('IMPORT_PLAN', '먼저 미리보기를 확인해 주세요.');
        const result = await applyImport(root, message.revision, plan);
        plan = undefined; await refresh(); await state(true, result.changed); return;
      }
      await state();
    } catch (error) { post({ type: 'error', code: error instanceof VibeError ? error.code : 'IMPORT_FAILED', message: (error as Error).message }); }
  });
  panel.webview.html = webviewHtml(context, panel, 'import');
  return panel;
}
