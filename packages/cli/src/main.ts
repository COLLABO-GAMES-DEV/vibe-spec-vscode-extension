#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  VibeError, formattedSources, initProject, loadProject, readPath,
  resolveProjectRoot, validateProject, writeChanges,
  applyEdits, editProject, renameResource, whereUsed,
  inspectImport, planImport, applyImport,
  exportMarkdown, inspectSource,
  getGitStatus, saveProject, pushProject, pullProject, resolveProject,
  listPlans, getPlan, readVariant, createPlan, writeVariant, setPlanStatus, approvePlan,
  getTargetDocumentView, editVariantDocument,
  listDocuments, getDocumentView, createDocument, editDocument, deleteDocument, addDocumentImage,
  applyFolderEdit, listFolders,
} from '@vibe-spec/core';
import type { Diagnostic, DocumentOperation, EditOperation, FolderOperation, GitChoice, GitResult, GitStatus, ImportMapping, ImportPlan, PlanDefinition, Project, RenameKind, VariantInput, WriteResult } from '@vibe-spec/core';
import { classify, isWrite, parseCommandLine, validateInvocation, variantTarget } from './commands.js';
import type { CommandName, Invocation, Values } from './commands.js';

const usage = `Usage:
  vibe init <folder> [--json]
  vibe read <table-or-path> [--target base|<plan>/<variant>] [--project <folder>] [--json]
  vibe document list [--project <folder>] [--json]
  vibe document read <name> [--target base|<plan>/<variant>] [--project <folder>] [--json]
  vibe document create <name> [--folder <path>] --input <markdown-file> --target base --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe document edit <name> --input <operations-json> --target base|<plan>/<variant> --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe document delete <name> --target base --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe document image <input-file> --target base --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe folder list [--project <folder>] [--json]
  vibe folder create <path> --target base --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe folder rename <path> --to <name> --target base --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe folder move <path> --folder <path> --target base --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe folder delete <path> --target base --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe move <table|document> <name> --folder <path> --target base --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe plan list [--project <folder>] [--json]
  vibe plan read <name> [--project <folder>] [--json]
  vibe plan create <name> --input <definition-json> --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe plan variant <plan>/<variant> --input <variant-json> --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe plan status <name> --to draft|review --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe plan approve <plan>/<variant> --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe validate [--project <folder>] [--json]
  vibe fmt [--check] [--project <folder>] [--json]
  vibe export [--output <folder>] [--project <folder>] [--json]
  vibe edit --target base --input <json-file> --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe apply --target base --input <json-array-file> --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe rename <key|table|column|schema|document|heading|tag> <path> --target base --to <name> --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe where-used <path> [--project <folder>] [--json]
  vibe import inspect <file> [--json]
  vibe import plan <file> --mapping <mapping-json> [--project <folder>] [--json]
  vibe import apply --target base --input <plan-json> --expect-revision <revision> [--project <folder>] [--json]
  vibe source inspect <csv|tsv|xlsx|notion.zip> [--json]
  vibe status [--project <folder>] [--json]
  vibe save --reason <text> [--expect-revision <revision>] [--project <folder>] [--json]
  vibe push [--project <folder>] [--json]
  vibe pull [--project <folder>] [--json]
  vibe pull --resolve <choices-json> --expect-revision <revision> [--project <folder>] [--json]
  vibe --help

Baseline writes require --target base once plans exist. Variant writes use plan variant.
Document and folder/move writes always require --target base. Folder paths are relative; an empty --folder means the top level. Public resource names never include folders.
For table-create operations, edit accepts --folder <path> (or folder in the input operation). Document edit takes an array of replace {block, markdown}, insert {before, markdown}, or delete {block} operations, each with an op field.
Block indices and ranges are zero-based and valid only for the read revision; never rewrite the whole Markdown document.
Exit codes: 0 success (including warnings), 1 validation errors, unresolved conflicts or formatting needed, 2 command failure.`;

/** Result state shared by handlers; the failure path reports whatever was reached. */
interface Run {
  project?: Project;
  data: unknown;
  diagnostics: readonly Diagnostic[];
  status: number;
  gitRoot?: string;
  gitStatus?: GitStatus;
}
type Handler = (run: Run, inv: Invocation) => Promise<void>;
type ProjectHandler = (run: Run, inv: Invocation, project: Project) => Promise<void> | void;

async function readJson(path: string): Promise<unknown> {
  // Windows PowerShell's Out-File -Encoding utf8 prefixes JSON with a BOM.
  return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
}
const isDryRun = (values: Values) => values['dry-run'] ?? false;
function requireRevision(values: Values, source: string): string {
  const revision = values['expect-revision'];
  if (!revision) throw new VibeError('REVISION_REQUIRED', 'Supply --expect-revision from ' + source + '.');
  return revision;
}
function writeData(result: WriteResult, dryRun: boolean) {
  return dryRun ? { applied: false, changed: [], planned: result.changed,
    preview: Object.fromEntries(result.changed.map(path => [path, result.planned.sources.get(path) ?? null])), candidates: result.candidates }
    : { applied: true, changed: result.changed, candidates: result.candidates };
}
function recordWrite(run: Run, result: WriteResult, dryRun: boolean) {
  run.project = result.project;
  run.data = writeData(result, dryRun);
  run.diagnostics = result.diagnostics;
}

// Commands that do not read a planning folder.
const init: Handler = async (run, { positionals, values }) => {
  if (values.project !== undefined) throw new VibeError('INVALID_ARGUMENT', 'init takes its destination as <folder>, without --project.');
  run.project = await initProject(resolve(positionals[1]!));
  run.data = { root: run.project.root };
};
const importInspect: Handler = async (run, { positionals }) => { run.data = await inspectImport(resolve(positionals[2]!)); };
const source: Handler = async (run, { positionals }) => { run.data = await inspectSource(positionals[2]!); };
const git: Handler = async (run, { command, values }) => {
  const root = run.gitRoot = await resolveProjectRoot(process.cwd(), values.project);
  if (command === 'status') {
    run.gitStatus = await getGitStatus(root);
    run.data = run.gitStatus;
    run.project = await loadProject(root);
    return;
  }
  let result: GitResult;
  if (command === 'save') {
    if (values.reason === undefined) throw new VibeError('INVALID_ARGUMENT', 'Supply --reason <text>.');
    result = await saveProject(root, values.reason, values['expect-revision']);
  } else if (command === 'push') {
    result = await pushProject(root);
  } else if (values.resolve !== undefined) {
    const revision = requireRevision(values, 'status');
    result = await resolveProject(root, revision, await readJson(values.resolve) as GitChoice[]);
  } else {
    result = await pullProject(root);
  }
  run.data = result;
  run.gitStatus = result.status;
  run.diagnostics = result.diagnostics;
  if (!result.completed) run.status = 1;
};

// Commands on a loaded planning folder.
const read: ProjectHandler = (run, { sub, selectedTarget }, project) => {
  const view = selectedTarget === 'base' ? project : readVariant(project, ...variantTarget(selectedTarget!));
  run.data = readPath(view, sub!);
};
const folderWrite: ProjectHandler = async (run, { command, sub, positionals, values }, project) => {
  const revision = requireRevision(values, 'read or validate');
  const path = positionals[2]!;
  let operation: FolderOperation;
  if (command === 'move' || sub === 'move') {
    if (values.folder === undefined) throw new VibeError('INVALID_ARGUMENT', 'Supply --folder <path>; use an empty string for the top level.');
    operation = command === 'move'
      ? { op: 'resource-move', kind: sub as 'table' | 'document', name: path, folder: values.folder }
      : { op: 'folder-move', path, folder: values.folder };
  } else if (sub === 'rename') {
    if (!values.to) throw new VibeError('INVALID_ARGUMENT', 'Supply --to <name>.');
    operation = { op: 'folder-rename', path, name: values.to };
  } else operation = { op: sub === 'create' ? 'folder-create' : 'folder-delete', path };
  recordWrite(run, await applyFolderEdit(project.root, revision, operation, { dryRun: isDryRun(values) }), isDryRun(values));
};
const folder: ProjectHandler = (run, inv, project) => {
  if (inv.sub !== 'list') return folderWrite(run, inv, project);
  run.data = listFolders(project);
};
const document: ProjectHandler = async (run, { sub, positionals, values, selectedTarget }, project) => {
  const name = positionals[2]!;
  if (sub === 'list') { run.data = listDocuments(project); return; }
  if (sub === 'read') { run.data = getTargetDocumentView(project, name, selectedTarget); return; }
  const revision = requireRevision(values, 'document read or validate');
  const options = { dryRun: isDryRun(values) };
  if (sub === 'image') {
    run.data = await addDocumentImage(project.root, revision, resolve(name), options);
    run.project = await loadProject(project.root);
    run.diagnostics = validateProject(run.project);
    return;
  }
  let result: WriteResult;
  if (sub === 'delete') {
    result = await deleteDocument(project.root, revision, name, options);
  } else {
    if (!values.input) throw new VibeError('INVALID_ARGUMENT', 'Supply --input <' + (sub === 'create' ? 'markdown-file' : 'operations-json') + '>.');
    if (sub === 'create') {
      // Preserve the BOM and reject invalid UTF-8 instead of replacing source bytes.
      const markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(values.input));
      result = await createDocument(project.root, revision, name, markdown, { ...options, ...(values.folder !== undefined ? { folder: values.folder } : {}) });
    } else {
      const operations = await readJson(values.input) as DocumentOperation[];
      result = selectedTarget === 'base' ? await editDocument(project.root, revision, name, operations, options)
        : await editVariantDocument(project.root, revision, name, selectedTarget!, operations, options);
    }
  }
  recordWrite(run, result, options.dryRun);
};
const plan: ProjectHandler = async (run, { sub, positionals, values }, project) => {
  const name = positionals[2]!;
  if (sub === 'list') { run.data = listPlans(project); return; }
  if (sub === 'read') { run.data = getPlan(project, name); return; }
  const revision = requireRevision(values, 'read');
  const options = { dryRun: isDryRun(values) };
  let result: WriteResult;
  if (sub === 'create' || sub === 'variant') {
    if (!values.input) throw new VibeError('INVALID_ARGUMENT', 'Supply --input <json-file>.');
    const input = await readJson(values.input);
    result = sub === 'create'
      ? await createPlan(project.root, revision, name, input as PlanDefinition, options)
      : await writeVariant(project.root, revision, ...variantTarget(name), input as VariantInput, options);
  } else if (sub === 'status') {
    if (values.to !== 'draft' && values.to !== 'review') throw new VibeError('INVALID_ARGUMENT', 'Supply --to draft|review; approve a selected variant with plan approve.');
    result = await setPlanStatus(project.root, revision, name, values.to, options);
  } else {
    result = await approvePlan(project.root, revision, ...variantTarget(name), options);
  }
  recordWrite(run, result, options.dryRun);
};
const whereUsedCommand: ProjectHandler = async (run, { sub }, project) => { run.data = await whereUsed(project, sub!); };
const exportCommand: ProjectHandler = async (run, { values }, project) => {
  const result = await exportMarkdown(project, values.output);
  run.data = result;
  run.diagnostics = result.diagnostics;
};
const importPlan: ProjectHandler = async (run, { positionals, values }, project) => {
  if (!values.mapping) throw new VibeError('INVALID_ARGUMENT', 'Supply --mapping <mapping-json>.');
  const mapping = await readJson(values.mapping) as ImportMapping;
  const result = planImport(project, await inspectImport(resolve(positionals[2]!)), mapping);
  run.data = result;
  run.diagnostics = result.diagnostics;
  if (!result.canApply) run.status = 1;
};
/** edit, apply, rename and import apply: writes to the baseline. */
const baselineWrite: ProjectHandler = async (run, inv, project) => {
  const { command, sub, positionals, values } = inv;
  if (values.target === undefined && [...project.sources.keys()].some(path => path.startsWith('plans/'))) {
    inv.selectedTarget = undefined;
    throw new VibeError('TARGET_REQUIRED', 'Plans exist. Supply --target base to edit the baseline, or use plan variant <plan>/<variant>.');
  }
  const revision = requireRevision(values, 'read');
  const dryRun = isDryRun(values);
  let result: WriteResult;
  if (command === 'rename') {
    if (!values.to) throw new VibeError('INVALID_ARGUMENT', 'Supply --to <name>.');
    result = await renameResource(project.root, revision, sub as RenameKind, positionals[2]!, values.to, { dryRun });
  } else {
    if (!values.input) throw new VibeError('INVALID_ARGUMENT', 'Supply --input <json-file>.');
    let input = await readJson(values.input);
    if (values.folder !== undefined) {
      if (!input || typeof input !== 'object' || !('op' in input) || input.op !== 'table-create') {
        throw new VibeError('INVALID_ARGUMENT', '--folder on edit requires a table-create operation.');
      }
      if ('folder' in input && input.folder !== values.folder) {
        throw new VibeError('INVALID_ARGUMENT', '--folder conflicts with the input folder.');
      }
      input = { ...input, folder: values.folder };
    }
    if (command === 'import') {
      const imported = typeof input === 'object' && input !== null && 'data' in input ? input.data : input;
      result = await applyImport(project.root, revision, imported as ImportPlan);
    } else if (command === 'edit') {
      result = await editProject(project.root, revision, input, { dryRun });
    } else {
      result = await applyEdits(project.root, revision, input as EditOperation[], { dryRun });
    }
  }
  recordWrite(run, result, dryRun);
};
const fmt: ProjectHandler = async (run, { values }, project) => {
  const formatted = formattedSources(project);
  const changed = [...formatted].filter(([path, source]) => source !== project.sources.get(path)).map(([path]) => path);
  if (values.check) {
    run.data = { changed };
    if (changed.length) run.status = 1;
  } else {
    run.data = { changed: await writeChanges(project, formatted) };
    run.project = await loadProject(project.root);
  }
};

const withProject = (handler: ProjectHandler): Handler => async (run, inv) => {
  run.project = await loadProject(await resolveProjectRoot(process.cwd(), inv.values.project));
  await handler(run, inv, run.project);
};
const handlers: Record<CommandName, Handler> = {
  init, source, status: git, save: git, push: git, pull: git,
  import: (run, inv) => inv.sub === 'inspect' ? importInspect(run, inv) : withProject(inv.sub === 'plan' ? importPlan : baselineWrite)(run, inv),
  read: withProject(read), folder: withProject(folder), move: withProject(folderWrite),
  document: withProject(document), plan: withProject(plan),
  validate: withProject(() => {}), fmt: withProject(fmt), export: withProject(exportCommand), 'where-used': withProject(whereUsedCommand),
  edit: withProject(baselineWrite), apply: withProject(baselineWrite), rename: withProject(baselineWrite),
};

function gitActionOf(command: string | undefined, resolving: boolean): GitResult['action'] | undefined {
  return command === 'save' || command === 'push' ? command : command === 'pull' ? (resolving ? 'resolve' : 'pull') : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  let json = args.includes('--json');
  const run: Run = { data: null, diagnostics: [], status: 0 };
  let inv: Invocation | undefined;
  let failure: { code: string; message: string } | undefined;
  let gitAction = gitActionOf(args[0], args.includes('--resolve'));

  try {
    const { values, positionals } = parseCommandLine(args);
    json = values.json ?? false;
    inv = classify(values, positionals);
    gitAction = gitActionOf(inv.command, values.resolve !== undefined);
    if (gitAction) run.data = { action: gitAction, completed: false };
    if (values.help) {
      run.data = { usage };
    } else {
      const command = validateInvocation(inv);
      await handlers[command](run, inv);
      const derived = command === 'export' || command === 'import' && inv.sub === 'plan';
      if (run.project && !derived && !values['dry-run']) run.diagnostics = validateProject(run.project);
      if (run.diagnostics.some(item => item.severity !== 'warning')) run.status = 1;
    }
  } catch (error) {
    run.status = 2;
    failure = {
      code: error instanceof VibeError ? error.code :
        (error as NodeJS.ErrnoException).code ?? 'COMMAND_FAILED',
      message: error instanceof Error ? error.message : String(error),
    };
    if (gitAction) {
      // Command failure must not look like a successful local save or remote upload.
      if (run.gitRoot) {
        try {
          run.gitStatus = await getGitStatus(run.gitRoot);
          run.project = await loadProject(run.gitRoot);
        } catch { /* Keep the command error even if Git status is unavailable. */ }
      }
      run.data = { action: gitAction, completed: false, ...(run.gitStatus ? { status: run.gitStatus } : {}) };
    } else if (inv && isWrite(inv) || args.some(arg => ['edit', 'apply', 'rename'].includes(arg))) {
      const written = error instanceof VibeError ? error.written : [];
      run.data = { applied: written.length > 0, changed: written, ...(written.length ? { partial: true } : {}) };
    }
    // On a partial file-write failure, report the current revision if it can be read.
    if (run.project) {
      try { run.project = await loadProject(run.project.root); }
      catch { /* Keep the last readable revision; the operation error remains primary. */ }
      run.diagnostics = validateProject(run.project);
    }
    if (error instanceof VibeError) {
      run.diagnostics = [...run.diagnostics, ...error.diagnostics.filter(item => !run.diagnostics.some(existing =>
        existing.code === item.code && existing.file === item.file && existing.path === item.path))];
    }
  }

  const { data, diagnostics, status } = run;
  const selectedTarget = inv?.selectedTarget;
  const result = { ok: status === 0, revision: run.gitStatus?.revision ?? run.project?.revision ?? null, data, diagnostics,
    ...(selectedTarget !== undefined ? { target: selectedTarget } : {}),
    ...(failure ? { error: failure } : {}) };
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    if (selectedTarget !== undefined) process.stdout.write('Target: ' + selectedTarget + '\n');
    if (data !== null) process.stdout.write(
      typeof data === 'object' && 'usage' in data ? usage + '\n' : JSON.stringify(data, null, 2) + '\n',
    );
    for (const item of diagnostics) {
      process.stderr.write(`${item.file} ${item.path}: ${item.code}: ${item.message}\n`);
    }
    if (failure) process.stderr.write(failure.code + ': ' + failure.message + '\n');
    else if (data === null && !diagnostics.length) process.stdout.write('Valid.\n');
  }
  process.exitCode = status;
}

void main();
