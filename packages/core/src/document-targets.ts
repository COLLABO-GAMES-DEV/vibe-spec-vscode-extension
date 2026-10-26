import { pathParts, pathContains } from './paths.js';
import { isDeepStrictEqual } from 'node:util';
import { parseMarkdown } from './document-parser.js';
import type { DocumentOperation, DocumentSnapshot, DocumentView } from './document-types.js';
import type { MutationOptions, Project, WriteResult } from './types.js';
import { isRecord, VibeError } from './types.js';
import { getDocumentView, prepareDocumentSnapshots } from './documents.js';
import { composeDocumentSnapshot } from './document-snapshot.js';
import { documentScope, documentScopes, documentVariantChanges, type DocumentScope } from './document-variants.js';
import { getPlan, listPlans, prepareVariantWrite, readVariant } from './plans.js';
import type { VariantInput } from './plan-types.js';
import { mutateProject, projectWithChanges } from './project.js';

export interface TargetDocumentView extends DocumentView {
  target: string;
  scopes: DocumentScope[];
  selectedScopes: string[];
  persistedScopes: string[];
  targets: string[];
}
export interface TargetDocumentSnapshot extends DocumentSnapshot { target?: string; scopes?: string[] }
function targetParts(target: string): [string, string] {
  const parts = target.split('/');
  if (parts.length !== 2 || parts.some(x => !x)) throw new VibeError('TARGET_REQUIRED', 'Choose base or plan/variant.');
  return parts as [string, string];
}
export function getTargetDocumentView(project: Project, name: string, target = 'base', scopes?: string[]): TargetDocumentView {
  let selectedScopes: string[] = [], persistedScopes: string[] = [], composed = project;
  if (target !== 'base') {
    const [plan, variant] = targetParts(target);
    const input = getPlan(project, plan).variants[variant];
    composed = readVariant(project, plan, variant);
    persistedScopes = Object.keys(input?.documents ?? {}).filter(path => pathParts(path)[0] === name);
    selectedScopes = [...new Set([...persistedScopes, ...(scopes ?? [])])];
    // Validate even empty/unchanged selections against overlapping scopes.
    documentVariantChanges(composed, Object.fromEntries(selectedScopes.map(path => {
      if (pathParts(path)[0] !== name) throw new VibeError('DOCUMENT_SCOPE', 'Choose a scope in the open document.');
      return [path, documentScope(composed, path).markdown];
    })));
  }
  const view = getDocumentView(composed, name);
  if (target !== 'base') view.diagnostics.push(...getPlan(project, targetParts(target)[0]).diagnostics.filter(d => d.code === 'BASE_CHANGED' && pathContains(name, d.path) && d.file.endsWith('/' + targetParts(target)[1] + '.yaml')));
  let targets = ['base'];
  try { targets.push(...listPlans(project).filter(p => p.status !== 'approved').flatMap(p => p.variants.map(v => p.name + '/' + v))); } catch (error) { if (!(error instanceof VibeError)) throw error; }
  return { ...view, target, scopes: documentScopes(composed, name), selectedScopes, persistedScopes, targets };
}
function inputAt(project: Project, target: string): VariantInput {
  const [plan, variant] = targetParts(target), stored = getPlan(project, plan).variants[variant];
  if (!stored) throw new VibeError('PATH_NOT_FOUND', 'Unknown variant: ' + target);
  const { base_values: _base, base_missing: _missing, document_base_values: _documents, ...input } = stored;
  return input;
}
function assertScopedSnapshot(view: TargetDocumentView, blocks: DocumentSnapshot['blocks'], rebuilt: string, proposed: string): void {
  const selected = view.scopes.filter(scope => view.selectedScopes.includes(scope.path));
  const outside = view.blocks.filter(block => !selected.some(scope => (block.start >= scope.start || block.path === scope.path) && block.end <= scope.end));
  const originalOrder = outside.map(block => block.index);
  const presentOrder = blocks.filter(block => originalOrder.includes(block.original!)).map(block => block.original);
  if (!isDeepStrictEqual(originalOrder, presentOrder) || outside.some(original => {
    const block = blocks.find(b => b.original === original.index);
    return block?.markdown !== undefined && block.markdown !== original.markdown;
  })) throw new VibeError('DOCUMENT_SCOPE', 'A block outside the chosen scopes was changed, removed or moved.');
  if (rebuilt === proposed) return;
  // The whole-document snapshot inserts LF separators after new blocks. Scope
  // boundaries belong to the baseline, so retain their original CRLF/gap bytes.
  // Only gap differences are allowed: every parsed block and public path must agree.
  const structure = (source: string) => parseMarkdown(view.name, source).blocks.map(({ kind, markdown, path }) => ({ kind, markdown, path }));
  if (!isDeepStrictEqual(structure(rebuilt), structure(proposed))) throw new VibeError('DOCUMENT_SCOPE', 'Changes outside the selected document scopes are not allowed. Your draft is preserved.');
}
export async function saveTargetDocumentSnapshots(root: string, revision: string, snapshots: TargetDocumentSnapshot[], options: MutationOptions = {}): Promise<WriteResult> {
  return mutateProject(root, revision, before => {
    const changes = prepareDocumentSnapshots(before, snapshots.filter(s => !s.target || s.target === 'base').map(({ name, blocks }) => ({ name, blocks })));
    const inputs = new Map<string, VariantInput>();
    const seen = new Set<string>();
    for (const snapshot of snapshots) {
      const target = snapshot.target ?? 'base';
      if (seen.has(snapshot.name)) throw new VibeError('EDIT_OVERLAP', 'Only one target per document may be saved in a batch.');
      seen.add(snapshot.name);
      if (target === 'base') continue;
      const view = getTargetDocumentView(before, snapshot.name, target, snapshot.scopes);
      const next = composeDocumentSnapshot(view, snapshot.blocks).source;
      if (next === view.source) continue;
      const composed = readVariant(before, ...targetParts(target));
      const file = documentScope(composed, snapshot.name).file;
      const edited = { ...composed, sources: new Map([...composed.sources, [file, next]]) };
      const replacements = Object.fromEntries(view.selectedScopes.map(path => [path, documentScope(edited, path).markdown]));
      const rebuilt = documentVariantChanges(composed, replacements).get(file) ?? view.source;
      assertScopedSnapshot(view, snapshot.blocks, rebuilt, next);
      const input = inputs.get(target) ?? inputAt(before, target);
      const changedScopes = Object.fromEntries(Object.entries(replacements).filter(([path, markdown]) =>
        Object.hasOwn(input.documents ?? {}, path) || markdown !== documentScope(composed, path).markdown));
      input.documents = { ...input.documents, ...changedScopes };
      inputs.set(target, input);
    }
    for (const [target, input] of inputs) {
      for (const [file, source] of prepareVariantWrite(before, ...targetParts(target), input)) {
        if (changes.has(file)) throw new VibeError('EDIT_OVERLAP', 'Baseline rename and alternative edits affect the same patch. Save them separately.');
        changes.set(file, source);
      }
    }
    return changes;
  }, options);
}
export async function editVariantDocument(root: string, revision: string, name: string, target: string, operations: DocumentOperation[], options: MutationOptions = {}): Promise<WriteResult> {
  if (!Array.isArray(operations)) throw new VibeError('INVALID_OPERATIONS', 'Expected document operations.');
  return mutateProject(root, revision, before => {
    const composed = readVariant(before, ...targetParts(target)), view = getTargetDocumentView(before, name, target);
    // CLI edits operate only inside scopes already explicitly declared with plan variant.
    const snapshot: DocumentSnapshot['blocks'] = view.blocks.map(block => ({ original: block.index }));
    const replacements = new Map<number, DocumentOperation>(), inserts = new Map<number, string[]>();
    for (const operation of operations) {
      if (!isRecord(operation) || !['insert', 'replace', 'delete'].includes(operation.op)) throw new VibeError('INVALID_OPERATIONS', 'Unknown document operation.');
      const allowed = operation.op === 'insert' ? ['op', 'before', 'markdown'] : operation.op === 'replace' ? ['op', 'block', 'markdown'] : ['op', 'block'];
      if (Object.keys(operation).some(key => !allowed.includes(key))) throw new VibeError('INVALID_OPERATIONS', 'Unexpected document operation field.');
      if (operation.op === 'insert') {
        if (!Number.isInteger(operation.before) || operation.before < 0 || operation.before > snapshot.length) throw new VibeError('PATH_NOT_FOUND', 'Invalid insertion index.');
        const values = inserts.get(operation.before) ?? []; values.push(operation.markdown); inserts.set(operation.before, values);
      } else {
        if (!Number.isInteger(operation.block) || !view.blocks[operation.block]) throw new VibeError('PATH_NOT_FOUND', 'Invalid block index.');
        if (replacements.has(operation.block)) throw new VibeError('EDIT_OVERLAP', 'Repeated block edit.');
        replacements.set(operation.block, operation);
      }
    }
    const blocks: DocumentSnapshot['blocks'] = [];
    for (let i = 0; i <= snapshot.length; i++) {
      blocks.push(...(inserts.get(i) ?? []).map(markdown => ({ markdown })));
      if (i === snapshot.length) break;
      const op = replacements.get(i);
      if (op?.op === 'delete') continue;
      blocks.push(op?.op === 'replace' ? { original: i, markdown: op.markdown } : { original: i });
    }
    const source = composeDocumentSnapshot(view, blocks).source;
    const file = documentScope(composed, name).file;
    const edited = projectWithChanges(composed, new Map([[file, source]]));
    const values = Object.fromEntries(view.selectedScopes.map(path => [path, documentScope(edited, path).markdown]));
    assertScopedSnapshot(view, blocks, documentVariantChanges(composed, values).get(file) ?? view.source, source);
    const input = inputAt(before, target);
    return prepareVariantWrite(before, ...targetParts(target), { ...input, documents: { ...input.documents, ...values } });
  }, options);
}
