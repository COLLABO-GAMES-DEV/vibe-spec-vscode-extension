import { createDocumentsServer } from './documentsServer.js';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyEdits, assertCompleteCellInputs, getTableView, loadProject, renameResource, VibeError,
  resolveReference, ScreenHistory, whereUsed,
  inspectStructure, applyStructureEdit, deletionUsages, applyFolderEdit, createDocument, addDocumentImage, resourceEntries,
} from '@vibe-spec/core';
import type { EditOperation, StructureOperation, Usages } from '@vibe-spec/core';
import type { Plugin } from 'vite';
import { createImportServer } from './importServer.js';
import { createGitServer } from './gitServer.js';
import { createTablesServer } from './tablesServer.js';
import { createPlansServer } from './plansServer.js';

export function fakeHostServer(): Plugin {
  let root: string;
  const imports = createImportServer(() => root);
  const git = createGitServer(() => root);
  const tableEditor = createTablesServer(() => root);
  const plans = createPlansServer(() => root);
  const documents = createDocumentsServer(() => root);
  const histories = new Map<string, ScreenHistory>();
  const usageResults = new Map<string, Usages>();
  const fixture = fileURLToPath(new URL('../../core/test/fixtures/project/', import.meta.url));
  async function reset() {
    histories.clear(); usageResults.clear(); imports.reset(); tableEditor.reset(); plans.reset(); documents.reset(); await git.reset();
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
    root = await mkdtemp(join(tmpdir(), 'vibe browser 한글-'));
    await cp(fixture, root, { recursive: true });
    const items = join(root, 'tables/items.yaml');
    const extra = Array.from({ length: 5000 }, (_, i) =>
      '  - code: "demo_' + String(i).padStart(4, '0') + '"\n    name: "아이템 ' + i + '"\n    kind: "consumable"\n    note: ""\n').join('');
    await writeFile(items, await readFile(items, 'utf8') + extra);
  }
  return {
    name: 'vibe-fake-host', apply: 'serve',
    async configureServer(server) {
      await reset();
      // Large-fixture edits can outlast Node's default idle keep-alive window.
      if (server.httpServer && 'keepAliveTimeout' in server.httpServer) server.httpServer.keepAliveTimeout = 60_000;
      server.httpServer?.once('close', () => { void git.reset(); void rm(root, { recursive: true, force: true, maxRetries: 3 }); });
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/__vibe/')) return next();
        response.setHeader('Content-Type', 'application/json');
        let body: Record<string, unknown> = {};
        try {
          if (request.method === 'POST') {
            const chunks = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const source = Buffer.concat(chunks).toString('utf8');
            body = source ? JSON.parse(source) : {};
          }
          if (url.pathname === '/__vibe/domains/fixture') {
            await reset();
            let project = await loadProject(root);
            project = (await applyFolderEdit(root, project.revision, { op: 'folder-create', path: '경제/상점' })).project;
            for (const name of ['items', 'offers']) {
              project = (await applyFolderEdit(root, project.revision, { op: 'resource-move', kind: 'table', name, folder: '경제/상점' })).project;
            }
            const image = await addDocumentImage(root, project.revision, { name: 'domain.png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
            project = await loadProject(root);
            project = (await createDocument(root, project.revision, '상점 안내', '\uFEFF# 가격\r\n\r\n남길 문장 👋\r\n\r\n[가격](offers/bundle/price)\r\n\r\n[상세](<상점 상세/설명>)\r\n\r\n![상점 이미지](' + image.path + ')', { folder: '경제/상점' })).project;
            project = (await createDocument(root, project.revision, '상점 상세', '# 설명\n\n상세 본문', { folder: '경제/상점' })).project;
            response.end(JSON.stringify({ revision: project.revision, resources: resourceEntries(project) })); return;
          }
          if (url.pathname === '/__vibe/domains/inspect') {
            const project = await loadProject(root);
            response.end(JSON.stringify({ revision: project.revision, resources: resourceEntries(project),
              sources: Object.fromEntries(project.sources) })); return;
          }
          if (url.pathname === '/__vibe/tables') { response.end(JSON.stringify(await tableEditor.handle(body))); return; }
          if (url.pathname === '/__vibe/documents') { response.end(JSON.stringify(await documents.handle(body))); return; }
          if (url.pathname === '/__vibe/documents/fixture') { response.end(JSON.stringify(await documents.fixture(typeof body.source === 'string' ? body.source : undefined))); return; }
          if (url.pathname === '/__vibe/plans') { response.end(JSON.stringify(await plans.handle(body))); return; }
          if (url.pathname === '/__vibe/plans/fixture') { response.end(JSON.stringify(await plans.fixture())); return; }
          if (url.pathname === '/__vibe/git' || url.pathname === '/__vibe/git/fixture') {
            response.end(JSON.stringify(await git.handle(body, url.pathname.endsWith('/fixture')))); return;
          }
          if (url.pathname === '/__vibe/import') { response.end(JSON.stringify(await imports.handle(body))); return; }
          if (url.pathname === '/__vibe/reset') await reset();
          let project = await loadProject(root);
          const table = String(body.table ?? url.searchParams.get('table') ?? 'items');
          const client = String(body.client ?? url.searchParams.get('client') ?? 'inspection');
          const screen = client + '/' + table;
          let history = histories.get(screen);
          if (!history) { history = new ScreenHistory(); histories.set(screen, history); }
          const view = (name: string) => ({ type: 'snapshot', ...getTableView(project, name),
            history: histories.get(client + '/' + name)?.info() ?? { canUndo: false, canRedo: false } });
          if (url.pathname === '/__vibe/action') {
            if (body.type === 'structurePreview') {
              const preview = await inspectStructure(project, body.operation as StructureOperation);
              usageResults.set(screen, preview.usages);
              response.end(JSON.stringify({ type: 'structurePreview', preview })); return;
            }
            if (body.type === 'whereUsed') {
              const result = await whereUsed(project, table + '/' + String(body.key));
              usageResults.set(screen, result);
              response.end(JSON.stringify({ type: 'usages', key: body.key, result })); return;
            }
            let target;
            if (body.type === 'follow') {
              target = { ...resolveReference(project, table, String(body.key), String(body.column)), row: true };
            } else {
              const usage = usageResults.get(screen)?.[body.kind as keyof Usages]?.[Number(body.index)];
              if (!usage) throw new Error('Unknown usage result.');
              const [name, key, column] = usage.path.split('/');
              if (usage.file.startsWith('tables/') && name && key && column) target = { table: name, key, column };
              else { response.end(JSON.stringify({ type: 'notice', message: usage.file + ':' + usage.line })); return; }
            }
            response.end(JSON.stringify({ type: 'navigate', snapshot: view(target.table), focus: { type: 'focus', ...target } })); return;
          }
          if (url.pathname === '/__vibe/apply') {
            let result;
            if (body.type === 'undo' || body.type === 'redo') result = await history[body.type](root, String(body.revision));
            else if (body.type === 'structureEdit') {
              result = await applyStructureEdit(root, String(body.revision), body.operation as StructureOperation); history.recordStructure(result);
            } else if (body.type === 'columnRename') {
              result = await renameResource(root, String(body.revision), 'column', table + '/*/' + String(body.column), String(body.to)); history.recordStructure(result);
            } else if (body.type === 'rename') {
              result = await renameResource(root, String(body.revision), 'key', table + '/' + String(body.key), String(body.to));
              history.recordRename(result, table, String(body.key), String(body.to));
            } else {
              assertCompleteCellInputs(project, body.operations as EditOperation[]);
              result = await applyEdits(root, String(body.revision), body.operations as EditOperation[]);
              history.recordCells(result, body.operations as EditOperation[]);
            }
            project = result.project;
          } else if (url.pathname === '/__vibe/external') {
            project = (await applyEdits(root, project.revision, [{
              op: 'update', table, key: String(body.key), values: body.values as Record<string, string | boolean | null>,
            }])).project;
          }
          response.end(JSON.stringify({
            ...view(table),
            ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
          }));
        } catch (error) {
          let blocked;
          if (error instanceof VibeError && error.code === 'DELETE_RESTRICTED') {
            const project = await loadProject(root), table = String(body.table);
            blocked = await deletionUsages(project, error.diagnostics);
            usageResults.set(String(body.client) + '/' + table, blocked.result);
          }
          response.statusCode = 409;
          response.end(JSON.stringify({ type: 'error',
            code: error instanceof VibeError ? error.code : 'HOST_ERROR',
            message: (error as Error).message, requestId: body.requestId, ...(blocked ? { usages: blocked } : {}),
          }));
        }
      });
    },
  };
}
