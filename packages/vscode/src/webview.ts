import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
export function webviewHtml(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, mode: 'table' | 'import' | 'git' | 'tables' | 'plans' | 'documents') {
  const assets = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
  const nonce = randomBytes(16).toString('hex');
  const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'app.js'));
  const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'app.css'));
  return `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} data:;"><link rel="stylesheet" href="${style}"></head><body data-mode="${mode}"><div id="root"></div><script nonce="${nonce}" type="module" src="${script}"></script></body></html>`;
}
