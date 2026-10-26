import { documentScope, documentVariantChanges } from './document-variants.js';
import { isDeepStrictEqual } from 'node:util';
import { isMap, isScalar, isSeq } from 'yaml';
import type { Cell, Diagnostic, EditOperation, MutationOptions, Project, WriteResult } from './types.js';
import { isRecord, VibeError } from './types.js';
import type { PlanDefinition, PlanSummary, PlanValue, PlanView, Variant, VariantInput } from './plan-types.js';
import { resourceNameError, resourceNameKey, suggestResourceName } from './names.js';
import { prepareEdits } from './editing.js';
import { mutateProject, projectWithChanges } from './project.js';
import { tableContexts, validateBaseline } from './validation.js';
import { formatYaml, parseYaml } from './yaml.js';

const metadataPath = (plan: string) => 'plans/' + plan + '/_plan.yaml';
const variantPath = (plan: string, variant: string) => 'plans/' + plan + '/' + variant + '.yaml';
const absent = (): PlanValue => ({ present: false, value: null });
const cell = (value: unknown): value is Cell => value === null || typeof value === 'string' || typeof value === 'boolean';
const sorted = (values: Iterable<string>) => [...values].sort();

function fail(code: string, file: string, path: string, message: string): never {
  throw new VibeError(code, message, [{ code, file, path, message }]);
}

function checkName(name: string, file: string): void {
  const error = typeof name === 'string' ? resourceNameError(name) : 'Expected a name.';
  if (error || resourceNameKey(name) === '_plan') fail('NAME_INVALID', file, name,
    (error ?? '_plan is reserved for plan metadata.') + ' 이름 제안: ' + suggestResourceName(typeof name === 'string' && name !== '_plan' ? name : '기획'));
}

function planNames(project: Project): string[] {
  return sorted(new Set([...project.sources.keys()].filter(path => path.startsWith('plans/')).map(path => path.split('/')[1]!)));
}

function variantNames(project: Project, plan: string): string[] {
  const prefix = 'plans/' + plan + '/';
  return sorted([...project.sources.keys()].filter(path => path.startsWith(prefix) && path.endsWith('.yaml') && path !== metadataPath(plan))
    .map(path => path.slice(prefix.length, -5)));
}

function checkCollision(name: string, names: string[], file: string, editing = false): void {
  if (names.some(other => (!editing || other !== name) && resourceNameKey(other) === resourceNameKey(name))) {
    fail('NAME_EXISTS', file, name, 'A name with the same portable spelling already exists: ' + name + ' 이름 제안: ' + suggestResourceName(name, names));
  }
}

function checkSources(data: unknown, file: string, node?: unknown): void {
  if (!isRecord(data) || !Object.hasOwn(data, 'sources')) return;
  const invalid = (path: string): never => fail('PLAN_SOURCE_TYPE', file, path,
    'Invalid source value at ' + path + '. Use strings, booleans, null, arrays and plain objects; quote numeric metadata and coordinates as strings.');
  if (!Array.isArray(data.sources)) invalid('sources');
  const ancestors = new Set<object>();
  function check(value: unknown, path: string, node?: unknown): void {
    if (cell(value)) {
      // The shared failsafe parser reads bare numerals as strings. Check the existing AST
      // before accepting stored metadata so handwritten numbers cannot be silently coerced.
      if (typeof value === 'string' && isScalar(node) && node.type === 'PLAIN' &&
          /^[+-]?(?:\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?|0[xob][\da-f]+|\.(?:inf|nan))$/i.test(value)) invalid(path);
      return;
    }
    if (typeof value !== 'object' || value === null || ancestors.has(value) ||
        (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid(path);
    const container = value as object;
    ancestors.add(container);
    for (const key of Reflect.ownKeys(container)) {
      if (Array.isArray(value) && key === 'length') continue;
      const childPath = path + '/' + String(key);
      const property = Object.getOwnPropertyDescriptor(container, key)!;
      if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value') ||
          (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) invalid(childPath);
      check(property.value, childPath, isSeq(node) ? node.items[Number(key)] : isMap(node) ? node.get(key, true) : undefined);
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) invalid(path + '/' + index);
    }
    ancestors.delete(container);
  }
  check(data.sources, 'sources', node);
}

function dataAt(project: Project, file: string): unknown {
  let parsed = project.files.get(file);
  if (!parsed) {
    const source = project.sources.get(file);
    if (source === undefined) fail('PATH_NOT_FOUND', file, '', 'Missing plan file: ' + file);
    parsed = parseYaml(source, file);
  }
  checkSources(parsed.data, file, isMap(parsed.document.contents) ? parsed.document.get('sources', true) : undefined);
  return parsed.data;
}

function definition(data: unknown, file: string): PlanDefinition {
  checkSources(data, file);
  if (!isRecord(data) || typeof data.title !== 'string' || !['draft', 'review', 'approved'].includes(data.status as string) ||
      Object.keys(data).some(key => !['title', 'status', 'question', 'sources', 'selected'].includes(key)) ||
      (data.question !== undefined && typeof data.question !== 'string') ||
      (data.selected !== undefined && typeof data.selected !== 'string')) {
    fail('PLAN_SHAPE', file, '', 'Expected plan title, status, and optional question, sources and selected variant.');
  }
  if (data.selected !== undefined) checkName(data.selected as string, file);
  if ((data.status === 'approved') !== (data.selected !== undefined)) {
    fail('PLAN_SHAPE', file, 'selected', 'Only an approved plan must identify its selected variant.');
  }
  return data as unknown as PlanDefinition;
}

function address(path: string, length: number, file: string): string[] {
  const parts = path.split('/');
  if (parts.length !== length || parts.some(part => !part || part === '*')) {
    fail('PATH_INVALID', file, path, length === 3 ? 'Expected table/key/column.' : 'Expected table/key.');
  }
  return parts;
}

function patch(data: unknown, file: string, stored: boolean): VariantInput {
  checkSources(data, file);
  const allowed = ['set', 'add', 'remove', 'sources', 'documents', ...(stored ? ['base_values', 'base_missing', 'document_base_values'] : [])];
  if (!isRecord(data) || Object.keys(data).some(key => !allowed.includes(key)) ||
      (data.documents !== undefined && (!isRecord(data.documents) || !Object.values(data.documents).every(value => typeof value === 'string'))) ||
      (data.set !== undefined && (!isRecord(data.set) || !Object.values(data.set).every(cell))) ||
      (data.add !== undefined && (!isRecord(data.add) || !Object.values(data.add).every(row => isRecord(row) && Object.values(row).every(cell)))) ||
      (data.remove !== undefined && (!Array.isArray(data.remove) || !data.remove.every(path => typeof path === 'string')))) {
    fail('VARIANT_SHAPE', file, '', 'Expected set cells, add rows, remove paths and optional sources. Cell values must be strings, booleans or null.');
  }
  const input = data as VariantInput;
  const rows = new Map<string, string>();
  for (const [operation, paths, length] of [
    ['set', Object.keys(input.set ?? {}), 3], ['add', Object.keys(input.add ?? {}), 2], ['remove', input.remove ?? [], 2],
  ] as const) {
    for (const path of paths) {
      const parts = address(path, length, file);
      const row = parts.slice(0, 2).join('/');
      const previous = rows.get(row);
      if (previous && (previous !== 'set' || operation !== 'set')) {
        fail('VARIANT_CONFLICT', file, path, 'A row cannot combine add, remove and set operations or repeat a removal.');
      }
      rows.set(row, operation);
    }
  }
  return input;
}

function touched(input: VariantInput): string[] {
  return [...Object.keys(input.set ?? {}), ...Object.keys(input.add ?? {}), ...(input.remove ?? [])];
}

function variantAt(project: Project, plan: string, name: string): Variant {
  const file = variantPath(plan, name);
  checkName(name, file);
  checkCollision(name, variantNames(project, plan), file, true);
  const data = dataAt(project, file);
  const input = patch(data, file, true);
  const record = data as Record<string, unknown>;
  if (!isRecord(record.base_values) || !Array.isArray(record.base_missing) ||
      !record.base_missing.every(path => typeof path === 'string') ||
      new Set(record.base_missing).size !== record.base_missing.length) {
    fail('VARIANT_SHAPE', file, '', 'Expected base_values and distinct base_missing paths.');
  }
  const paths = new Set(touched(input));
  const missing = new Set(record.base_missing as string[]);
  for (const path of new Set([...paths, ...Object.keys(record.base_values), ...missing])) {
    const captured = Object.hasOwn(record.base_values, path);
    const value = record.base_values[path];
    if (!paths.has(path) || captured === missing.has(path) ||
        (captured && !(path.split('/').length === 3 ? cell(value) : isRecord(value)))) {
      fail('VARIANT_SHAPE', file, path, 'Each patch path needs exactly one original base value or base_missing entry.');
    }
  }
  const docs = Object.keys(input.documents ?? {});
  if ((record.document_base_values !== undefined && !isRecord(record.document_base_values)) ||
      docs.length !== Object.keys(record.document_base_values ?? {}).length || docs.some(path => typeof (record.document_base_values as Record<string, unknown> | undefined)?.[path] !== 'string')) {
    fail('VARIANT_SHAPE', file, '', 'Each document scope needs exactly one original Markdown value.');
  }
  return data as Variant;
}

function summary(project: Project, name: string): PlanSummary {
  const file = metadataPath(name);
  checkName(name, file);
  checkCollision(name, planNames(project), file, true);
  const metadata = definition(dataAt(project, file), file);
  const variants = variantNames(project, name);
  if (metadata.selected !== undefined && !variants.includes(metadata.selected)) {
    fail('PLAN_SHAPE', file, 'selected', 'The selected variant does not exist: ' + metadata.selected);
  }
  return { ...metadata, name, variants };
}

// A composed project must not recursively validate other plans or invent a new write revision.
function baseline(project: Project): Project {
  return { ...project,
    sources: new Map([...project.sources].filter(([file]) => !file.startsWith('plans/'))),
    files: new Map([...project.files].filter(([file]) => !file.startsWith('plans/'))),
    diagnostics: project.diagnostics.filter(item => !item.file.startsWith('plans/')),
  };
}

type Contexts = ReturnType<typeof tableContexts>;

function valueAt(contexts: Contexts, path: string): PlanValue {
  const [table, key, column] = path.split('/');
  const context = contexts.get(table!);
  if (!context) return absent();
  const rows = context.table.rows.filter(row => row[context.schema.primary_key] === key);
  if (rows.length !== 1) return absent();
  if (column === undefined) return { present: true, value: rows[0]! };
  if (!Object.hasOwn(context.schema.columns, column) || !Object.hasOwn(rows[0]!, column)) return absent();
  return { present: true, value: rows[0]![column] };
}

function changesFor(project: Project, input: VariantInput, file: string): Map<string, string> {
  const contexts = tableContexts(project);
  const operations: EditOperation[] = [];
  const updates = new Map<string, Record<string, Cell>>();
  for (const path of touched(input)) {
    const [table, key, column] = path.split('/');
    const context = contexts.get(table!);
    if (!context) fail('PATH_NOT_FOUND', file, path, 'Unknown table or invalid schema: ' + table);
    if (column !== undefined) {
      if (column === context.schema.primary_key) fail('RENAME_REQUIRED', file, path, 'Use rename to change a Key.');
      if (!Object.hasOwn(context.schema.columns, column)) fail('PATH_NOT_FOUND', file, path, 'Unknown column: ' + column);
    }
    const rows = context.table.rows.filter(row => row[context.schema.primary_key] === key);
    if (Object.hasOwn(input.add ?? {}, path)) {
      const fields = input.add![path]!;
      if (Object.hasOwn(fields, context.schema.primary_key)) fail('RENAME_REQUIRED', file, path, 'The added Key comes from its row path; omit the Key field.');
      if (rows.length) fail('NAME_EXISTS', file, path, 'The added row already exists.');
      for (const field of Object.keys(fields)) {
        if (!Object.hasOwn(context.schema.columns, field)) fail('COLUMN_UNKNOWN', file, path + '/' + field, 'Unknown column: ' + field);
      }
      operations.push({ op: 'create', table: table!, row: { [context.schema.primary_key]: key!, ...fields } });
    } else {
      if (rows.length !== 1) fail('PATH_NOT_FOUND', file, path, 'Row Key is missing or ambiguous: ' + table + '/' + key);
      if (column === undefined) operations.push({ op: 'delete', table: table!, key: key! });
      else {
        const rowPath = table + '/' + key;
        const values = updates.get(rowPath) ?? Object.create(null) as Record<string, Cell>;
        values[column] = input.set![path]!;
        updates.set(rowPath, values);
      }
    }
  }
  for (const [path, values] of updates) {
    const [table, key] = path.split('/');
    operations.push({ op: 'update', table: table!, key: key!, values });
  }
  const changes = operations.length ? prepareEdits(project, operations) : new Map<string, string>();
  for (const [path, source] of documentVariantChanges(project, input.documents)) changes.set(path, source);
  return changes;
}

function composed(project: Project, input: VariantInput, file: string): Project {
  const before = baseline(project);
  return { ...projectWithChanges(before, changesFor(before, input, file)), revision: project.revision };
}

function warnings(project: Project, input: Variant, file: string): Diagnostic[] {
  const contexts = tableContexts(project);
  const docWarnings: Diagnostic[] = Object.entries(input.documents ?? {}).flatMap(([path, alternative]) => {
    const old = input.document_base_values![path], current = documentScope(project, path).markdown;
    return old === current ? [] : [{ code: 'BASE_CHANGED', severity: 'warning', file, path,
      message: 'Document baseline changed: old=' + JSON.stringify(old) + '; current=' + JSON.stringify(current) + '; alternative=' + JSON.stringify(alternative) }];
  });
  return [...docWarnings, ...touched(input).flatMap(path => {
    const old = Object.hasOwn(input.base_values, path) ? { present: true, value: input.base_values[path] } : absent();
    const current = valueAt(contexts, path);
    if (isDeepStrictEqual(old, current)) return [];
    const alternative = Object.hasOwn(input.set ?? {}, path) ? { present: true, value: input.set![path] } :
      Object.hasOwn(input.add ?? {}, path) ? { present: true, value: input.add![path] } : absent();
    return [{ code: 'BASE_CHANGED', severity: 'warning' as const, file, path,
      message: 'Baseline changed: old=' + JSON.stringify(old) + '; current=' + JSON.stringify(current) + '; alternative=' + JSON.stringify(alternative) }];
  })];
}

function diagnosticsFrom(error: unknown, file: string): Diagnostic[] {
  if (!(error instanceof VibeError)) throw error;
  return error.diagnostics.length ? [...error.diagnostics] : [{ code: error.code, file, path: '', message: error.message }];
}

function prefix(items: Diagnostic[], name: string): Diagnostic[] {
  return items.map(item => ({ ...item, message: name + ': ' + item.message }));
}

function inspect(project: Project, plan: PlanSummary, validate: (project: Project) => Diagnostic[]) {
  const variants: Record<string, Variant> = Object.create(null) as Record<string, Variant>;
  const diagnostics: Diagnostic[] = [];
  for (const name of plan.variants) {
    const file = variantPath(plan.name, name);
    const label = plan.name + '/' + name;
    try {
      const input = variantAt(project, plan.name, name);
      variants[name] = input;
      if (plan.status === 'approved') continue;
      diagnostics.push(...prefix(warnings(project, input, file), label));
      diagnostics.push(...prefix(validate(composed(project, input, file)), label));
    } catch (error) { diagnostics.push(...prefix(diagnosticsFrom(error, file), label)); }
  }
  return { variants, diagnostics };
}

export function listPlans(project: Project): PlanSummary[] {
  return planNames(project).map(name => summary(project, name));
}

export function getPlan(project: Project, name: string): PlanView {
  const plan = summary(project, name);
  const { variants, diagnostics } = inspect(project, plan, validateBaseline);
  const contexts = tableContexts(project);
  const paths = new Set<string>();
  for (const input of Object.values(variants)) {
    for (const path of Object.keys(input.set ?? {})) paths.add(path);
    for (const path of [...Object.keys(input.add ?? {}), ...(input.remove ?? [])]) {
      const context = contexts.get(path.split('/')[0]!);
      const captured = input.base_values[path];
      const fields = new Set([...Object.keys(context?.schema.columns ?? {}), ...Object.keys(input.add?.[path] ?? {}),
        ...(isRecord(captured) ? Object.keys(captured) : [])]);
      for (const field of fields) paths.add(path + '/' + field);
    }
  }
  const comparison = sorted(paths).map(path => {
    const [table, key, column] = path.split('/');
    const rowPath = table + '/' + key;
    const current = valueAt(contexts, path);
    const alternatives = Object.fromEntries(Object.entries(variants).map(([name, input]) => {
      let value = current;
      if (Object.hasOwn(input.set ?? {}, path)) value = { present: true, value: input.set![path] };
      else if (input.remove?.includes(rowPath)) value = absent();
      else if (Object.hasOwn(input.add ?? {}, rowPath)) {
        const row = input.add![rowPath]!;
        value = column === contexts.get(table!)?.schema.primary_key ? { present: true, value: key } :
          Object.hasOwn(row, column!) ? { present: true, value: row[column!] } : absent();
      }
      return [name, value];
    }));
    return { path, baseline: current, alternatives };
  });
  const documentPaths = new Set(Object.values(variants).flatMap(input => Object.keys(input.documents ?? {})));
  const composedVariants = new Map<string, Project>();
  if (documentPaths.size && plan.status !== 'approved') for (const [name, input] of Object.entries(variants)) {
    try { composedVariants.set(name, composed(project, input, variantPath(plan.name, name))); } catch { /* Composition errors are already reported above. */ }
  }
  const documentComparison = sorted(documentPaths).map(path => {
    let current: PlanValue = absent();
    try { current = { present: true, value: documentScope(project, path).markdown }; } catch { /* Missing scope is a composition error above. */ }
    return { path, kind: 'document' as const, baseline: current, alternatives: Object.fromEntries(Object.entries(variants).map(([name, input]) =>
      {
        if (plan.status === 'approved') return [name, Object.hasOwn(input.documents ?? {}, path) ? { present: true, value: input.documents![path] } : current];
        const alternative = composedVariants.get(name);
        try { return [name, alternative ? { present: true, value: documentScope(alternative, path).markdown } : absent()]; }
        catch { return [name, absent()]; }
      })) };
  });
  return { revision: project.revision, plan, variants, comparison: [...comparison, ...documentComparison], diagnostics };
}

export function readVariant(project: Project, plan: string, variant: string): Project {
  if (summary(project, plan).status === 'approved') {
    fail('ARCHIVED_PLAN', metadataPath(plan), plan, 'Approved plans are archived. Use Git history to read past states.');
  }
  return composed(project, variantAt(project, plan, variant), variantPath(plan, variant));
}

function yaml(data: unknown, file: string): string {
  return formatYaml(parseYaml(JSON.stringify(data), file)).source;
}

function ordered<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(sorted(Object.keys(record)).map(key => [key, record[key]!]));
}

function variantYaml(input: VariantInput, base_values: Variant['base_values'], base_missing: string[], file: string, document_base_values: Record<string, string> = {}): string {
  return yaml({
    ...(input.documents === undefined ? {} : { documents: ordered(input.documents), document_base_values: ordered(document_base_values) }),
    ...(input.set === undefined ? {} : { set: ordered(input.set) }),
    ...(input.add === undefined ? {} : { add: ordered(Object.fromEntries(Object.entries(input.add).map(([path, row]) => [path, ordered(row)]))) }),
    ...(input.remove === undefined ? {} : { remove: sorted(input.remove) }),
    ...(input.sources === undefined ? {} : { sources: input.sources }),
    base_values: ordered(base_values), base_missing: sorted(base_missing),
  }, file);
}

function editable(project: Project, name: string): PlanSummary {
  const plan = summary(project, name);
  if (plan.status === 'approved') fail('ARCHIVED_PLAN', metadataPath(name), name, 'Approved plans are immutable.');
  return plan;
}

export async function createPlan(root: string, revision: string, name: string, input: PlanDefinition, options: MutationOptions = {}): Promise<WriteResult> {
  return mutateProject(root, revision, before => {
    const file = metadataPath(name);
    checkName(name, file);
    checkCollision(name, planNames(before), file);
    const metadata = definition(input, file);
    if (metadata.status === 'approved') fail('PLAN_SHAPE', file, 'status', 'Use approvePlan to merge a selected variant before archiving.');
    return new Map([[file, yaml(metadata, file)]]);
  }, options);
}

export async function writeVariant(root: string, revision: string, plan: string, name: string, input: VariantInput, options: MutationOptions = {}): Promise<WriteResult> {
  return mutateProject(root, revision, before => {
    return prepareVariantWrite(before, plan, name, input);
  }, options);
}

export function prepareVariantWrite(before: Project, plan: string, name: string, input: VariantInput): Map<string, string> {
  editable(before, plan);
  const file = variantPath(plan, name);
  checkName(name, file);
  checkCollision(name, variantNames(before, plan), file, true);
  patch(input, file, false);
  changesFor(baseline(before), input, file);
  const previous = before.sources.has(file) ? variantAt(before, plan, name) : undefined;
  const contexts = tableContexts(before);
  const base_values: Variant['base_values'] = Object.create(null) as Variant['base_values'];
  const base_missing: string[] = [];
  for (const path of touched(input)) {
    if (previous && Object.hasOwn(previous.base_values, path)) base_values[path] = previous.base_values[path]!;
    else if (previous?.base_missing.includes(path)) base_missing.push(path);
    else {
      const current = valueAt(contexts, path);
      if (current.present) base_values[path] = current.value as Cell | Record<string, unknown>;
      else base_missing.push(path);
    }
  }
  const document_base_values = Object.fromEntries(Object.keys(input.documents ?? {}).map(path => [path,
    previous?.document_base_values?.[path] ?? documentScope(before, path).markdown]));
  const source = variantYaml(input, base_values, base_missing, file, document_base_values);
  return new Map([[file, previous && isDeepStrictEqual(parseYaml(source, file).data, dataAt(before, file)) ? before.sources.get(file)! : source]]);
}

export async function setPlanStatus(root: string, revision: string, name: string, status: 'draft' | 'review', options: MutationOptions = {}): Promise<WriteResult> {
  return mutateProject(root, revision, before => {
    editable(before, name);
    if (status !== 'draft' && status !== 'review') fail('PLAN_SHAPE', metadataPath(name), 'status', 'Expected draft or review.');
    const file = metadataPath(name);
    return new Map([[file, yaml({ ...definition(dataAt(before, file), file), status }, file)]]);
  }, options);
}

export async function approvePlan(root: string, revision: string, plan: string, name: string, options: MutationOptions = {}): Promise<WriteResult> {
  return mutateProject(root, revision, before => {
    editable(before, plan);
    const input = variantAt(before, plan, name);
    const changes = changesFor(before, input, variantPath(plan, name));
    const file = metadataPath(plan);
    changes.set(file, yaml({ ...definition(dataAt(before, file), file), status: 'approved', selected: name }, file));
    return changes;
  }, options);
}

export function validatePlans(project: Project, validateBaseline: (project: Project) => Diagnostic[]): Diagnostic[] {
  // validateProject owns baseline validation; this pass adds each independent alternative.
  const diagnostics: Diagnostic[] = [];
  for (const name of planNames(project)) {
    try { diagnostics.push(...inspect(project, summary(project, name), validateBaseline).diagnostics); }
    catch (error) { diagnostics.push(...prefix(diagnosticsFrom(error, metadataPath(name)), name)); }
  }
  return diagnostics;
}
