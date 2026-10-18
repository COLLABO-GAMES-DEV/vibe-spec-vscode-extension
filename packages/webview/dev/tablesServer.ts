import { applyStructureEdit, inspectStructure, loadProject, renameResource, tableSummaries, VibeError } from '@vibe-spec/core';
import type { StructurePreview } from '@vibe-spec/core';
import type { TablesHostMessage, TablesMode } from '../src/tablesProtocol.js';
export function createTablesServer(getRoot: () => string) {
  const sessions = new Map<string, { mode: TablesMode; selected?: string; preview?: StructurePreview }>();
  return { reset() { sessions.clear(); }, async handle(body: Record<string, unknown>): Promise<TablesHostMessage | { type: 'openTable'; table: string }> {
    const root = getRoot(), client = String(body.client);
    let current = sessions.get(client);
    if (!current) { current = { mode: 'list' }; sessions.set(client, current); }
    let project = await loadProject(root), notice: string | undefined;
    if (body.type === 'ready' || body.type === 'tableSelect') {
      if (['create', 'rename', 'delete', 'list'].includes(String(body.mode))) current.mode = body.mode as TablesMode;
      if (typeof body.table === 'string') current.selected = body.table;
      delete current.preview;
      if (current.mode === 'delete' && current.selected) current.preview = await inspectStructure(project, { op: 'table-delete', table: current.selected });
    }
    if (body.type === 'tablePreviewDelete') {
      current.selected = String(body.table); current.mode = 'delete';
      current.preview = await inspectStructure(project, { op: 'table-delete', table: current.selected });
    }
    if (body.type === 'tableCreate') {
      await applyStructureEdit(root, String(body.revision), { op: 'table-create', table: String(body.table), key: body.key as { code: string; label: string } });
      return { type: 'openTable', table: String(body.table) };
    }
    if (body.type === 'tableRename') {
      await renameResource(root, String(body.revision), 'table', String(body.table), String(body.to));
      return { type: 'openTable', table: String(body.to) };
    }
    if (body.type === 'tableOpen') return { type: 'openTable', table: String(body.table) };
    if (body.type === 'tableDelete') {
      if (!body.confirmed || !current.preview || current.preview.revision !== body.revision || current.preview.operation.table !== body.table) {
        throw new VibeError('CONFIRMATION_REQUIRED', 'Confirm the current deletion preview first.');
      }
      const result = await applyStructureEdit(root, String(body.revision), { op: 'table-delete', table: String(body.table) });
      project = result.project; current.mode = 'list'; delete current.selected; delete current.preview; notice = '테이블을 삭제했습니다.';
    }
    return { type: 'tablesState', revision: project.revision, tables: tableSummaries(project), ...current, ...(notice ? { notice } : {}) };
  } };
}
