#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  VibeError, formattedSources, initProject, loadProject, readPath,
  resolveProjectRoot, validateProject, writeChanges,
  applyEdits, editProject, renameResource, whereUsed,
  inspectImport, planImport, applyImport,
  exportMarkdown, inspectSource,
  getGitStatus, saveProject, pushProject, pullProject, resolveProject,
  listPlans, getPlan, readVariant, createPlan, writeVariant, setPlanStatus, approvePlan,
  listDocuments, getDocumentView, createDocument, editDocument, deleteDocument, addDocumentImage,
  resourceNameError, applyFolderEdit, listFolders,
} from '@vibe-spec/core';
import type { Diagnostic, DocumentOperation, EditOperation, FolderOperation, GitChoice, GitResult, GitStatus, ImportMapping, ImportPlan, PlanDefinition, Project, RenameKind, VariantInput, WriteResult } from '@vibe-spec/core';

const usage = `Usage:
  vibe init <folder> [--json]
  vibe read <table-or-path> [--target base|<plan>/<variant>] [--project <folder>] [--json]
  vibe document list [--project <folder>] [--json]
  vibe document read <name> [--project <folder>] [--json]
  vibe document create <name> [--folder <path>] --input <markdown-file> --target base --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
  vibe document edit <name> --input <operations-json> --target base --expect-revision <revision> [--dry-run] [--project <folder>] [--json]
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

function variantTarget(value: string): [string, string] {
  const parts = value.split('/');
  if (parts.length !== 2 || parts.some(part => resourceNameError(part))) {
    throw new VibeError('INVALID_ARGUMENT', 'Supply a target as <plan>/<variant>.');
  }
  return [parts[0]!, parts[1]!];
}

function writeData(result: WriteResult, dryRun: boolean) {
  return dryRun ? { applied: false, changed: [], planned: result.changed,
    preview: Object.fromEntries(result.changed.map(path => [path, result.planned.sources.get(path) ?? null])), candidates: result.candidates }
    : { applied: true, changed: result.changed, candidates: result.candidates };
}

async function main() {
  const args = process.argv.slice(2);
  async function readJson(path: string): Promise<unknown> {
    // Windows PowerShell's Out-File -Encoding utf8 prefixes JSON with a BOM.
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  }
  let json = args.includes('--json');
  let project: Project | undefined;
  let data: unknown = null;
  let diagnostics: readonly Diagnostic[] = [];
  let status = 0;
  let failure: { code: string; message: string } | undefined;
  let selectedTarget: string | undefined;
  let isWrite = false;
  let gitRoot: string | undefined;
  let gitStatus: GitStatus | undefined;
  let gitAction: GitResult['action'] | undefined =
    args[0] === 'save' || args[0] === 'push' ? args[0] :
      args[0] === 'pull' ? (args.includes('--resolve') ? 'resolve' : 'pull') : undefined;

  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true, strict: true,
      options: {
        project: { type: 'string' }, json: { type: 'boolean' },
        help: { type: 'boolean' }, check: { type: 'boolean' },
        input: { type: 'string' }, to: { type: 'string' }, 'expect-revision': { type: 'string' },
        mapping: { type: 'string' }, reason: { type: 'string' }, resolve: { type: 'string' },
        output: { type: 'string' }, 'dry-run': { type: 'boolean' },
        target: { type: 'string' }, folder: { type: 'string' },
      },
    });
    json = values.json ?? false;
    const [command, target] = positionals;
    const baselineWrite = command === 'edit' || command === 'apply' || command === 'rename' || command === 'import' && target === 'apply';
    const planWrite = command === 'plan' && ['create', 'variant', 'status', 'approve'].includes(target ?? '');
    const documentWrite = command === 'document' && ['create', 'edit', 'delete', 'image'].includes(target ?? '');
    const documentRename = command === 'rename' && ['document', 'heading', 'tag'].includes(target ?? '');
    const folderWrite = command === 'move' || command === 'folder' && ['create', 'rename', 'move', 'delete'].includes(target ?? '');
    isWrite = baselineWrite || planWrite || documentWrite || folderWrite;
    if (command === 'read' || command === 'document' || baselineWrite || folderWrite) selectedTarget = values.target ?? 'base';
    if (command === 'plan' && target !== 'list') selectedTarget = positionals[2];
    const isGitCommand = ['status', 'save', 'push', 'pull'].includes(command ?? '');
    gitAction = command === 'save' || command === 'push' ? command :
      command === 'pull' ? (values.resolve !== undefined ? 'resolve' : 'pull') : undefined;
    if (gitAction) data = { action: gitAction, completed: false };
    if (values.help) {
      data = { usage };
    } else {
      if (!command || !['init', 'read', 'document', 'folder', 'move', 'plan', 'validate', 'fmt', 'export', 'edit', 'apply', 'rename', 'where-used', 'import', 'source', 'status', 'save', 'push', 'pull'].includes(command)) {
        throw new VibeError('INVALID_ARGUMENT', 'Unknown command. Use --help.');
      }
      const needsTarget = command === 'init' || command === 'read' || command === 'where-used';
      if (command === 'import' && !['inspect', 'plan', 'apply'].includes(target ?? '')) {
        throw new VibeError('INVALID_ARGUMENT', 'Use import inspect, plan or apply.');
      }
      if (command === 'source' && target !== 'inspect') throw new VibeError('INVALID_ARGUMENT', 'Use source inspect <file>.');
      if (command === 'plan' && !['list', 'read', 'create', 'variant', 'status', 'approve'].includes(target ?? '')) {
        throw new VibeError('INVALID_ARGUMENT', 'Use plan list, read, create, variant, status or approve.');
      }
      if (command === 'document' && !['list', 'read', 'create', 'edit', 'delete', 'image'].includes(target ?? '')) {
        throw new VibeError('INVALID_ARGUMENT', 'Use document list, read, create, edit, delete or image.');
      }
      if (command === 'folder' && !['list', 'create', 'rename', 'move', 'delete'].includes(target ?? '')) {
        throw new VibeError('INVALID_ARGUMENT', 'Use folder list, create, rename, move or delete.');
      }
      if (command === 'move' && target !== 'table' && target !== 'document') {
        throw new VibeError('INVALID_ARGUMENT', 'Use move <table|document> <name> --folder <path>.');
      }
      if (values['dry-run'] && command !== 'edit' && command !== 'apply' && !planWrite && !documentWrite && !folderWrite && command !== 'rename') {
        throw new VibeError('INVALID_ARGUMENT', '--dry-run is available for edit, apply, document/folder writes, move, rename and plan create/variant/status/approve.');
      }
      const expectedArguments = command === 'plan' || command === 'document' || command === 'folder' ? (target === 'list' ? 2 : 3) : command === 'source' ? 3 : command === 'import' ? (target === 'apply' ? 2 : 3) :
        command === 'rename' || command === 'move' ? 3 : needsTarget ? 2 : 1;
      if (positionals.length !== expectedArguments || needsTarget && !target) {
        throw new VibeError('INVALID_ARGUMENT', 'Unexpected or missing arguments for ' + command + '. Use --help.');
      }
      if (values.folder !== undefined && command !== 'move' && !(command === 'folder' && target === 'move')
        && !(command === 'document' && target === 'create') && command !== 'edit') {
        throw new VibeError('INVALID_ARGUMENT', '--folder is available for move, folder move, document create and edit table-create.');
      }
      if (command === 'folder' || command === 'move') {
        if (values.input !== undefined || values.to !== undefined && !(command === 'folder' && target === 'rename')
          || values['expect-revision'] !== undefined && !folderWrite) {
          throw new VibeError('INVALID_ARGUMENT', 'Unexpected option for ' + command + '. Use --help.');
        }
      }
      if (values.check && command !== 'fmt') {
        throw new VibeError('INVALID_ARGUMENT', '--check is only available for fmt.');
      }
      if (values.output !== undefined && command !== 'export') {
        throw new VibeError('INVALID_ARGUMENT', '--output is only available for export.');
      }
      if (values.mapping !== undefined && !(command === 'import' && target === 'plan')) {
        throw new VibeError('INVALID_ARGUMENT', '--mapping is only available for import plan.');
      }
      if (values.reason !== undefined && command !== 'save') {
        throw new VibeError('INVALID_ARGUMENT', '--reason is only available for save.');
      }
      if (values.resolve !== undefined && command !== 'pull') {
        throw new VibeError('INVALID_ARGUMENT', '--resolve is only available for pull.');
      }
      if (values.target !== undefined && command !== 'read' && command !== 'document' && !baselineWrite && !folderWrite) {
        throw new VibeError('INVALID_ARGUMENT', '--target is available for read, document, edit, apply, rename, folder writes, move and import apply.');
      }
      if ((baselineWrite || command === 'document' || folderWrite) && selectedTarget !== 'base') {
        throw new VibeError('INVALID_ARGUMENT', 'Use --target base here; write alternatives with plan variant <plan>/<variant>.');
      }
      if ((documentWrite || documentRename || folderWrite) && values.target === undefined) {
        selectedTarget = undefined;
        throw new VibeError('TARGET_REQUIRED', 'Document and folder/move writes require --target base.');
      }
      if (command === 'read' && selectedTarget !== 'base') variantTarget(selectedTarget!);
      if (command === 'document') {
        if (values.input !== undefined && target !== 'create' && target !== 'edit') {
          throw new VibeError('INVALID_ARGUMENT', '--input is available for document create and document edit.');
        }
        if (values.to !== undefined || values['expect-revision'] !== undefined && !documentWrite) {
          throw new VibeError('INVALID_ARGUMENT', 'Unexpected option for document ' + target + '. Use --help.');
        }
      }
      if (command === 'plan') {
        if (values.input !== undefined && target !== 'create' && target !== 'variant') {
          throw new VibeError('INVALID_ARGUMENT', '--input is available for plan create and plan variant.');
        }
        if (values.to !== undefined && target !== 'status') {
          throw new VibeError('INVALID_ARGUMENT', '--to is available for plan status.');
        }
        if (target === 'variant' || target === 'approve') variantTarget(positionals[2]!);
      }
      if (command === 'init') {
        if (values.project !== undefined) {
          throw new VibeError('INVALID_ARGUMENT', 'init takes its destination as <folder>, without --project.');
        }
        project = await initProject(resolve(target!));
        data = { root: project.root };
      } else if (command === 'import' && target === 'inspect') {
        data = await inspectImport(resolve(positionals[2]!));
      } else if (command === 'source') {
        data = await inspectSource(positionals[2]!);
      } else if (isGitCommand) {
        gitRoot = await resolveProjectRoot(process.cwd(), values.project);
        if (command === 'status') {
          gitStatus = await getGitStatus(gitRoot);
          data = gitStatus;
          project = await loadProject(gitRoot);
        } else {
          let result: GitResult;
          if (command === 'save') {
            if (values.reason === undefined) throw new VibeError('INVALID_ARGUMENT', 'Supply --reason <text>.');
            result = await saveProject(gitRoot, values.reason, values['expect-revision']);
          } else if (command === 'push') {
            result = await pushProject(gitRoot);
          } else if (values.resolve !== undefined) {
            if (!values['expect-revision']) throw new VibeError('REVISION_REQUIRED', 'Supply --expect-revision from status.');
            const choices = await readJson(values.resolve) as GitChoice[];
            result = await resolveProject(gitRoot, values['expect-revision'], choices);
          } else {
            result = await pullProject(gitRoot);
          }
          data = result;
          gitStatus = result.status;
          diagnostics = result.diagnostics;
          if (!result.completed) status = 1;
        }
      } else {
        project = await loadProject(await resolveProjectRoot(process.cwd(), values.project));
        if (command === 'read') {
          const view = selectedTarget === 'base' ? project : readVariant(project, ...variantTarget(selectedTarget!));
          data = readPath(view, target!);
        }
        if (command === 'folder' && target === 'list') data = listFolders(project);
        if (folderWrite) {
          const revision = values['expect-revision'];
          if (!revision) throw new VibeError('REVISION_REQUIRED', 'Supply --expect-revision from read or validate.');
          const path = positionals[2]!;
          let operation: FolderOperation;
          if (command === 'move' || target === 'move') {
            if (values.folder === undefined) throw new VibeError('INVALID_ARGUMENT', 'Supply --folder <path>; use an empty string for the top level.');
            operation = command === 'move'
              ? { op: 'resource-move', kind: target as 'table' | 'document', name: path, folder: values.folder }
              : { op: 'folder-move', path, folder: values.folder };
          } else if (target === 'rename') {
            if (!values.to) throw new VibeError('INVALID_ARGUMENT', 'Supply --to <name>.');
            operation = { op: 'folder-rename', path, name: values.to };
          } else operation = { op: target === 'create' ? 'folder-create' : 'folder-delete', path };
          const result = await applyFolderEdit(project.root, revision, operation, { dryRun: values['dry-run'] ?? false });
          project = result.project;
          data = writeData(result, values['dry-run'] ?? false);
          diagnostics = result.diagnostics;
        }
        if (command === 'document') {
          if (target === 'list') data = listDocuments(project);
          else if (target === 'read') data = getDocumentView(project, positionals[2]!);
          else {
            const revision = values['expect-revision'];
            if (!revision) throw new VibeError('REVISION_REQUIRED', 'Supply --expect-revision from document read or validate.');
            const options = { dryRun: values['dry-run'] ?? false };
            if (target === 'image') {
              data = await addDocumentImage(project.root, revision, resolve(positionals[2]!), options);
              project = await loadProject(project.root);
              diagnostics = validateProject(project);
            } else {
              let result: WriteResult;
              if (target === 'delete') {
                result = await deleteDocument(project.root, revision, positionals[2]!, options);
              } else {
                if (!values.input) throw new VibeError('INVALID_ARGUMENT', 'Supply --input <' + (target === 'create' ? 'markdown-file' : 'operations-json') + '>.');
                if (target === 'create') {
                  // Preserve the BOM and reject invalid UTF-8 instead of replacing source bytes.
                  const markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(values.input));
                  result = await createDocument(project.root, revision, positionals[2]!, markdown, { ...options, ...(values.folder !== undefined ? { folder: values.folder } : {}) });
                } else {
                  result = await editDocument(project.root, revision, positionals[2]!, await readJson(values.input) as DocumentOperation[], options);
                }
              }
              project = result.project;
              data = writeData(result, options.dryRun);
              diagnostics = result.diagnostics;
            }
          }
        }
        if (command === 'plan') {
          if (target === 'list') data = listPlans(project);
          else if (target === 'read') data = getPlan(project, positionals[2]!);
          else {
            const revision = values['expect-revision'];
            if (!revision) throw new VibeError('REVISION_REQUIRED', 'Supply --expect-revision from read.');
            const options = { dryRun: values['dry-run'] ?? false };
            let result: WriteResult;
            if (target === 'create' || target === 'variant') {
              if (!values.input) throw new VibeError('INVALID_ARGUMENT', 'Supply --input <json-file>.');
              const input = await readJson(values.input);
              result = target === 'create'
                ? await createPlan(project.root, revision, positionals[2]!, input as PlanDefinition, options)
                : await writeVariant(project.root, revision, ...variantTarget(positionals[2]!), input as VariantInput, options);
            } else if (target === 'status') {
              if (values.to !== 'draft' && values.to !== 'review') throw new VibeError('INVALID_ARGUMENT', 'Supply --to draft|review; approve a selected variant with plan approve.');
              result = await setPlanStatus(project.root, revision, positionals[2]!, values.to, options);
            } else {
              result = await approvePlan(project.root, revision, ...variantTarget(positionals[2]!), options);
            }
            project = result.project;
            data = writeData(result, options.dryRun);
            diagnostics = result.diagnostics;
          }
        }
        if (command === 'where-used') data = await whereUsed(project, target!);
        if (command === 'export') {
          const result = await exportMarkdown(project, values.output);
          data = result;
          diagnostics = result.diagnostics;
        }
        if (command === 'import' && target === 'plan') {
          if (!values.mapping) throw new VibeError('INVALID_ARGUMENT', 'Supply --mapping <mapping-json>.');
          const mapping = await readJson(values.mapping) as ImportMapping;
          const inspection = await inspectImport(resolve(positionals[2]!));
          const plan = planImport(project, inspection, mapping);
          data = plan;
          diagnostics = plan.diagnostics;
          if (!plan.canApply) status = 1;
        }
        if (baselineWrite) {
          if (values.target === undefined && [...project.sources.keys()].some(path => path.startsWith('plans/'))) {
            selectedTarget = undefined;
            throw new VibeError('TARGET_REQUIRED', 'Plans exist. Supply --target base to edit the baseline, or use plan variant <plan>/<variant>.');
          }
          if (!values['expect-revision']) throw new VibeError('REVISION_REQUIRED', 'Supply --expect-revision from read.');
          let result: WriteResult;
          if (command === 'rename') {
            if (!values.to) throw new VibeError('INVALID_ARGUMENT', 'Supply --to <name>.');
            result = await renameResource(project.root, values['expect-revision'], target as RenameKind, positionals[2]!, values.to, { dryRun: values['dry-run'] ?? false });
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
              const plan = typeof input === 'object' && input !== null && 'data' in input ? input.data : input;
              result = await applyImport(project.root, values['expect-revision'], plan as ImportPlan);
            } else if (command === 'edit') {
              result = await editProject(project.root, values['expect-revision'], input, { dryRun: values['dry-run'] ?? false });
            } else {
              result = await applyEdits(project.root, values['expect-revision'], input as EditOperation[], { dryRun: values['dry-run'] ?? false });
            }
          }
          project = result.project;
          data = writeData(result, values['dry-run'] ?? false);
          diagnostics = result.diagnostics;
        }
        if (command === 'fmt') {
          const formatted = formattedSources(project);
          const changed = [...formatted].filter(([path, source]) => source !== project!.sources.get(path))
            .map(([path]) => path);
          if (values.check) {
            data = { changed };
            if (changed.length) status = 1;
          } else {
            data = { changed: await writeChanges(project, formatted) };
            project = await loadProject(project.root);
          }
        }
      }
      if (project && command !== 'export' && !(command === 'import' && target === 'plan') && !values['dry-run']) diagnostics = validateProject(project);
      if (diagnostics.some(item => item.severity !== 'warning')) status = 1;
    }
  } catch (error) {
    status = 2;
    failure = {
      code: error instanceof VibeError ? error.code :
        (error as NodeJS.ErrnoException).code ?? 'COMMAND_FAILED',
      message: error instanceof Error ? error.message : String(error),
    };
    if (gitAction) {
      // Command failure must not look like a successful local save or remote upload.
      if (gitRoot) {
        try {
          gitStatus = await getGitStatus(gitRoot);
          project = await loadProject(gitRoot);
        } catch { /* Keep the command error even if Git status is unavailable. */ }
      }
      data = { action: gitAction, completed: false, ...(gitStatus ? { status: gitStatus } : {}) };
    } else if (isWrite || args.some(arg => ['edit', 'apply', 'rename'].includes(arg))) {
      const written = error instanceof VibeError ? error.written : [];
      data = { applied: written.length > 0, changed: written, ...(written.length ? { partial: true } : {}) };
    }
    // On a partial file-write failure, report the current revision if it can be read.
    if (project) {
      try { project = await loadProject(project.root); }
      catch { /* Keep the last readable revision; the operation error remains primary. */ }
      diagnostics = validateProject(project);
    }
    if (error instanceof VibeError) {
      diagnostics = [...diagnostics, ...error.diagnostics.filter(item => !diagnostics.some(existing =>
        existing.code === item.code && existing.file === item.file && existing.path === item.path))];
    }
  }

  const result = { ok: status === 0, revision: gitStatus?.revision ?? project?.revision ?? null, data, diagnostics,
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
