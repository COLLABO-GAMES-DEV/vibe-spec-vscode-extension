import { folderAddress } from './folder-names.js';
import { pathParts, canonicalPath } from './paths.js';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { VibeError, isRecord } from './types.js';
import type { Diagnostic, MutationOptions, Project, YamlFile } from './types.js';
import { formatYaml, parseYaml } from './yaml.js';
import { tableContexts, validateProject } from './validation.js';
import { resourceNameError, resourceNameKey, suggestResourceName } from './names.js';
import { resourceEntry, resourceFile, folderError } from './resources.js';
import { planningAgentInstructions } from './agents.js';
import { planningImportSkill } from './import-skill.js';
import { readDocumentPath } from './documents.js';
import { removeEmptyDirectory, replaceFile, temporarySibling } from './file-replacement.js';

async function sourceAt(path: string): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path));
}

export async function resolveProjectRoot(start: string, explicit?: string): Promise<string> {
  if (explicit !== undefined) return resolve(start, explicit);
  let folder = resolve(start);
  for (;;) {
    let source: string;
    try {
      source = await sourceAt(join(folder, '.vibe-spec.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(folder);
      if (parent === folder) throw new VibeError('PROJECT_NOT_FOUND', 'Use --project or run init first.');
      folder = parent;
      continue;
    }
    let config: unknown;
    try { config = JSON.parse(source.replace(/^\uFEFF/, '')); }
    catch { throw new VibeError('CONFIG_INVALID', 'Invalid .vibe-spec.json in ' + folder); }
    if (!isRecord(config) || typeof config.planning_root !== 'string' || !config.planning_root) {
      throw new VibeError('CONFIG_INVALID', 'planning_root must be a nonempty string.');
    }
    return resolve(folder, config.planning_root);
  }
}

async function hasPlanningRootMarker(root: string): Promise<boolean> {
  try {
    const config: unknown = JSON.parse((await sourceAt(join(root, '.vibe-spec.json'))).replace(/^\uFEFF/, ''));
    return isRecord(config) && typeof config.planning_root === 'string' && config.planning_root.length > 0 &&
      resolve(root, config.planning_root) === root;
  } catch { return false; }
}

export async function loadProject(root: string): Promise<Project> {
  return readProject(root);
}

// Reuse parsed files only within a write operation, after reading their actual
// bytes again. There is no persistent cache and revision checks still see disk.
async function readProject(root: string, previous?: Project): Promise<Project> {
  root = resolve(root);
  const sources = new Map<string, string>();
  const files = new Map<string, YamlFile>();
  const assets = new Map<string, Uint8Array>();
  const diagnostics: Diagnostic[] = [];
  const parsed = (file: string, source: string) => {
    const cached = previous?.root === root ? previous.files.get(file) : undefined;
    if (cached?.source === source) { files.set(file, cached); return; }
    try { files.set(file, parseYaml(source, file)); }
    catch (error) {
      if (!(error instanceof VibeError)) throw error;
      diagnostics.push(...error.diagnostics);
    }
  };
  const directories: string[] = [];
  let marked: boolean | undefined;
  async function directoryEntries(directory: string) {
    if ((await lstat(join(root, directory))).isSymbolicLink()) throw new VibeError('FILE_UNSUPPORTED', 'Managed folders cannot be symbolic links: ' + directory);
    return readdir(join(root, directory), { withFileTypes: true });
  }
  async function readDirectory(directory: string, existing?: Awaited<ReturnType<typeof directoryEntries>>): Promise<void> {
    const entries = existing ?? await directoryEntries(directory);
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = directory + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new VibeError('FILE_UNSUPPORTED', 'Managed folders cannot contain symbolic links: ' + file);
      if (entry.isDirectory()) {
        if (file === 'documents/assets') continue;
        directories.push(file);
        await readDirectory(file);
        continue;
      }
      const resource = resourceEntry(file);
      if (!resource && entry.name !== '.gitkeep') continue;
      if (!entry.isFile()) throw new VibeError('FILE_UNSUPPORTED', 'Expected a regular file: ' + file);
      const source = await sourceAt(join(root, file));
      sources.set(file, source);
      if (resource && resource.kind !== 'document') parsed(file, source);
    }
  }
  for (const directory of ['schemas', 'tables', 'documents']) {
    let entries: Awaited<ReturnType<typeof directoryEntries>>;
    try { entries = await directoryEntries(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (directory === 'documents' || (marked ??= await hasPlanningRootMarker(root)))) continue;
      if (error instanceof VibeError) throw error;
      throw new VibeError('PROJECT_NOT_FOUND', 'Cannot read ' + join(root, directory) + ': ' + (error as Error).message);
    }
    // Only missing/inaccessible root directories describe a missing project.
    // A locked or disappearing child must retain its I/O error for the writer.
    await readDirectory(directory, entries);
  }
  // Plans are added only when used. Git does not retain empty directories.
  let plans;
  try { plans = await readdir(join(root, 'plans'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const plan of plans ?? []) {
    if (plan.isFile()) continue; // Unmanaged notes and OS files are not plan folders.
    if (!plan.isDirectory()) throw new VibeError('FILE_UNSUPPORTED', 'Expected a plan directory: plans/' + plan.name);
    for (const entry of await readdir(join(root, 'plans', plan.name), { withFileTypes: true })) {
      if (!entry.name.endsWith('.yaml')) continue;
      const file = 'plans/' + plan.name + '/' + entry.name;
      if (!entry.isFile()) throw new VibeError('FILE_UNSUPPORTED', 'Expected a regular file: ' + file);
      const source = await sourceAt(join(root, file));
      sources.set(file, source);
      parsed(file, source);
    }
  }
  for (const directory of ['documents/assets', 'imports']) {
    let entries;
    try {
      if ((await lstat(join(root, directory))).isSymbolicLink()) throw new VibeError('FILE_UNSUPPORTED', 'Managed folders cannot be symbolic links: ' + directory);
      entries = await readdir(join(root, directory), { withFileTypes: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (directory === 'imports' && !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      if (directory === 'documents/assets' && !/\.(png|jpe?g|gif|webp)$/i.test(entry.name)) continue;
      const file = directory + '/' + entry.name;
      if (!entry.isFile()) throw new VibeError('FILE_UNSUPPORTED', 'Expected a regular file: ' + file);
      if (directory === 'imports') sources.set(file, await sourceAt(join(root, file)));
      else assets.set(file, await readFile(join(root, file)));
    }
  }
  try { sources.set('.gitattributes', await sourceAt(join(root, '.gitattributes'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  diagnostics.push(...resourceDiagnostics(sources, directories));
  return { root, sources, files, assets, directories, diagnostics, revision: revisionOf(sources, assets, directories) };
}

function resourceDiagnostics(sources: ReadonlyMap<string, string>, directories: readonly string[] = []): Diagnostic[] {
  const result: Diagnostic[] = [];
  const entries = [...sources.keys()].flatMap(file => { const entry = resourceEntry(file); return entry ? [entry] : []; });
  for (const entry of entries) {
    const peers = entries.filter(other => entry.kind === 'schema' ? other.kind === 'schema' : other.kind !== 'schema');
    const error = resourceNameError(entry.name);
    const collision = peers.filter(other => resourceNameKey(other.name) === resourceNameKey(entry.name)).length > 1;
    if (error || collision) result.push({ code: error ? 'NAME_INVALID' : 'NAME_COLLISION', file: entry.file, path: entry.name,
      message: (error ?? '프로젝트 전체에서 대소문자만 다른 이름이 겹칩니다.') + ' 이름 제안: ' + suggestResourceName(entry.name, peers.map(other => other.name)) });
  }
  const folderGroups = new Map<string, Map<string, string[]>>();
  const allDirectories = new Set(directories);
  for (const file of sources.keys()) {
    const parts = file.split('/');
    if (!['tables', 'schemas', 'documents'].includes(parts[0]!)) continue;
    for (let i = 2; i < parts.length; i++) allDirectories.add(parts.slice(0, i).join('/'));
  }
  for (const directory of allDirectories) {
    const [root, ...parts] = directory.split('/');
    if (!['tables', 'schemas', 'documents'].includes(root!)) continue;
    const folder = parts.join('/');
    const error = folderError(folder);
    if (error) result.push({ code: 'FOLDER_NAME_INVALID', file: directory, path: folder, message: error });
    let logical = folder;
    try { if (root !== 'schemas') logical = folderAddress({ sources, directories }, folder); }
    catch (error) {
      result.push({ code: 'FOLDER_NAME_INVALID', file: directory, path: folder, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const logicalParts = pathParts(logical);
    const key = (root === 'schemas' ? 'schema/' : 'domain/') + JSON.stringify(logicalParts.map(resourceNameKey));
    if (!folderGroups.has(key)) folderGroups.set(key, new Map());
    const names = folderGroups.get(key)!;
    names.set(parts.at(-1)!, [...(names.get(parts.at(-1)!) ?? []), directory]);
  }
  for (const names of folderGroups.values()) if (names.size > 1) for (const [name, paths] of names) for (const file of paths) {
    result.push({ code: 'FOLDER_NAME_COLLISION', file, path: file.slice(file.indexOf('/') + 1),
      message: '같은 부모 아래 대소문자만 다른 폴더가 겹칩니다. 이름 제안: ' + suggestResourceName(name, [...names.keys()]) });
  }
  const groups = new Map<string, Map<string, string>>();
  for (const file of sources.keys()) {
    const match = /^plans\/([^/]+)\/([^/]+)\.yaml$/.exec(file);
    if (!match) continue;
    const [, plan, variant] = match;
    if (!groups.has('plans')) groups.set('plans', new Map());
    groups.get('plans')!.set(plan!, file);
    if (!groups.has('plans/' + plan)) groups.set('plans/' + plan, new Map());
    groups.get('plans/' + plan)!.set(variant!, file);
  }
  for (const names of groups.values()) {
    for (const [name, file] of names) {
      const error = resourceNameError(name);
      const collision = [...names.keys()].some(other => other !== name && resourceNameKey(other) === resourceNameKey(name));
      if (error || collision) result.push({ code: error ? 'NAME_INVALID' : 'NAME_COLLISION', file, path: name,
        message: (error ?? '같은 폴더에서 대소문자만 다른 이름이 겹칩니다.') + ' 이름 제안: ' + suggestResourceName(name, [...names.keys()]) });
    }
  }
  return result;
}

function revisionOf(sources: ReadonlyMap<string, string>, assets: ReadonlyMap<string, Uint8Array> = new Map(), directories: readonly string[] = []): string {
  const hash = createHash('sha256');
  for (const [file, source] of [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    hash.update(file).update('\0').update(source).update('\0');
  }
  for (const [file, bytes] of [...assets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(file).update('\0').update(bytes).update('\0');
  for (const directory of [...directories].sort()) hash.update('directory\0').update(directory).update('\0');
  return hash.digest('hex');
}

export function projectWithChanges(project: Project, changes: ReadonlyMap<string, string | null>, cleanupDirectories: readonly string[] = []): Project {
  const sources = new Map(project.sources);
  for (const [file, source] of changes) {
    const resource = resourceEntry(file);
    const marker = /^(?:schemas|tables|documents)\/(?:[^/]+\/)*\.gitkeep$/.test(file);
    if (file.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')) ||
        !(resource || marker || /^plans\/[^/]+\/[^/]+\.yaml$/.test(file) || /^imports\/[a-f0-9]{64}\.json$/.test(file) || file === '.gitattributes')) {
      throw new VibeError('FILE_UNKNOWN', 'Invalid managed path: ' + file);
    }
    if (source === null) sources.delete(file);
    else sources.set(file, source);
  }
  const directories = new Set((project.directories ?? []).filter(path => !cleanupDirectories.includes(path)));
  for (const file of sources.keys()) {
    const parts = file.split('/');
    if (!['tables', 'schemas', 'documents'].includes(parts[0]!)) continue;
    for (let i = 2; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const nameDiagnostics = resourceDiagnostics(sources, [...directories]);
  const invalidWrites = nameDiagnostics.filter(item => [...changes].some(([file, source]) => source != null && source !== project.sources.get(file) && (item.file === file || item.code.startsWith('FOLDER_') && file.startsWith(item.file + '/'))));
  if (invalidWrites.length) throw new VibeError(invalidWrites[0]!.code === 'NAME_COLLISION' ? 'NAME_EXISTS' : 'NAME_INVALID',
    invalidWrites[0]!.message, invalidWrites);
  const files = new Map<string, YamlFile>();
  const diagnostics: Diagnostic[] = [...nameDiagnostics];
  for (const [file, source] of sources) {
    if (!file.endsWith('.yaml')) continue;
    // Changes are prepared from one already-read snapshot. Reuse untouched ASTs
    // instead of reparsing a large unrelated table for every alternative/field.
    // Writers clone ASTs or replace source ranges; disk reads still parse anew.
    const previous = project.files.get(file);
    if (previous && previous.source === source) { files.set(file, previous); continue; }
    try { files.set(file, parseYaml(source, file)); }
    catch (error) {
      if (!(error instanceof VibeError)) throw error;
      diagnostics.push(...error.diagnostics);
    }
  }
  return { ...project, sources, files, diagnostics, directories: [...directories], revision: revisionOf(sources, project.assets, [...directories]) };
}

function lfChanges(project: Project, changes: ReadonlyMap<string, string | null>): Map<string, string | null> {
  const removed = new Set([...changes].filter(([, source]) => source === null).map(([file]) => project.sources.get(file)));
  return new Map([...changes].map(([file, source]) => [file,
    file.endsWith('.yaml') && source !== null && source !== project.sources.get(file) &&
      !(project.sources.get(file) === undefined && removed.has(source)) ? source.replace(/\r\n/g, '\n') : source]));
}

export function readPath(project: Project, path: string): unknown {
  const parts = pathParts(path);
  path = canonicalPath(path);
  if (resourceFile(project, 'document', parts[0]!) !== undefined) return readDocumentPath(project, path);
  if (parts.some(part => !part) || parts.length > 3) {
    throw new VibeError('PATH_INVALID', 'Expected table, table/key, table/*/column or table/key/column.');
  }
  const [name, key, column] = parts;
  const context = tableContexts(project).get(name!);
  if (!context) throw new VibeError('PATH_NOT_FOUND', 'Unknown table or invalid schema: ' + name);
  if (parts.length === 1) return { schema: context.schema, table: context.table };
  if (column !== undefined && !Object.hasOwn(context.schema.columns, column)) {
    throw new VibeError('PATH_NOT_FOUND', 'Unknown column code: ' + column);
  }
  if (key === '*') {
    if (column === undefined) throw new VibeError('PATH_INVALID', '* requires a column code.');
    return context.table.rows.map(row => ({
      key: row[context.schema.primary_key], value: row[column!] ?? null,
      present: Object.hasOwn(row, column!),
    }));
  }
  const rows = context.table.rows.filter(row => row[context.schema.primary_key] === key);
  if (rows.length !== 1) throw new VibeError('PATH_NOT_FOUND', 'Row Key is missing or ambiguous: ' + key);
  if (column === undefined) return rows[0];
  return { value: rows[0]![column] ?? null, present: Object.hasOwn(rows[0]!, column) };
}

export function formattedSources(project: Project): Map<string, string> {
  if (project.diagnostics.length) {
    throw new VibeError('INVALID_YAML', 'Cannot format files with parse/name errors.', project.diagnostics);
  }
  const tables = tableContexts(project);
  return new Map([...project.files].map(([path, file]) => [
    path, formatYaml(file, path.startsWith('tables/') ? tables.get(resourceEntry(path)!.name)?.schema : undefined).source,
  ]));
}

// File-level replacements, not a multi-file transaction. Git is the recovery mechanism.
async function replaceFiles(project: Project, changes: ReadonlyMap<string, string | null>, validated?: Project): Promise<string[]> {
  if (!validated) projectWithChanges(project, changes); // Direct writes still validate paths/YAML.
  const pending = [...changes].filter(([path, source]) => source !== project.sources.get(path));
  const written: string[] = [];
  try {
    const current = await readProject(project.root, project);
    if (current.revision !== project.revision) {
      throw new VibeError('STALE_REVISION', 'Files changed after reading; read again before writing.');
    }
    for (const [path, source] of pending) {
      const destination = join(project.root, path);
      const original = project.sources.get(path);
      let existing: string | undefined;
      try { existing = await sourceAt(destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (existing !== original) throw new VibeError('STALE_REVISION', 'File changed before replacement: ' + path);
      if (source === null) {
        await rm(destination);
        written.push(path);
        continue;
      }
      const temporary = temporarySibling(destination);
      let created = false;
      try {
        if (original === undefined) await mkdir(dirname(destination), { recursive: true });
        const handle = await open(temporary, 'wx', original === undefined ? 0o666 : (await stat(destination)).mode);
        created = true;
        try { await handle.writeFile(source, 'utf8'); }
        finally { await handle.close(); }
        await replaceFile(temporary, destination, async () => {
          let latest: string | undefined;
          try { latest = await sourceAt(destination); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (latest !== original) {
            throw new VibeError('STALE_REVISION', 'File changed immediately before replacement: ' + path);
          }
        });
        written.push(path);
      } finally {
        if (created) await rm(temporary, { force: true });
      }
    }
    return written;
  } catch (error) {
    if (error instanceof VibeError && written.length === 0) throw error;
    throw new VibeError('WRITE_FAILED', (error as Error).message +
      '; already replaced: ' + (written.join(', ') || 'none') + '. Restore the last Git commit if needed.', [], written);
  }
}

export async function withLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lockPath = join(root, '.vibe-spec.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new VibeError('PROJECT_LOCKED', 'Another local writer holds ' + lockPath);
    }
    throw error;
  }
  try { return await action(); }
  finally {
    await lock.close();
    await rm(lockPath);
  }
}

export async function writeChanges(project: Project, changes: ReadonlyMap<string, string>): Promise<string[]> {
  for (const path of changes.keys()) {
    if (!project.sources.has(path)) throw new VibeError('FILE_UNKNOWN', 'Not a loaded source file: ' + path);
  }
  if (![...changes].some(([path, source]) => source !== project.sources.get(path))) return [];
  return withLock(project.root, () => replaceFiles(project, lfChanges(project, changes)));
}

export async function mutateProject(
  root: string, expectedRevision: string,
  prepare: (project: Project) => ReadonlyMap<string, string | null> | Promise<ReadonlyMap<string, string | null>>,
  options: MutationOptions & { cleanupDirectories?: readonly string[] } = {},
) {
  if (!expectedRevision) throw new VibeError('REVISION_REQUIRED', 'Read the project and supply --expect-revision.');
  return withLock(root, async () => {
    const before = await loadProject(root);
    if (before.revision !== expectedRevision) throw new VibeError('STALE_REVISION', 'Files changed; read again before writing.');
    const changes = lfChanges(before, await prepare(before));
    const documentWrites = [...changes].filter(([file, source]) => file.startsWith('documents/') && file.endsWith('.md') && source !== null && source !== before.sources.get(file));
    if (documentWrites.length) {
      const attributes = before.sources.get('.gitattributes') ?? '* text=auto eol=lf\n';
      const required = ['documents/*.md -text', 'documents/assets/* -text'];
      if (documentWrites.some(([file]) => file.split('/').length > 2)) required.push('documents/**/*.md -text');
      const missing = required.filter(rule => !attributes.split(/\r?\n/).includes(rule));
      if (missing.length) changes.set('.gitattributes', attributes + (attributes.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n');
    }
    const cleanup = options.cleanupDirectories ?? [];
    for (const directory of cleanup) {
      if (!/^(?:tables|documents)\/.+/.test(directory) || folderError(directory.slice(directory.indexOf('/') + 1)) || !(before.directories ?? []).includes(directory)) {
        throw new VibeError('PATH_INVALID', 'Invalid directory cleanup: ' + directory);
      }
    }
    const planned = projectWithChanges(before, changes, cleanup);
    const diagnostics = validateProject(planned);
    if (options.dryRun) {
      const changed = [...changes].filter(([path, source]) => source !== (before.sources.get(path) ?? null)).map(([path]) => path);
      return { project: before, before, planned, changed, diagnostics, candidates: [] };
    }
    const changed = await replaceFiles(before, changes, planned);
    try {
      for (const directory of [...cleanup].sort((a, b) => b.split('/').length - a.split('/').length)) {
        await removeEmptyDirectory(join(root, directory));
      }
    } catch (error) {
      throw new VibeError('WRITE_FAILED', 'Directory cleanup failed: ' + (error as Error).message + '. Restore the last Git commit if needed.', [], changed);
    }
    return { project: await readProject(root, planned), before, planned, changed, diagnostics, candidates: [] };
  });
}

export async function initProject(folder: string): Promise<Project> {
  const root = resolve(folder);
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).some(name => name !== '.git')) {
    throw new VibeError('DIRECTORY_NOT_EMPTY', 'init requires an empty folder (an existing .git is allowed).');
  }
  await mkdir(join(root, 'schemas'));
  await mkdir(join(root, 'tables'));
  await writeFile(join(root, '.vibe-spec.json'), '{"planning_root":"."}\n', { flag: 'wx' });
  await writeFile(join(root, '.gitignore'), '.vibe-spec.lock\n*.vibe-tmp\n', { flag: 'wx' });
  await writeFile(join(root, '.gitattributes'), '* text=auto eol=lf\ndocuments/*.md -text\ndocuments/**/*.md -text\ndocuments/assets/* -text\n', { flag: 'wx' });
  await writeFile(join(root, 'AGENTS.md'), planningAgentInstructions, { flag: 'wx' });
  await mkdir(join(root, '.agents/skills/vibe-import'), { recursive: true });
  await writeFile(join(root, '.agents/skills/vibe-import/SKILL.md'), planningImportSkill, { flag: 'wx' });
  return loadProject(root);
}
