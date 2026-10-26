import { folderStorage } from './folder-names.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Diagnostic, Project, Table } from './types.js';
import { isRecord, VibeError } from './types.js';
import { resourceNameError, resourceNameKey } from './names.js';
import { validateProject } from './validation.js';
import { getTableView } from './view.js';
import { replaceFile } from './file-replacement.js';
import { folderError, resourceEntries, resourceFile } from './resources.js';

export interface MarkdownExport {
  directory: string;
  files: string[];
  revision: string;
  diagnostics: Diagnostic[];
}

async function status(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

// Resolve existing parent links too, including the platform's /tmp or /var aliases.
async function canonicalDirectory(path: string): Promise<string> {
  const entry = await status(path);
  if (entry) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new VibeError('EXPORT_PATH', 'Export output must be a directory, not a file or symbolic link: ' + path);
    return realpath(path);
  }
  const parent = dirname(path);
  try { return join(await realpath(parent), basename(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await canonicalDirectory(parent), basename(path));
  }
}

function within(parent: string, child: string): boolean {
  const path = relative(resourceNameKey(parent), resourceNameKey(child));
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
}

async function outputDirectory(project: Project, output?: string): Promise<{ root: string; directory: string }> {
  let selected = output;
  if (selected === undefined) {
    let source: string | undefined;
    try { source = await readFile(join(project.root, '.vibe-spec.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (source !== undefined) {
      let config: unknown;
      try { config = JSON.parse(source.replace(/^\uFEFF/, '')); }
      catch { throw new VibeError('CONFIG_INVALID', 'Cannot read .vibe-spec.json for export_directory.'); }
      if (!isRecord(config)) throw new VibeError('CONFIG_INVALID', 'Expected an object in .vibe-spec.json.');
      if (Object.hasOwn(config, 'export_directory')) {
        if (typeof config.export_directory !== 'string' || !config.export_directory.trim()) {
          throw new VibeError('CONFIG_INVALID', 'export_directory must be a nonempty string.');
        }
        selected = config.export_directory;
      }
    }
  }
  if (selected !== undefined && (typeof selected !== 'string' || !selected.trim())) {
    throw new VibeError('EXPORT_PATH', 'Export output must be a nonempty directory path.');
  }
  const root = await realpath(project.root);
  const requested = resolve(root, selected ?? '.vibe-spec-export');
  const directory = await canonicalDirectory(requested);
  // An ancestor's .gitignore would also affect the source project.
  if (within(directory, root)) throw new VibeError('EXPORT_PATH', 'Export output cannot be the planning root or its ancestor.');
  for (const name of ['schemas', 'tables', 'documents', 'plans', 'imports', '.git']) {
    const protectedPath = join(root, name);
    let actual = protectedPath;
    try { actual = await realpath(protectedPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (within(protectedPath, requested) || within(actual, directory)) {
      throw new VibeError('EXPORT_PATH', 'Export output cannot be inside source or Git directories: ' + directory);
    }
  }
  // A planning folder can live below the repository root.
  if (directory.split(sep).some(part => resourceNameKey(part) === '.git')) {
    throw new VibeError('EXPORT_PATH', 'Export output cannot be inside a Git directory.');
  }
  return { root, directory };
}

/** Escape cell text before adding our own line breaks; source HTML is never emitted. */
function text(value: string): string {
  return value.replace(/[&<>|\\`*_[\]~\r\n]/g, character => {
    if (character === '\r') return '&#13;';
    if (character === '\n') return '<br>';
    return '&#' + character.charCodeAt(0) + ';';
  });
}

function cell(value: unknown): string {
  if (value === undefined) return '<em>missing</em>';
  if (value === null) return '<em>null</em>';
  if (value === '') return '<em>empty string</em>';
  return text(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value));
}

function row(values: string[]): string { return '| ' + values.join(' | ') + ' |'; }

function markdown(project: Project, name: string, marker: string, totalErrors: number): string {
  const view = getTableView(project, name);
  const table = project.files.get(resourceFile(project, 'table', name)!)!.data as Table;
  const declared = view.columnOrder;
  const extra = [...new Set(view.rows.flatMap(item => Object.keys(item).filter(code => !Object.hasOwn(view.schema.columns, code))))];
  const columns = [...declared, ...extra];
  const lines = [marker, '', '# ' + text(name), '',
    'Generated from YAML. Edit the source with vibe-spec, then export again.', '',
    'Source revision: ' + text(project.revision), '',
    'Escaping: pipes and Markdown/HTML metacharacters use numeric HTML entities; LF uses `<br>`, CR uses `&#13;`.', '',
    'Validation errors: ' + view.diagnostics.length + ' in this table/schema; ' + totalErrors + ' in the project.', '',
    'For exact values, use `vibe read <table> --json --project <planning-root>`. Markdown is a reading view; ' +
      'empty strings, null and missing fields are labeled below. JSON preserves their exact distinctions, whitespace and types.', '',
    '## Schema', '', 'Schema: ' + text(table.schema), '',
    row(['Code', 'Label', 'Type', 'Required', 'Enum', 'Ref', 'Key']), row(Array<string>(7).fill('---'))];
  for (const code of declared) {
    const column = view.schema.columns[code]!;
    const key = code === view.schema.primary_key;
    lines.push(row([text(code), cell(column.label), text(column.type), String(key || column.required === true),
      column.values ? cell(column.values) : '', column.table === undefined ? '' : text(column.table) +
        (column.on_delete ? ' (on_delete: ' + text(column.on_delete) + ')' : ''), key ? 'yes' : '']));
  }
  if (extra.length) lines.push('', 'Undeclared columns (included in the rows): ' + extra.map(text).join(', ') + '.');
  lines.push('', '## Rows', '', 'Rows: ' + view.rows.length, '', row(columns.map(text)), row(columns.map(() => '---')));
  for (const item of view.rows) lines.push(row(columns.map(code => cell(Object.hasOwn(item, code) ? item[code] : undefined))));
  return lines.join('\n') + '\n';
}

async function existingFile(path: string): Promise<string | undefined> {
  const entry = await status(path);
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new VibeError('EXPORT_CONFLICT', 'Export will not replace a non-regular file or symbolic link: ' + path);
  return readFile(path, 'utf8');
}

function generated(source: string, marker: string): boolean { return source.split(/\r?\n/, 1)[0] === marker; }

export async function exportMarkdown(project: Project, output?: string): Promise<MarkdownExport> {
  const diagnostics = validateProject(project);
  const unreadable = [...project.sources.keys()].some(file => file.endsWith('.yaml') && !project.files.has(file));
  if (unreadable || diagnostics.some(item => ['YAML_SYNTAX', 'YAML_UNSUPPORTED', 'SCHEMA_SHAPE', 'SCHEMA_RULE', 'TABLE_SHAPE', 'SCHEMA_MISSING'].includes(item.code))) {
    throw new VibeError('EXPORT_UNREADABLE', 'Repair unreadable YAML, schemas or table structure before exporting.', diagnostics);
  }
  const { root, directory } = await outputDirectory(project, output);
  const marker = '<!-- vibe-spec markdown export v1; project: ' + createHash('sha256').update(root).digest('hex') + ' -->';
  const tables = resourceEntries(project, 'table').sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const wanted = new Map<string, string>();
  const identities = new Set<string>();
  for (const { name, folder } of tables) {
    const error = resourceNameError(name) ?? folderError(folder);
    if (error || identities.has(resourceNameKey(name))) throw new VibeError('EXPORT_NAME', error ?? 'Table names collide as export filenames.', diagnostics);
    identities.add(resourceNameKey(name));
  }
  for (const { name, folder } of tables) {
    wanted.set((folder ? folderStorage(project, folder) + '/' : '') + name + '.md', markdown(project, name, marker, diagnostics.length));
  }
  const ignore = join(directory, '.gitignore');
  const ignoreSource = await existingFile(ignore); // Preserve an existing output ignore file byte-for-byte.
  const existing = new Map<string, string>();
  const stale = new Map<string, string>();
  const destinationKeys = new Set([...wanted.keys()].map(resourceNameKey));
  const wantedDirectories = new Map<string, string>();
  for (const file of wanted.keys()) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/'), key = resourceNameKey(folder);
      if (destinationKeys.has(key) || key === '.gitignore') {
        throw new VibeError('EXPORT_NAME', 'An export directory collides with an output file: ' + folder, diagnostics);
      }
      if (wantedDirectories.has(key) && wantedDirectories.get(key) !== folder) {
        throw new VibeError('EXPORT_NAME', 'Table folders collide as export directories.', diagnostics);
      }
      wantedDirectories.set(key, folder);
    }
  }
  // Inspect every destination and cleanup candidate before making any changes.
  const inspect = async (folder = ''): Promise<void> => {
    let entries;
    try { entries = await readdir(join(directory, folder), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = (folder ? folder + '/' : '') + entry.name, path = join(directory, file);
      const wantedFolder = wantedDirectories.get(resourceNameKey(file));
      if (wantedFolder !== undefined && (wantedFolder !== file || !entry.isDirectory() || entry.isSymbolicLink())) {
        throw new VibeError('EXPORT_CONFLICT', 'Export directory is occupied or has a different spelling: ' + path);
      }
      if (entry.isDirectory() && !destinationKeys.has(resourceNameKey(file))) { await inspect(file); continue; }
      if (!file.toLowerCase().endsWith('.md')) continue;
      const source = await existingFile(path);
      if (source === undefined) continue;
      if (generated(source, marker)) {
        if (wanted.has(file)) existing.set(file, source);
        else stale.set(file, source);
      } else if (destinationKeys.has(resourceNameKey(file))) {
        throw new VibeError('EXPORT_CONFLICT', 'Export will not overwrite a file it did not generate for this project: ' + path);
      }
    }
  };
  await inspect();
  // Recheck the output directory before creating it; a replaced symlink must not redirect writes.
  if (await canonicalDirectory(directory) !== directory) throw new VibeError('EXPORT_PATH', 'Export directory changed during preparation.');
  await mkdir(directory, { recursive: true });
  if (ignoreSource === undefined) {
    const handle = await open(ignore, 'wx');
    try { await handle.writeFile('*\n', 'utf8'); } finally { await handle.close(); }
  } else if (await existingFile(ignore) !== ignoreSource) {
    throw new VibeError('EXPORT_CONFLICT', 'Output .gitignore changed during preparation.');
  }
  for (const [file, source] of stale) {
    const path = join(directory, file);
    if (await canonicalDirectory(dirname(path)) !== dirname(path)) throw new VibeError('EXPORT_PATH', 'Export parent changed during preparation: ' + path);
    if (await existingFile(path) !== source) throw new VibeError('EXPORT_CONFLICT', 'Generated file changed during preparation: ' + path);
    await rm(path);
  }
  for (const [file, source] of wanted) {
    const path = join(directory, file), previous = existing.get(file);
    const parent = dirname(path);
    if (await canonicalDirectory(parent) !== parent) throw new VibeError('EXPORT_PATH', 'Export parent changed during preparation: ' + parent);
    await mkdir(parent, { recursive: true });
    if (await existingFile(path) !== previous) throw new VibeError('EXPORT_CONFLICT', 'Export destination changed during preparation: ' + path);
    if (source === previous) continue;
    const temporary = join(parent, '.vibe-export-' + randomUUID() + '.tmp');
    const handle = await open(temporary, 'wx');
    try {
      try { await handle.writeFile(source, 'utf8'); } finally { await handle.close(); }
      await replaceFile(temporary, path, async () => {
        if (await existingFile(path) !== previous) throw new VibeError('EXPORT_CONFLICT', 'Export destination changed before replacement: ' + path);
      });
    } finally { await rm(temporary, { force: true }); }
  }
  return { directory, files: [...wanted.keys()], revision: project.revision, diagnostics };
}
