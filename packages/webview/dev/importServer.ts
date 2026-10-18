import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { applyImport, inspectImport, loadProject, planImport, schemaDiagnostics, validateProject, VibeError } from '@vibe-spec/core';
import type { ImportInspection, ImportMapping, ImportPlan, TableSchema } from '@vibe-spec/core';
import type { ImportHostMessage } from '../src/importProtocol.js';

export function createImportServer(getRoot: () => string) {
  const sessions = new Map<string, { inspection?: ImportInspection; plan?: ImportPlan }>();
  return { reset() { sessions.clear(); }, async handle(body: Record<string, unknown>): Promise<ImportHostMessage> {
    const root = getRoot(), client = String(body.client);
    let state = sessions.get(client);
    if (!state) { state = {}; sessions.set(client, state); }
    let project = await loadProject(root), changed: string[] | undefined;
    if (body.type === 'upload') {
      const extension = extname(String(body.name)).toLowerCase();
      if (!['.csv', '.tsv', '.xlsx'].includes(extension)) throw new VibeError('IMPORT_FORMAT', 'Choose CSV, TSV, or XLSX.');
      const file = join(root, basename(String(body.name)));
      await writeFile(file, Buffer.from(String(body.content), 'base64'));
      state.inspection = await inspectImport(file); delete state.plan;
    }
    if (body.type === 'importPlan') {
      if (!state.inspection) throw new VibeError('IMPORT_SOURCE', 'Choose a file first.');
      state.inspection = await inspectImport(state.inspection.file);
      state.plan = planImport(project, state.inspection, body.mapping as ImportMapping);
    }
    if (body.type === 'importApply') {
      if (!state.plan) throw new VibeError('IMPORT_PLAN', 'Preview before applying.');
      const result = await applyImport(root, String(body.revision), state.plan);
      project = result.project; changed = result.changed; delete state.plan;
    }
    const schemas = Object.fromEntries([...project.files].filter(([path, file]) => path.startsWith('schemas/') && !schemaDiagnostics(file).length)
      .map(([path, file]) => [path.slice(8, -5), file.data as TableSchema]));
    return { type: 'importState', revision: project.revision, schemas, diagnostics: validateProject(project), ...state, ...(changed ? { applied: true, changed } : {}) };
  } };
}
