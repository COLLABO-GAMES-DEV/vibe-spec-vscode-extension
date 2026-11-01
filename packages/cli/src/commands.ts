import { parseArgs } from 'node:util';
import { resourceNameError, VibeError } from '@vibe-spec/core';

const options = {
  project: { type: 'string' }, json: { type: 'boolean' },
  help: { type: 'boolean' }, check: { type: 'boolean' },
  input: { type: 'string' }, to: { type: 'string' }, 'expect-revision': { type: 'string' },
  mapping: { type: 'string' }, reason: { type: 'string' }, resolve: { type: 'string' },
  output: { type: 'string' }, 'dry-run': { type: 'boolean' },
  target: { type: 'string' }, folder: { type: 'string' },
} as const;
export const parseCommandLine = (args: string[]) => parseArgs({ args, allowPositionals: true, strict: true, options });
export type Values = ReturnType<typeof parseCommandLine>['values'];

interface CommandSpec {
  /** Allowed second words and the error shown for anything else. */
  subcommands?: { names: readonly string[]; error: string };
  /** Positional count including the command itself. */
  arity: (sub: string | undefined) => number;
  /** The second positional must be a nonempty value. */
  needsTarget?: boolean;
}
const listOr = (list: number, other: number) => (sub: string | undefined) => sub === 'list' ? list : other;
const commands = {
  init: { arity: () => 2, needsTarget: true },
  read: { arity: () => 2, needsTarget: true },
  document: { subcommands: { names: ['list', 'read', 'create', 'edit', 'delete', 'image'], error: 'Use document list, read, create, edit, delete or image.' }, arity: listOr(2, 3) },
  folder: { subcommands: { names: ['list', 'create', 'rename', 'move', 'delete'], error: 'Use folder list, create, rename, move or delete.' }, arity: listOr(2, 3) },
  move: { subcommands: { names: ['table', 'document'], error: 'Use move <table|document> <name> --folder <path>.' }, arity: () => 3 },
  plan: { subcommands: { names: ['list', 'read', 'create', 'variant', 'status', 'approve'], error: 'Use plan list, read, create, variant, status or approve.' }, arity: listOr(2, 3) },
  validate: { arity: () => 1 },
  fmt: { arity: () => 1 },
  export: { arity: () => 1 },
  edit: { arity: () => 1 },
  apply: { arity: () => 1 },
  rename: { arity: () => 3 },
  'where-used': { arity: () => 2, needsTarget: true },
  import: { subcommands: { names: ['inspect', 'plan', 'apply'], error: 'Use import inspect, plan or apply.' }, arity: sub => sub === 'apply' ? 2 : 3 },
  source: { subcommands: { names: ['inspect'], error: 'Use source inspect <file>.' }, arity: () => 3 },
  status: { arity: () => 1 },
  save: { arity: () => 1 },
  push: { arity: () => 1 },
  pull: { arity: () => 1 },
} as const satisfies Record<string, CommandSpec>;
export type CommandName = keyof typeof commands;
export const isCommand = (value: string | undefined): value is CommandName => value !== undefined && Object.hasOwn(commands, value);

const variantTargetInvalid = (value: string) => {
  const parts = value.split('/');
  return parts.length !== 2 || parts.some(part => resourceNameError(part));
};
export function variantTarget(value: string): [string, string] {
  if (variantTargetInvalid(value)) throw new VibeError('INVALID_ARGUMENT', 'Supply a target as <plan>/<variant>.');
  const [plan, variant] = value.split('/');
  return [plan!, variant!];
}

/** One parsed command line, classified before validation so failures still report the target. */
export interface Invocation {
  command: string | undefined;
  sub: string | undefined;
  positionals: string[];
  values: Values;
  baselineWrite: boolean;
  planWrite: boolean;
  documentWrite: boolean;
  documentRename: boolean;
  folderWrite: boolean;
  /** base or <plan>/<variant> for read/write targets; plan name for plan commands. */
  selectedTarget: string | undefined;
}
export function classify(values: Values, positionals: string[]): Invocation {
  const [command, sub] = positionals;
  const baselineWrite = command === 'edit' || command === 'apply' || command === 'rename' || command === 'import' && sub === 'apply';
  const planWrite = command === 'plan' && ['create', 'variant', 'status', 'approve'].includes(sub ?? '');
  const documentWrite = command === 'document' && ['create', 'edit', 'delete', 'image'].includes(sub ?? '');
  const documentRename = command === 'rename' && ['document', 'heading', 'tag'].includes(sub ?? '');
  const folderWrite = command === 'move' || command === 'folder' && ['create', 'rename', 'move', 'delete'].includes(sub ?? '');
  let selectedTarget: string | undefined;
  if (command === 'read' || command === 'document' || baselineWrite || folderWrite) selectedTarget = values.target ?? 'base';
  if (command === 'plan' && sub !== 'list') selectedTarget = positionals[2];
  return { command, sub, positionals, values, baselineWrite, planWrite, documentWrite, documentRename, folderWrite, selectedTarget };
}
export const isWrite = (inv: Invocation) => inv.baselineWrite || inv.planWrite || inv.documentWrite || inv.folderWrite;

interface Rule {
  violated(inv: Invocation): boolean;
  message: string | ((inv: Invocation) => string);
  /** TARGET_REQUIRED failures omit the defaulted target from the result. */
  code?: 'TARGET_REQUIRED';
}
const dryRunRule: Rule = {
  violated: ({ command, values, planWrite, documentWrite, folderWrite }) => values['dry-run'] === true
    && command !== 'edit' && command !== 'apply' && !planWrite && !documentWrite && !folderWrite && command !== 'rename',
  message: '--dry-run is available for edit, apply, document/folder writes, move, rename and plan create/variant/status/approve.',
};
/** Checked in this order; the first violation is the reported error. */
const optionRules: Rule[] = [
  { violated: ({ command, sub, values }) => values.folder !== undefined && command !== 'move' && !(command === 'folder' && sub === 'move')
      && !(command === 'document' && sub === 'create') && command !== 'edit',
    message: '--folder is available for move, folder move, document create and edit table-create.' },
  { violated: ({ command, sub, values, folderWrite }) => (command === 'folder' || command === 'move') && (values.input !== undefined
      || values.to !== undefined && !(command === 'folder' && sub === 'rename') || values['expect-revision'] !== undefined && !folderWrite),
    message: ({ command }) => 'Unexpected option for ' + command + '. Use --help.' },
  { violated: ({ command, values }) => values.check === true && command !== 'fmt', message: '--check is only available for fmt.' },
  { violated: ({ command, values }) => values.output !== undefined && command !== 'export', message: '--output is only available for export.' },
  { violated: ({ command, sub, values }) => values.mapping !== undefined && !(command === 'import' && sub === 'plan'), message: '--mapping is only available for import plan.' },
  { violated: ({ command, values }) => values.reason !== undefined && command !== 'save', message: '--reason is only available for save.' },
  { violated: ({ command, values }) => values.resolve !== undefined && command !== 'pull', message: '--resolve is only available for pull.' },
  { violated: ({ command, values, baselineWrite, folderWrite }) => values.target !== undefined && command !== 'read' && command !== 'document' && !baselineWrite && !folderWrite,
    message: '--target is available for read, document, edit, apply, rename, folder writes, move and import apply.' },
  { violated: ({ command, sub, baselineWrite, folderWrite, selectedTarget }) =>
      (baselineWrite || command === 'document' && sub !== 'read' && sub !== 'edit' || folderWrite) && selectedTarget !== 'base',
    message: 'Use --target base here; write alternatives with plan variant <plan>/<variant>.' },
  { violated: ({ values, documentWrite, documentRename, folderWrite }) => (documentWrite || documentRename || folderWrite) && values.target === undefined,
    message: 'Document and folder/move writes require --target base.', code: 'TARGET_REQUIRED' },
  { violated: ({ command, selectedTarget }) => command === 'read' && selectedTarget !== 'base' && variantTargetInvalid(selectedTarget!),
    message: 'Supply a target as <plan>/<variant>.' },
  { violated: ({ command, sub, values }) => command === 'document' && values.input !== undefined && sub !== 'create' && sub !== 'edit',
    message: '--input is available for document create and document edit.' },
  { violated: ({ command, values, documentWrite }) => command === 'document' && (values.to !== undefined || values['expect-revision'] !== undefined && !documentWrite),
    message: ({ sub }) => 'Unexpected option for document ' + sub + '. Use --help.' },
  { violated: ({ command, sub, values }) => command === 'plan' && values.input !== undefined && sub !== 'create' && sub !== 'variant',
    message: '--input is available for plan create and plan variant.' },
  { violated: ({ command, sub, values }) => command === 'plan' && values.to !== undefined && sub !== 'status', message: '--to is available for plan status.' },
  { violated: ({ command, sub, positionals }) => command === 'plan' && (sub === 'variant' || sub === 'approve') && variantTargetInvalid(positionals[2]!),
    message: 'Supply a target as <plan>/<variant>.' },
];

function enforce(rule: Rule, inv: Invocation) {
  if (!rule.violated(inv)) return;
  const message = typeof rule.message === 'string' ? rule.message : rule.message(inv);
  if (rule.code === 'TARGET_REQUIRED') inv.selectedTarget = undefined;
  throw new VibeError(rule.code ?? 'INVALID_ARGUMENT', message);
}

/** Validates the command line before any file is read; narrows the command name. */
export function validateInvocation(inv: Invocation): CommandName {
  const { command, sub, positionals } = inv;
  if (!isCommand(command)) throw new VibeError('INVALID_ARGUMENT', 'Unknown command. Use --help.');
  const spec: CommandSpec = commands[command];
  if (spec.subcommands && !spec.subcommands.names.includes(sub ?? '')) throw new VibeError('INVALID_ARGUMENT', spec.subcommands.error);
  enforce(dryRunRule, inv);
  if (positionals.length !== spec.arity(sub) || spec.needsTarget && !sub) {
    throw new VibeError('INVALID_ARGUMENT', 'Unexpected or missing arguments for ' + command + '. Use --help.');
  }
  for (const rule of optionRules) enforce(rule, inv);
  return command;
}
