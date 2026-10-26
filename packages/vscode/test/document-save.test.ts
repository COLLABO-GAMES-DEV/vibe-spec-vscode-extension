import { replaceTestFile } from './replaceTestFile.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs, { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createPlan, writeVariant, getPlan, approvePlan, getGitStatus, loadProject, type DocumentSnapshotBlock, type DocumentView, type Project } from '@vibe-spec/core';
import type { DocumentsClientMessage, DocumentsHostMessage, DocumentsState } from '../../webview/src/documentsProtocol.js';
const exec = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await exec('git', ['-C', root, ...args])).stdout.trim();
interface Api {
  getProject(): Project | undefined;
  refresh(): Promise<void>;
  documents: { flushTimeout: number; assets(project: Project, view: DocumentView | undefined, panel: vscode.WebviewPanel): Promise<Record<string, string>> };
  git: { getChildren(): vscode.TreeItem[]; draft(key: string, active: boolean): void };
}
async function eventually(check: () => boolean | Promise<boolean>, message = 'Native document bridge did not respond') {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(message);
}

// The actual Webview transport is used. Its small test client represents an editor
// with an independently held draft and responds only when the host asks to flush.
function bridge(panel: vscode.WebviewPanel) {
  const messages: DocumentsHostMessage[] = [];
  let draft: { name: string; revision: string; dirty: boolean; target?: string; blocks: DocumentSnapshotBlock[] } | undefined;
  let onFlush: (() => void | Promise<void>) | undefined;
  let respond = true;
  const listener = panel.webview.onDidReceiveMessage(async message => {
    if (message?.type !== 'saveNativeObserved') return;
    const value = message.message as DocumentsHostMessage;
    messages.push(value);
    if (value.type === 'documentsState' && !draft) baseline(value);
    if (value.type === 'documentFlush') {
      await onFlush?.();
      if (respond && draft) await send({ type: 'documentSnapshot', requestId: value.requestId, ...draft });
    }
    if (value.type === 'documentFlushResult' && value.ok && value.state) baseline(value.state);
  });
  function baseline(state: DocumentsState) {
    if (state.view) draft = { name: state.view.name, revision: state.revision, dirty: false, ...('target' in state.view ? { target: state.view.target } : {}),
      blocks: state.view.blocks.map(block => ({ original: block.index })) };
  }
  const send = (message: DocumentsClientMessage) => panel.webview.postMessage({ type: 'saveNativeSend', message });
  panel.webview.html = `<!doctype html><html><body><script>
    const host = acquireVsCodeApi();
    addEventListener('message', event => {
      if (event.data.type === 'saveNativeSend') host.postMessage(event.data.message);
      else host.postMessage({ type: 'saveNativeObserved', message: event.data });
    });
    host.postMessage({ type: 'ready' });
  </script></body></html>`;
  return { panel, messages, send, get draft() { return draft!; },
    edit(markdown: string, revision?: string) {
      draft = { ...draft!, dirty: true, ...(revision ? { revision } : {}), blocks: [{ original: 0 }, { original: 1, markdown }, { original: 2 }] };
    },
    setFlush(action: () => void | Promise<void>) { onFlush = action; },
    stopResponding() { respond = false; },
    dispose() { listener.dispose(); panel.dispose(); },
  };
}

suite('native whole-document save with reason', function () {
  this.timeout(30_000);
  let api: Api, sandbox: string, workspace: string, root: string, sequence = 0;
  const pages: ReturnType<typeof bridge>[] = [];
  const source = '\uFEFF# 제목\r\n\r\n원문  \r\n\r\n<aside>보존</aside>';
  suiteSetup(async () => {
    workspace = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    sandbox = await mkdtemp(join(workspace, 'whole-doc-save-'));
    api = await vscode.extensions.getExtension<Api>('ijun17.vibe-spec')!.activate();
  });
  setup(async () => {
    root = join(sandbox, String(++sequence));
    await cp(join(process.env.VIBE_REPO_ROOT!, 'packages/core/test/fixtures/project'), root, { recursive: true });
    await mkdir(join(root, 'documents'), { recursive: true });
    for (const name of ['첫 문서', '둘 문서']) await writeFile(join(root, 'documents', name + '.md'), source);
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.name', 'Native Test');
    await git(root, 'config', 'user.email', 'native@example.invalid');
    await git(root, 'config', 'commit.gpgsign', 'false');
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'baseline');
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(root));
    await api.refresh();
  });
  teardown(async () => {
    for (const page of pages.splice(0)) page.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  suiteTeardown(async () => {
    await rm(join(workspace, '.vibe-spec.json'), { force: true });
    await eventually(() => api.getProject() === undefined);
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3 });
  });
  async function open(name = '첫 문서') {
    const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('vibe.openDocument', name);
    assert.ok(panel); const page = bridge(panel); pages.push(page);
    await eventually(() => Boolean(page.draft)); return page;
  }
  const bytes = (name = '첫 문서') => readFile(join(root, 'documents', name + '.md'));
  async function result(page: ReturnType<typeof bridge>, ok: boolean) {
    await eventually(() => page.messages.some(message => message.type === 'documentFlushResult' && message.ok === ok));
  }

  test('alternative document save uses the real host, leaves baseline bytes and shows external base changes', async () => {
    let p = await loadProject(root);
    p = (await createPlan(root, p.revision, 'doc-review', { title: 'Document review', status: 'review' })).project;
    p = (await writeVariant(root, p.revision, 'doc-review', 'A', { documents: { '첫 문서/제목': source.slice(1) } })).project;
    await api.refresh();
    const page = await open();
    await page.send({ type: 'documentTarget', target: 'doc-review/A' });
    await eventually(() => page.messages.some(m => m.type === 'documentsState' && m.view && 'target' in m.view && m.view.target === 'doc-review/A'));
    const state = [...page.messages].reverse().find(m => m.type === 'documentsState' && m.view && 'target' in m.view && m.view.target === 'doc-review/A') as DocumentsState;
    // The transport client holds its draft separately, just like the React editor.
    Object.assign(page.draft, { revision: state.revision, target: 'doc-review/A' });
    page.edit('대안 본문');
    await page.send({ type: 'documentSaveRequest', reason: '문서 대안만 저장' });
    await result(page, true);
    assert.deepEqual(await bytes(), Buffer.from(source));
    p = await loadProject(root); assert.match(getPlan(p, 'doc-review').variants.A!.documents!['첫 문서/제목']!, /대안 본문/);
    const replacement = join(root, 'external-document.tmp');
    await writeFile(replacement, source.replace('원문', '외부 수정'));
    await replaceTestFile(replacement, join(root, 'documents', '첫 문서.md'));
    await api.refresh();
    await eventually(() => page.messages.some(m => m.type === 'documentsState' && m.view?.diagnostics.some(d => d.code === 'BASE_CHANGED')));
    p = await loadProject(root); await approvePlan(root, p.revision, 'doc-review', 'A');
    assert.deepEqual(await bytes(), Buffer.from(source.replace('원문  ', '대안 본문')));
  });

  test('save request queries every frame even before dirty signals, batches two documents and commits the reason', async () => {
    const first = await open(), second = await open('둘 문서');
    first.edit('첫 변경'); second.edit('둘 변경');
    assert.deepEqual(await bytes(), Buffer.from(source));
    await first.send({ type: 'documentSaveRequest', reason: '두 문서 변경 이유' });
    await result(first, true); await result(second, true);
    await eventually(async () => (await git(root, 'log', '-1', '--format=%s')) === '두 문서 변경 이유');
    assert.match((await bytes()).toString(), /첫 변경/);
    assert.match((await bytes('둘 문서')).toString(), /둘 변경/);
    assert.ok((await bytes()).toString().startsWith('\uFEFF# 제목\r\n\r\n'));
    await eventually(async () => (await git(root, 'status', '--porcelain')) === '', 'Git save did not release its lock or clean the worktree');
    assert.equal(first.draft.dirty, false); assert.equal(second.draft.dirty, false);
  });

  test('no-op save keeps bytes and HEAD; a clean stale second frame does not block a dirty current frame', async () => {
    const first = await open(), second = await open('둘 문서');
    const head = await git(root, 'rev-parse', 'HEAD');
    await vscode.commands.executeCommand('vibe.save', '변경 없음');
    assert.equal(await git(root, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(await bytes(), Buffer.from(source));
    await writeFile(join(root, 'documents', '외부.md'), '# 추가'); await api.refresh();
    first.edit('현재 기준 수정', (await loadProject(root)).revision);
    assert.notEqual(second.draft.revision, first.draft.revision);
    await vscode.commands.executeCommand('vibe.save', 'clean frame revision 무시');
    assert.match((await bytes()).toString(), /현재 기준 수정/);
  });

  test('blank reason does not query or write; table drafts still reject before document flushing', async () => {
    const page = await open(); page.edit('초안');
    await vscode.commands.executeCommand('vibe.save', '   ');
    assert.equal(page.messages.filter(message => message.type === 'documentFlush').length, 0);
    assert.deepEqual(await bytes(), Buffer.from(source));
    api.git.draft('table-test', true);
    try { await assert.rejects(Promise.resolve(vscode.commands.executeCommand('vibe.save', '차단')), /확정|취소/); }
    finally { api.git.draft('table-test', false); }
    assert.equal(page.messages.filter(message => message.type === 'documentFlush').length, 0);
  });

  test('cancelled reason leaves drafts untouched and external changes during reason collection reject', async () => {
    const page = await open(); page.edit('초안');
    // Only the native input response is controlled; commands, file writes and
    // Webview communication exercise the real extension host.
    const original = vscode.window.showInputBox;
    let answer: ((value: string | undefined) => void) | undefined;
    vscode.window.showInputBox = () => new Promise(resolve => { answer = resolve; });
    try {
      const cancelled = Promise.resolve(vscode.commands.executeCommand('vibe.save'));
      await eventually(() => Boolean(answer)); answer!(undefined); await cancelled;
      assert.equal(page.messages.filter(message => message.type === 'documentFlush').length, 0);
      answer = undefined;
      const saving = Promise.resolve(vscode.commands.executeCommand('vibe.save')).then(() => undefined, error => error as Error);
      await eventually(() => Boolean(answer));
      await writeFile(join(root, 'documents', '외부.md'), '# 외부');
      answer!('사유'); assert.match((await saving)!.message, /바뀌었습니다/);
      assert.deepEqual(await bytes(), Buffer.from(source));
      assert.equal(page.messages.filter(message => message.type === 'documentFlush').length, 0);
    } finally { vscode.window.showInputBox = original; }
  });

  test('a stale dirty document rejects all writes and unlocks every frame', async () => {
    const first = await open(), second = await open('둘 문서');
    second.edit('stale');
    await writeFile(join(root, 'documents', '외부.md'), '# 외부'); await api.refresh();
    first.edit('current', (await loadProject(root)).revision);
    await assert.rejects(Promise.resolve(vscode.commands.executeCommand('vibe.save', 'stale 차단')), /바뀌었습니다/);
    await result(first, false); await result(second, false);
    assert.deepEqual(await bytes(), Buffer.from(source)); assert.deepEqual(await bytes('둘 문서'), Buffer.from(source));
    assert.equal(first.draft.dirty, true); assert.equal(second.draft.dirty, true);
  });

  test('external writes during collection reject before flush; wrong request IDs cannot supply a snapshot', async () => {
    const page = await open(); page.edit('초안');
    page.setFlush(async () => {
      await page.send({ type: 'documentSnapshot', requestId: 'wrong-id', ...page.draft });
      await writeFile(join(root, 'documents', '외부.md'), '# 경합');
    });
    await assert.rejects(Promise.resolve(vscode.commands.executeCommand('vibe.save', '경합')), /바뀌었습니다/);
    await result(page, false); assert.deepEqual(await bytes(), Buffer.from(source));
  });

  test('missing save protocol and closing a frame both reject without committing', async () => {
    const page = await open(); page.stopResponding();
    const head = await git(root, 'rev-parse', 'HEAD'), timeout = api.documents.flushTimeout;
    api.documents.flushTimeout = 100;
    try { await assert.rejects(Promise.resolve(vscode.commands.executeCommand('vibe.save', 'missing protocol')), /응답하지/); }
    finally { api.documents.flushTimeout = timeout; }
    await result(page, false); assert.equal(await git(root, 'rev-parse', 'HEAD'), head);
    page.setFlush(() => { page.panel.dispose(); });
    await assert.rejects(Promise.resolve(vscode.commands.executeCommand('vibe.save', 'closed')), /닫혔습니다/);
    assert.equal(await git(root, 'rev-parse', 'HEAD'), head);
  });

  test('a mismatched document name rejects the snapshot and keeps draft bytes', async () => {
    const page = await open(); page.edit('잘못된 응답'); page.stopResponding();
    page.setFlush(async () => {
      const request = [...page.messages].reverse().find(message => message.type === 'documentFlush') as Extract<DocumentsHostMessage, { type: 'documentFlush' }>;
      await page.send({ type: 'documentSnapshot', requestId: request.requestId, ...page.draft, name: '둘 문서' });
    });
    await assert.rejects(Promise.resolve(vscode.commands.executeCommand('vibe.save', 'name 검사')), /저장 응답/);
    await result(page, false); assert.deepEqual(await bytes(), Buffer.from(source));
  });

  for (const race of ['file', 'index'] as const) test(`external ${race} change after our file flush is never accepted as the commit revision`, async () => {
    const page = await open(); page.edit('내 파일 반영');
    const assets = api.documents.assets;
    let injected = false;
    api.documents.assets = async function (project, view, panel) {
      if (!injected && panel === page.panel && view?.source.includes('내 파일 반영')) {
        injected = true;
        if (race === 'file') await writeFile(join(root, 'documents', '외부.md'), '# 반영 중 경합');
        else await git(root, 'add', 'documents/첫 문서.md');
      }
      return assets.call(this, project, view, panel);
    };
    try {
      await assert.rejects(Promise.resolve(vscode.commands.executeCommand('vibe.save', '경합 차단')), /파일에는 반영.*커밋하지 못/);
      assert.equal(injected, true); await result(page, true);
      assert.match((await bytes()).toString(), /내 파일 반영/);
      assert.equal(await git(root, 'log', '-1', '--format=%s'), 'baseline');
    } finally { api.documents.assets = assets; }
  });

  test('the existing Git webview reason action flushes documents before committing', async () => {
    const page = await open(); page.edit('Git 화면 저장');
    const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('vibe.git');
    assert.ok(panel); const gitPage = bridge(panel); pages.push(gitPage);
    await panel.webview.postMessage({ type: 'saveNativeSend', message: { type: 'gitSave',
      reason: 'Git 화면의 사유', revision: (await getGitStatus(root)).revision } });
    await result(page, true);
    await eventually(async () => (await git(root, 'log', '-1', '--format=%s')) === 'Git 화면의 사유');
    assert.match((await bytes()).toString(), /Git 화면 저장/);
  });

  test('older watcher states finish before a successful snapshot rebaseline', async () => {
    const page = await open(); page.edit('순서 보존');
    const assets = api.documents.assets;
    let release!: () => void, waiting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    api.documents.assets = async function (project, view, panel) {
      if (panel === page.panel && !waiting) { waiting = true; await gate; }
      return assets.call(this, project, view, panel);
    };
    let saving: Promise<unknown> | undefined;
    try {
      await api.refresh(); await eventually(() => waiting);
      const mark = page.messages.length;
      saving = Promise.resolve(vscode.commands.executeCommand('vibe.save', '응답 순서'));
      await eventually(async () => (await bytes()).toString().includes('순서 보존'));
      release(); await saving;
      await result(page, true);
      const replies = page.messages.slice(mark);
      const savedAt = replies.findIndex(message => message.type === 'documentFlushResult' && message.ok);
      assert.ok(savedAt >= 0);
      assert.ok(replies.slice(savedAt + 1).every(message => message.type !== 'documentsState' || message.view?.source.includes('순서 보존')));
    } finally { release(); await saving; api.documents.assets = assets; }
  });

  test('commit failure rebaselines written files and reports that their values remain', async () => {
    const page = await open(); page.edit('커밋 실패 후 유지');
    await git(root, 'config', 'user.useConfigOnly', 'true');
    await git(root, 'config', 'user.name', '');
    await assert.rejects(Promise.resolve(vscode.commands.executeCommand('vibe.save', '커밋 실패')), /파일에는 반영.*커밋하지 못/);
    await result(page, true);
    assert.match((await bytes()).toString(), /커밋 실패 후 유지/);
    assert.equal(page.draft.dirty, false);
    assert.equal(await git(root, 'log', '-1', '--format=%s'), 'baseline');
  });

  test('own image revision permits saving; an external change before image upload cannot be hidden', async () => {
    const page = await open(); page.edit('이미지 초안');
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    await page.send({ type: 'documentImage', revision: page.draft.revision, name: 'image.png', data });
    await eventually(() => page.messages.some(message => message.type === 'documentImageAdded'));
    const added = page.messages.find(message => message.type === 'documentImageAdded') as Extract<DocumentsHostMessage, { type: 'documentImageAdded' }>;
    page.edit('![그림](' + added.path + ')', added.revision);
    await vscode.commands.executeCommand('vibe.save', '이미지 추가');
    assert.match((await bytes()).toString(), /!\[그림\]/);
    page.edit('남길 초안');
    await writeFile(join(root, 'documents', '외부.md'), '# 외부'); await api.refresh();
    const mark = page.messages.length;
    await page.send({ type: 'documentImage', revision: page.draft.revision, name: 'next.png', data });
    await eventually(() => page.messages.slice(mark).some(message => message.type === 'error'));
    assert.ok(!page.messages.slice(mark).some(message => message.type === 'documentImageAdded'));
    await assert.rejects(Promise.resolve(vscode.commands.executeCommand('vibe.save', 'stale image')), /바뀌었습니다/);
    assert.equal(page.draft.dirty, true);
  });

  test('an external write immediately after image installation cannot advance the draft revision', async () => {
    const page = await open(); page.edit('이미지 경합 초안');
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const rename = fs.rename;
    let injected = false;
    fs.rename = async (from, to) => {
      await rename(from, to);
      if (!injected && String(to).endsWith('.png')) {
        injected = true;
        await writeFile(join(root, 'documents', '외부.md'), '# image installation race');
      }
    };
    try {
      const mark = page.messages.length;
      await page.send({ type: 'documentImage', revision: page.draft.revision, name: 'race.png', data });
      await eventually(() => page.messages.slice(mark).some(message => message.type === 'error'));
      assert.equal(injected, true);
      assert.ok(!page.messages.slice(mark).some(message => message.type === 'documentImageAdded'));
      assert.deepEqual(await bytes(), Buffer.from(source));
      assert.equal(page.draft.dirty, true);
    } finally { fs.rename = rename; }
  });

  test('document drafts mark Git editing and survive a project switch in their own panel', async () => {
    const page = await open(); page.edit('프로젝트 전환 후 보존');
    await page.send({ type: 'documentDraft', dirty: true });
    await eventually(() => api.git.getChildren()[0]?.label === '편집 중');
    let closed = false; page.panel.onDidDispose(() => { closed = true; });
    const other = join(sandbox, 'other');
    await cp(root, other, { recursive: true });
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(other));
    await api.refresh(); assert.equal(closed, false);
    assert.equal(page.draft.dirty, true);
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(root));
    assert.equal(await vscode.commands.executeCommand('vibe.openDocument', '첫 문서'), page.panel);
    assert.equal(api.git.getChildren()[0]?.label, '편집 중');
    await vscode.commands.executeCommand('vibe.save', '돌아와서 저장');
    assert.match((await bytes()).toString(), /프로젝트 전환 후 보존/);
  });
});
