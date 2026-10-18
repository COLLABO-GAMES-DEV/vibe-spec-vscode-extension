import { replaceTestFile } from './replaceTestFile.js';
import assert from 'node:assert/strict';
import fs, { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { getDocumentView, loadProject, type Project, type Usages, type WriteResult } from '@vibe-spec/core';
import type { DocumentsClientMessage, DocumentsHostMessage } from '../../webview/src/documentsProtocol.js';

interface ExtensionApi {
  planning: vscode.TreeDataProvider<vscode.TreeItem>;
  documents: { getChildren(): vscode.TreeItem[] };
  getProject(): Project | undefined;
  refresh(): Promise<void>;
  onDidRefresh: vscode.Event<void>;
}
type State = Extract<DocumentsHostMessage, { type: 'documentsState' }>;
function label(item: vscode.TreeItem) { return typeof item.label === 'string' ? item.label : item.label?.label; }
async function items(api: ExtensionApi) { return ((await api.planning.getChildren()) ?? []).filter(item => item.contextValue === 'vibe-document'); }
async function eventually(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

// A small page exercises VS Code's real Webview message transport. React/BlockNote
// interaction belongs to browser E2E; neither the controller nor core is mocked.
function bridge(panel: vscode.WebviewPanel) {
  const messages: DocumentsHostMessage[] = [];
  const listeners = new Set<() => void>();
  const subscription = panel.webview.onDidReceiveMessage(message => {
    if (message?.type !== 'documentsNativeObservation') return;
    messages.push(message.message as DocumentsHostMessage);
    for (const notify of listeners) notify();
  });
  const next = <T extends DocumentsHostMessage>(predicate: (message: DocumentsHostMessage) => message is T, after = 0) =>
    new Promise<T>((resolve, reject) => {
      const finish = () => {
        const found = messages.slice(after).find(predicate);
        if (!found) return;
        clearTimeout(timer); listeners.delete(finish); resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(finish);
        reject(new Error('No matching native Webview reply for ' + panel.title + ' (' + predicate.toString() + '): ' + JSON.stringify(messages.slice(after))));
      }, 10_000);
      listeners.add(finish); finish();
    });
  panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-documents-native-test'"></head><body>
    <script nonce="documents-native-test">
      const host = acquireVsCodeApi();
      addEventListener('message', event => {
        if (event.data.type === 'documentsNativeRequest') host.postMessage(event.data.message);
        else host.postMessage({ type: 'documentsNativeObservation', message: event.data });
      });
      host.postMessage({ type: 'ready' });
    </script></body></html>`;
  return { messages, mark: () => messages.length, next,
    state: (predicate: (state: State) => boolean = () => true, after = 0) => next((message): message is State => message.type === 'documentsState' && predicate(message), after),
    send: (message: DocumentsClientMessage) => panel.webview.postMessage({ type: 'documentsNativeRequest', message }),
    dispose: () => subscription.dispose() };
}

suite('vibe-spec documents in native VS Code', function () {
  this.timeout(30_000);
  let api: ExtensionApi, workspaceRoot: string, sandbox: string, fixture: string, projectRoot: string;
  let number = 0;
  const bridges: ReturnType<typeof bridge>[] = [];
  suiteSetup(async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace);
    workspaceRoot = workspace.uri.fsPath;
    assert.ok(process.env.VIBE_REPO_ROOT);
    fixture = join(process.env.VIBE_REPO_ROOT, 'packages/core/test/fixtures/project');
    sandbox = await mkdtemp(join(workspaceRoot, '문서 API 테스트-'));
    const extension = vscode.extensions.getExtension<ExtensionApi>('ijun17.vibe-spec');
    assert.ok(extension);
    api = await extension.activate();
    assert.ok(api.planning, 'The extension must expose its unified planning tree provider.');
  });
  setup(async () => {
    projectRoot = join(sandbox, '프로젝트 ' + ++number);
    await cp(fixture, projectRoot, { recursive: true });
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(projectRoot));
    assert.equal(api.getProject()?.root, projectRoot);
  });
  teardown(async () => {
    for (const page of bridges.splice(0)) page.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  suiteTeardown(async () => {
    if (workspaceRoot) await rm(join(workspaceRoot, '.vibe-spec.json'), { force: true });
    if (api) await eventually(() => api.getProject() === undefined, 'Document suite cleanup did not release its project.');
    if (sandbox) await rm(sandbox, { recursive: true, force: true, maxRetries: 3 });
  });
  async function externalDocument(name: string, source: string) {
    await mkdir(join(projectRoot, 'documents'), { recursive: true });
    await writeFile(join(projectRoot, 'documents', name + '.md'), source);
    await eventually(() => api.getProject()?.sources.get('documents/' + name + '.md') === source,
      'The document watcher did not load ' + name);
  }
  async function open(name: string) {
    const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('vibe.openDocument', name);
    assert.ok(panel);
    assert.match(panel.webview.html, /data-mode="documents"/);
    const page = bridge(panel); bridges.push(page);
    await page.state(state => state.view?.name === name);
    return { panel, page };
  }

  test('sidebar reports document errors and opens its command with scoped Webview resources', async () => {
    const source = '\uFEFF# 재화\r\n\r\n메모  \r\n\r\n끝';
    await externalDocument('경제 # %', source);
    await externalDocument('확인 필요', '# 잘못/제목\n\n[끊김](없는문서/제목)');
    const entries = await items(api);
    assert.deepEqual(entries.map(label).sort(), ['경제 # %', '확인 필요'].sort());
    const valid = entries.find(item => label(item) === '경제 # %')!;
    const invalid = entries.find(item => label(item) === '확인 필요')!;
    assert.equal(valid.contextValue, 'vibe-document');
    assert.equal(valid.description, '오류 0개');
    assert.equal(invalid.iconPath instanceof vscode.ThemeIcon && invalid.iconPath.id, 'markdown');
    assert.notEqual(invalid.description, '오류 0개');
    assert.equal(valid.command?.command, 'vibe.openDocument');
    assert.deepEqual(valid.command?.arguments, ['경제 # %']);
    const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>(valid.command!.command, ...valid.command!.arguments!);
    assert.match(panel.webview.html, /data-mode="documents"/);
    assert.match(panel.webview.html, /img-src/);
    const roots = panel.webview.options.localResourceRoots!;
    assert.equal(roots.length, 2);
    assert.ok(roots.some(uri => uri.fsPath === join(projectRoot, 'documents', 'assets')));
    assert.ok(roots.every(uri => uri.fsPath !== projectRoot && uri.fsPath !== join(projectRoot, 'documents')));
    panel.dispose();
    assert.deepEqual(await readFile(join(projectRoot, 'documents', '경제 # %.md')), Buffer.from(source));
  });

  test('registered create, rename and delete commands use frozen revisions and core name validation', async () => {
    const revision = api.getProject()!.revision;
    const result = await vscode.commands.executeCommand<WriteResult>('vibe.newDocument', { name: '새 문서', revision });
    assert.equal(await readFile(join(projectRoot, 'documents', '새 문서.md'), 'utf8'), '');
    assert.ok((await items(api)).some(item => label(item) === '새 문서'));
    await assert.rejects(async () => { await vscode.commands.executeCommand('vibe.newDocument', { name: '오래된 요청', revision }); });
    await assert.rejects(readFile(join(projectRoot, 'documents', '오래된 요청.md')), { code: 'ENOENT' });
    await assert.rejects(async () => { await vscode.commands.executeCommand('vibe.newDocument', { name: 'ITEMS', revision: result.project.revision }); });
    await assert.rejects(async () => { await vscode.commands.executeCommand('vibe.newDocument', { name: 'CON', revision: result.project.revision }); });
    const renamed = await vscode.commands.executeCommand<WriteResult>('vibe.renameDocument', {
      name: '새 문서', to: '바뀐 문서', revision: api.getProject()!.revision,
    });
    await assert.rejects(readFile(join(projectRoot, 'documents', '새 문서.md')), { code: 'ENOENT' });
    assert.ok((await items(api)).some(item => label(item) === '바뀐 문서'));
    await assert.rejects(async () => { await vscode.commands.executeCommand('vibe.deleteDocument', {
      name: '바뀐 문서', revision: renamed.project.revision, confirmed: false,
    }); });
    await vscode.commands.executeCommand('vibe.deleteDocument', { name: '바뀐 문서', revision: renamed.project.revision, confirmed: true });
    assert.deepEqual(await items(api), []);
    await assert.rejects(readFile(join(projectRoot, 'documents', '바뀐 문서.md')), { code: 'ENOENT' });
  });

  test('first directory creation, atomic edits, external deletion and recreation preserve the open panel draft', async () => {
    assert.deepEqual(await items(api), []);
    await externalDocument('관찰', '# 제목\n\n처음');
    const { panel, page } = await open('관찰');
    let disposed = false; panel.onDidDispose(() => { disposed = true; });
    const file = join(projectRoot, 'documents', '관찰.md');
    let after = page.mark();
    await writeFile(file + '.tmp', '# 제목\n\n원자 교체');
    await replaceTestFile(file + '.tmp', file);
    const changed = await page.state(state => state.view?.source === '# 제목\n\n원자 교체', after);
    assert.equal(changed.replace, false);
    after = page.mark();
    await writeFile(file, '# 제목\n\n교체 뒤 수정');
    assert.equal((await page.state(state => state.view?.source === '# 제목\n\n교체 뒤 수정', after)).replace, false);
    after = page.mark();
    await rm(join(projectRoot, 'documents'), { recursive: true });
    const deleted = await page.state(state => state.documents.length === 0, after);
    assert.equal(deleted.view, undefined); assert.equal(deleted.replace, false);
    assert.equal(disposed, false);
    assert.deepEqual(await items(api), []);
    after = page.mark();
    await externalDocument('관찰', '# 제목\n\n복원');
    assert.equal((await page.state(state => state.view?.source === '# 제목\n\n복원', after)).replace, false);
    assert.equal(await vscode.commands.executeCommand('vibe.openDocument', '관찰'), panel);
    after = page.mark();
    await writeFile(file, '# 제목\n\n복원 뒤 수정');
    await page.state(state => state.view?.source === '# 제목\n\n복원 뒤 수정', after);
  });

  test('Webview rejects stale and missing revisions, then edits only the explicitly reopened block', async () => {
    const original = '\uFEFF# 경제\r\n\r\n원래 메모  \r\n\r\n마지막';
    await externalDocument('경제', original);
    const { page } = await open('경제');
    const frozen = getDocumentView(api.getProject()!, '경제');
    const block = frozen.blocks.find(block => block.markdown.startsWith('원래 메모'))!;
    assert.ok(block);
    const external = original.replace('원래 메모', '다른 사람이 수정');
    await externalDocument('경제', external);
    let after = page.mark();
    await page.send({ type: 'documentEdit', name: '경제', revision: frozen.revision, operations: [{ op: 'replace', block: block.index, markdown: '내 초안' }] });
    const error = await page.next((message): message is Extract<DocumentsHostMessage, { type: 'error' }> => message.type === 'error' && message.code === 'STALE_REVISION', after);
    assert.ok(error.message);
    await page.state(state => state.view?.source === external && state.replace === false, after);
    assert.deepEqual(await readFile(join(projectRoot, 'documents', '경제.md')), Buffer.from(external));
    assert.ok(page.messages.slice(after).filter((message): message is State => message.type === 'documentsState').every(state => state.replace === false));
    after = page.mark();
    await page.send({ type: 'documentEdit', name: '경제', revision: '', operations: [] });
    await page.next((message): message is Extract<DocumentsHostMessage, { type: 'error' }> => message.type === 'error' && message.code === 'INVALID_EDIT', after);
    after = page.mark();
    await page.send({ type: 'documentOpen', name: '경제', path: '경제/경제' });
    const reopened = await page.state(state => state.view?.source === external && state.replace === false && state.focusPath === '경제/경제', after);
    assert.equal(reopened.focusPath, '경제/경제');
    after = page.mark();
    await page.send({ type: 'documentEdit', name: '경제', revision: reopened.revision, operations: [{ op: 'replace', block: block.index, markdown: '내 초안' }] });
    const saved = await page.state(state => state.view?.source === external.replace('다른 사람이 수정  ', '내 초안') && state.replace === true, after);
    assert.deepEqual(await readFile(join(projectRoot, 'documents', '경제.md')), Buffer.from(saved.view!.source));
    assert.ok(saved.view!.source.startsWith('\uFEFF# 경제\r\n\r\n'));
    assert.ok(saved.view!.source.endsWith('\r\n\r\n마지막'));
  });

  test('image upload returns its revision and exposes only project assets without resetting the draft', async () => {
    await externalDocument('그림', '# 그림\n\n![외부](https://example.invalid/image.png)\n\n![탈출](assets/../outside.png)');
    const { panel, page } = await open('그림');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE3sAAAAASUVORK5CYII=', 'base64');
    const before = api.getProject()!.revision;
    let after = page.mark();
    await page.send({ type: 'documentImage', name: '그림 # %.png', data: png.toString('base64'), revision: before });
    const added = await page.next((message): message is Extract<DocumentsHostMessage, { type: 'documentImageAdded' }> => message.type === 'documentImageAdded', after);
    assert.match(added.path, /^assets\/[^/]+\.png$/);
    assert.notEqual(added.revision, before);
    assert.deepEqual(await readFile(join(projectRoot, 'documents', added.path)), png);
    const state = await page.state(state => Boolean(state.assets[added.path]), after);
    assert.equal(state.replace, false);
    assert.equal(state.assets[added.path], panel.webview.asWebviewUri(vscode.Uri.file(await realpath(join(projectRoot, 'documents', added.path)))).toString());
    assert.equal(state.assets['https://example.invalid/image.png'], undefined);
    assert.equal(state.assets['assets/../outside.png'], undefined);
    after = page.mark();
    await page.send({ type: 'documentImage', name: 'bad.png', data: '%%%=', revision: added.revision });
    await page.next((message): message is Extract<DocumentsHostMessage, { type: 'error' }> => message.type === 'error' && message.code === 'INVALID_EDIT', after);
    assert.equal((await loadProject(projectRoot)).revision, added.revision);
    after = page.mark();
    const altered = Buffer.from(png); altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
    await writeFile(join(projectRoot, 'documents', added.path), altered);
    await page.state(state => state.revision !== added.revision && Boolean(state.assets[added.path]) && state.replace === false, after);
  });

  test('manifest contributes one planning tree with document usages and folder creation menus', () => {
    const manifest = vscode.extensions.getExtension('ijun17.vibe-spec')!.packageJSON;
    const views = manifest.contributes.views.vibe as { id: string; name: string }[];
    assert.deepEqual(views.filter(view => view.id === 'vibe.tables'), [{ id: 'vibe.tables', name: '기획' }]);
    assert.ok(!views.some(view => /document/i.test(view.id)));
    assert.ok(views.some(view => view.id === 'vibe.plans'));
    assert.ok(views.some(view => view.id === 'vibe.errors'));
    const menus = manifest.contributes.menus['view/item/context'] as { command: string; when: string }[];
    for (const command of ['vibe.newDocument', 'vibe.newTable']) assert.ok(menus.some(menu =>
      menu.command === command && menu.when === 'view == vibe.tables && viewItem == vibe-folder'));
    for (const command of ['vibe.renameDocument', 'vibe.deleteDocument', 'vibe.documentUsage']) assert.ok(menus.some(menu =>
      menu.command === command && menu.when === 'view == vibe.tables && viewItem == vibe-document'));
  });

  test('unified tree and public document provider sort numeric names naturally', async () => {
    for (const name of ['문서10', '문서2', '문서1']) await externalDocument(name, '# 제목');
    for (const folder of ['폴더10', '폴더2', '폴더1']) {
      await mkdir(join(projectRoot, 'documents', folder), { recursive: true });
      await writeFile(join(projectRoot, 'documents', folder, folder + '문서.md'), '# 제목');
    }
    await api.refresh();
    const children = (await api.planning.getChildren()) ?? [];
    assert.deepEqual(children.filter(item => item.contextValue === 'vibe-folder').map(label), ['폴더1', '폴더2', '폴더10']);
    assert.deepEqual(children.filter(item => item.contextValue === 'vibe-document').map(label), ['문서1', '문서2', '문서10']);
    assert.deepEqual(api.documents.getChildren().filter(item => String(label(item)).startsWith('문서')).map(label), ['문서1', '문서2', '문서10']);
  });

  test('two documents retain their own panels and receive only their own successful edit replies', async () => {
    await externalDocument('첫 문서', '# 첫 제목\n\n첫 원문');
    await externalDocument('둘 문서', '# 둘 제목\n\n둘 원문');
    const first = await open('첫 문서'), second = await open('둘 문서');
    assert.notEqual(first.panel, second.panel);
    const frozen = getDocumentView(api.getProject()!, '둘 문서');
    const firstMark = first.page.mark(), secondMark = second.page.mark();
    assert.equal(await vscode.commands.executeCommand('vibe.openDocument', '첫 문서'), first.panel);
    assert.equal((await first.page.state(state => state.view?.name === '첫 문서', firstMark)).replace, false);
    await first.page.send({ type: 'documentEdit', name: '첫 문서', revision: api.getProject()!.revision,
      operations: [{ op: 'replace', block: 1, markdown: '첫 수정' }] });
    const saved = await first.page.state(state => state.replace === true && state.view?.source.includes('첫 수정') === true, firstMark);
    const observed = await second.page.state(state => state.revision === saved.revision, secondMark);
    assert.equal(observed.view?.source, '# 둘 제목\n\n둘 원문');
    assert.equal(observed.replace, false);
    // The second editor's frozen draft revision must still be rejected after the first save.
    let after = second.page.mark();
    await second.page.send({ type: 'documentEdit', name: '둘 문서', revision: frozen.revision,
      operations: [{ op: 'replace', block: 1, markdown: '둘 초안' }] });
    await second.page.next((message): message is Extract<DocumentsHostMessage, { type: 'error' }> =>
      message.type === 'error' && message.code === 'STALE_REVISION', after);
    assert.ok(second.page.messages.slice(secondMark).filter((message): message is State => message.type === 'documentsState')
      .every(state => state.replace === false && state.view?.name === '둘 문서'));
    after = second.page.mark();
    await second.page.send({ type: 'documentEdit', name: '둘 문서', revision: api.getProject()!.revision,
      operations: [{ op: 'replace', block: 1, markdown: '둘 수정' }] });
    await second.page.state(state => state.replace === true && state.view?.source.includes('둘 수정') === true, after);
    assert.equal(await readFile(join(projectRoot, 'documents', '첫 문서.md'), 'utf8'), '# 첫 제목\n\n첫 수정');
    assert.equal(await readFile(join(projectRoot, 'documents', '둘 문서.md'), 'utf8'), '# 둘 제목\n\n둘 수정');
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview);
    assert.ok(tabs.some(tab => tab.label === '첫 문서') && tabs.some(tab => tab.label === '둘 문서'));
  });

  test('slow asset resolution preserves write reply ordering without blocking another document', async () => {
    await externalDocument('느린 문서', '# 제목\n\n처음');
    await externalDocument('독립 문서', '# 제목\n\n다른 원문');
    const first = await open('느린 문서'), other = await open('독립 문서');
    // Hold one real host asset lookup to reproduce the asynchronous watcher/write race.
    const host = api.documents as unknown as {
      assets(project: Project, view: ReturnType<typeof getDocumentView> | undefined, panel: vscode.WebviewPanel): Promise<Record<string, string>>;
    };
    const assets = host.assets;
    let release!: () => void, waiting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    host.assets = async function (project, view, panel) {
      if (panel === first.panel && !waiting) { waiting = true; await gate; }
      return assets.call(this, project, view, panel);
    };
    const firstMark = first.page.mark(), otherMark = other.page.mark();
    try {
      await first.page.send({ type: 'documentEdit', name: '느린 문서', revision: api.getProject()!.revision,
        operations: [{ op: 'replace', block: 1, markdown: '반영됨' }] });
      await eventually(() => waiting, 'The asset lookup was not reached.');
      await api.refresh();
      const independent = await other.page.state(state => state.revision === api.getProject()!.revision, otherMark);
      assert.equal(independent.replace, false);
      assert.equal(independent.view?.name, '독립 문서');
      release();
      const saved = await first.page.state(state => state.replace === true && state.view?.source.includes('반영됨') === true, firstMark);
      const afterSave = first.page.mark();
      await api.refresh();
      await first.page.state(state => state.revision === saved.revision && state.replace === false, afterSave);
      assert.equal(first.page.messages.slice(firstMark).filter(message => message.type === 'documentsState' && message.replace === true).length, 1);
    } finally { release(); host.assets = assets; }
  });

  test('rename rekeys its own panel, usage works from the tree, and delete leaves the other panel alive', async () => {
    await externalDocument('원래 이름', '# 제목\n\n원문');
    await externalDocument('다른 문서', '# 다른 제목\n\n[연결](원래%20이름/제목)');
    const target = await open('원래 이름'), other = await open('다른 문서');
    let targetDisposed = false, otherDisposed = false;
    target.panel.onDidDispose(() => { targetDisposed = true; });
    other.panel.onDidDispose(() => { otherDisposed = true; });
    const otherMark = other.page.mark();
    await vscode.commands.executeCommand('vibe.renameDocument', { name: '원래 이름', to: '새 이름', revision: api.getProject()!.revision });
    assert.equal(target.panel.title, '새 이름');
    assert.equal(await vscode.commands.executeCommand('vibe.openDocument', '새 이름'), target.panel);
    assert.equal(await vscode.commands.executeCommand('vibe.openDocument', '다른 문서'), other.panel);
    assert.equal(targetDisposed, false); assert.equal(otherDisposed, false);
    const usage = await vscode.commands.executeCommand<Usages>('vibe.documentUsage', (await items(api)).find(item => label(item) === '새 이름'));
    assert.ok(usage.references.some(reference => reference.file === 'documents/다른 문서.md'));
    let after = target.page.mark();
    await target.page.send({ type: 'documentRename', kind: 'document', path: '새 이름', to: '최종 이름', revision: api.getProject()!.revision });
    await target.page.state(state => state.replace === true && state.view?.name === '최종 이름', after);
    assert.equal(target.panel.title, '최종 이름');
    assert.equal(await vscode.commands.executeCommand('vibe.openDocument', '최종 이름'), target.panel);
    await target.page.send({ type: 'documentDelete', name: '최종 이름', revision: api.getProject()!.revision, confirmed: true });
    await eventually(() => targetDisposed, 'Deleting a document did not dispose its panel.');
    assert.equal(otherDisposed, false);
    assert.ok(other.page.messages.slice(otherMark).filter((message): message is State => message.type === 'documentsState')
      .every(state => state.replace === false && state.view?.name === '다른 문서'));
    assert.equal(await vscode.commands.executeCommand('vibe.openDocument', '다른 문서'), other.panel);
  });

  for (const route of ['tree', 'webview'] as const) test(`${route} rename rejects an externally deleted target with an open draft panel`, async () => {
    const source = '\uFEFF# 원문\r\n\r\n유지  \r\n';
    await externalDocument('출발 문서', source);
    await externalDocument('대상 문서', '# 대상\n\n저장 전 초안의 원본');
    const first = await open('출발 문서'), target = await open('대상 문서');
    let firstDisposed = false, targetDisposed = false;
    first.panel.onDidDispose(() => { firstDisposed = true; });
    target.panel.onDidDispose(() => { targetDisposed = true; });
    const targetMark = target.page.mark();
    await rm(join(projectRoot, 'documents', '대상 문서.md'));
    await target.page.state(state => !state.view, targetMark);
    const revision = api.getProject()!.revision;
    if (route === 'tree') {
      await assert.rejects(async () => {
        await vscode.commands.executeCommand('vibe.renameDocument', { name: '출발 문서', to: '대상 문서', revision });
      }, /초안.*닫/);
    } else {
      const after = first.page.mark();
      await first.page.send({ type: 'documentRename', kind: 'document', path: '출발 문서', to: '대상 문서', revision });
      const reply = await first.page.next((message): message is State | Extract<DocumentsHostMessage, { type: 'error' }> => message.type === 'error' ||
        (message.type === 'documentsState' && message.replace === true), after);
      assert.equal(reply.type, 'error', 'Rename must reject before overwriting the target panel session.');
      if (reply.type === 'error') assert.match(reply.message, /초안.*닫/);
    }
    assert.equal(firstDisposed, false); assert.equal(targetDisposed, false);
    assert.equal(first.panel.title, '출발 문서');
    assert.equal(target.panel.title, '대상 문서');
    assert.equal(api.getProject()!.revision, revision);
    assert.deepEqual(await readFile(join(projectRoot, 'documents', '출발 문서.md')), Buffer.from(source));
    await assert.rejects(readFile(join(projectRoot, 'documents', '대상 문서.md')), { code: 'ENOENT' });
    const after = target.page.mark();
    await target.page.send({ type: 'documentsRefresh' });
    await target.page.state(state => !state.view, after);
    assert.ok(target.page.messages.slice(targetMark).filter((message): message is State => message.type === 'documentsState')
      .every(state => state.replace === false && !state.view));
    // Only the user closing the target tab permits the rename; the source tab survives.
    target.panel.dispose();
    await vscode.commands.executeCommand('vibe.renameDocument', { name: '출발 문서', to: '대상 문서', revision });
    assert.equal(firstDisposed, false);
    assert.equal(await vscode.commands.executeCommand('vibe.openDocument', '대상 문서'), first.panel);
    assert.deepEqual(await readFile(join(projectRoot, 'documents', '대상 문서.md')), Buffer.from(source));
  });

  test('tree usage rejects a project switch during candidate I/O without opening the new project document', async () => {
    await externalDocument('공통 이름', '# 이전 프로젝트');
    const nextRoot = join(sandbox, '사용처 전환 프로젝트 ' + number);
    await cp(fixture, nextRoot, { recursive: true });
    await mkdir(join(nextRoot, 'documents'), { recursive: true });
    await writeFile(join(nextRoot, 'documents', '공통 이름.md'), '# 다음 프로젝트');
    // Only whereUsed reads this unmanaged note; loadProject does not read it.
    const note = join(projectRoot, 'usage-gate.txt');
    await writeFile(note, '공통 이름');
    const originalReadFile = fs.readFile;
    let release!: () => void, waiting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === note) { waiting = true; await gate; }
      return originalReadFile(...args);
    }) as typeof fs.readFile;
    const usage = Promise.resolve(vscode.commands.executeCommand('vibe.documentUsage', '공통 이름'))
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    const host = api.documents as unknown as { open(name?: string, path?: string): Promise<vscode.WebviewPanel | undefined> };
    const originalOpen = host.open;
    let opened = 0;
    host.open = function (...args) { opened++; return originalOpen.apply(this, args); };
    try {
      await eventually(() => waiting, 'whereUsed did not reach the candidate file read.');
      await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(nextRoot));
      assert.equal(api.getProject()?.root, nextRoot);
      release();
      const result = await usage;
      assert.ok(result.error, 'Usage from the previous project must reject after the switch.');
      assert.match(result.error.message, /기획 폴더가 바뀌었습니다/);
      assert.equal(opened, 0, 'The stale usage command must not call open in the new project.');
      assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
        tab.label === '공통 이름' && tab.input instanceof vscode.TabInputWebview)));
    } finally {
      release();
      await usage;
      fs.readFile = originalReadFile;
      host.open = originalOpen;
    }
  });

  test('project switch disposes every document panel and opens the same name in a fresh panel', async () => {
    await externalDocument('공통 이름', '# 이전 프로젝트');
    await externalDocument('추가 문서', '# 추가');
    const first = await open('공통 이름'), second = await open('추가 문서');
    let disposed = 0;
    first.panel.onDidDispose(() => { disposed++; }); second.panel.onDidDispose(() => { disposed++; });
    const nextRoot = join(sandbox, '전환 프로젝트 ' + number);
    await cp(fixture, nextRoot, { recursive: true });
    await mkdir(join(nextRoot, 'documents'), { recursive: true });
    await writeFile(join(nextRoot, 'documents', '공통 이름.md'), '# 다음 프로젝트');
    await vscode.commands.executeCommand('vibe.selectFolder', vscode.Uri.file(nextRoot));
    await eventually(() => disposed === 2, 'Project switch left document panels alive.');
    const next = await open('공통 이름');
    assert.notEqual(next.panel, first.panel);
    assert.equal((await next.page.state()).view?.source, '# 다음 프로젝트');
  });

  test('document links navigate to a section or table and where-used returns declared references', async () => {
    await externalDocument('출발', '# 출발\n\n[도착](도착/제목)\n\n[가격](offers/bundle/price)');
    await externalDocument('도착', '# 제목\n\n내용');
    const { panel, page } = await open('출발');
    let after = page.mark();
    await page.send({ type: 'documentUsage', path: '도착/제목' });
    const usage = await page.next((message): message is Extract<DocumentsHostMessage, { type: 'documentUsages' }> => message.type === 'documentUsages', after);
    assert.ok(usage.usages.references.some(reference => reference.file === 'documents/출발.md'));
    await page.send({ type: 'documentNavigate', path: '도착/제목' });
    await eventually(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === '도착' && tab.input instanceof vscode.TabInputWebview)),
      'A document link did not create its own destination panel.');
    const destination = await open('도착');
    after = destination.page.mark();
    await page.send({ type: 'documentNavigate', path: '도착/제목' });
    const arrival = await destination.page.state(state => state.view?.name === '도착' && state.focusPath === '도착/제목', after);
    assert.notEqual(destination.panel, panel);
    assert.ok(page.messages.filter((message): message is State => message.type === 'documentsState').every(state => state.view?.name === '출발'));
    assert.equal(arrival.replace, false);
    assert.equal(arrival.focusPath, '도착/제목');
    await page.send({ type: 'documentNavigate', path: 'offers/bundle/price' });
    await eventually(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'offers' && tab.input instanceof vscode.TabInputWebview)),
      'A document cell link did not open the table Webview.');
  });
});
