import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { initProject, loadProject, readPath, resourceFile, resourceEntries, listFolders, folderError, validateProject, getTableView, writeChanges } from '../src/index.js';
import { mutateProject } from '../src/project.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vibe-domain-loader-')); roots.push(root);
  await initProject(root);
  async function put(path: string, source: string) { await mkdir(join(root,path,'..'),{recursive:true}); await writeFile(join(root,path),source); }
  await put('schemas/공용/value.yaml','primary_key: key\ncolumns:\n  key:\n    type: string\n  value:\n    type: decimal\n');
  await put('tables/경제/재화/gold.yaml','schema: value\nrows:\n  - key: "one"\n    value: "12.5000"\n');
  await put('documents/경제/설명.md','# 재화\n\n[골드](gold/one/value)\n');
  return {root,put,project:await loadProject(root)};
}
it('resolves nested tables, schemas and document links by global basename', async () => {
  const {project} = await fixture();
  expect(readPath(project,'gold/one/value')).toEqual({value:'12.5000',present:true});
  expect(readPath(project,'설명/재화')).toContain('[골드](gold/one/value)');
  expect(validateProject(project)).toEqual([]);
  expect(getTableView(project,'gold').rows[0]?.value).toBe('12.5000');
  expect(resourceFile(project,'schema','value')).toBe('schemas/공용/value.yaml');
  expect(resourceEntries(project,'table')[0]?.name).toBe('gold');
  expect(listFolders(project)).toEqual(['경제','경제/재화']);
});
it('empty physical folders and marker bytes participate in revisions', async () => {
  const {root,project,put} = await fixture();
  await mkdir(join(root,'documents','전투'));
  const next = await loadProject(root);
  expect(next.revision).not.toBe(project.revision);
  expect(listFolders(next)).toContain('전투');
  await expect(mutateProject(root,project.revision,()=>new Map())).rejects.toMatchObject({code:'STALE_REVISION'});
  await put('tables/콘텐츠/.gitkeep','');
  expect(listFolders(await loadProject(root))).toContain('콘텐츠');
});
it('reports project-wide table/document and schema duplicates across different folders', async () => {
  const {root,put} = await fixture();
  await put('tables/다른/gold.yaml','schema: value\nrows: []\n');
  await put('documents/기타/GOLD.md','# 중복\n');
  await put('schemas/다른/VALUE.yaml','primary_key: key\ncolumns: {key: {type: string}}\n');
  const project = await loadProject(root);
  expect(project.diagnostics.filter(item=>item.code==='NAME_COLLISION')).toHaveLength(5);
  expect(()=>validateProject(project)).not.toThrow();
  expect(()=>readPath(project,'gold')).toThrow();
});
it('rejects traversal, Windows-unsafe domain paths and merged case collisions', async () => {
  for (const folder of ['../escape','/escape','a//b','a\\b','전투/CON','a.','assets','Assets/other']) expect(folderError(folder)).toBeTruthy();
  const {root,put} = await fixture();
  await put('tables/Battle/.gitkeep',''); await put('documents/battle/.gitkeep','');
  const project = await loadProject(root);
  expect(project.diagnostics.filter(item=>item.code==='FOLDER_NAME_COLLISION')).toHaveLength(2);
  await expect(mutateProject(root,project.revision,()=>new Map([['tables/../escape.yaml','schema: value\nrows: []\n']]))).rejects.toMatchObject({code:'FILE_UNKNOWN'});
});
it('copies source bytes during a physical relocation and cleans only requested empty directories', async () => {
  const {root,put} = await fixture();
  const original = 'schema: value\r\nrows: [] # retained\r\n';
  await put('tables/old/raw.yaml',original);
  const project = await loadProject(root);
  await mutateProject(root,project.revision,()=>new Map([['tables/old/raw.yaml',null],['tables/new/raw.yaml',original]]),{cleanupDirectories:['tables/old']});
  expect(await readFile(join(root,'tables/new/raw.yaml'),'utf8')).toBe(original);
  expect((await loadProject(root)).directories).not.toContain('tables/old');
});
it.skipIf(process.platform==='win32')('refuses nested symlinks instead of reading outside the planning root', async () => {
  const {root} = await fixture();
  const outside = await mkdtemp(join(tmpdir(),'vibe-outside-')); roots.push(outside);
  await symlink(outside,join(root,'tables','외부'));
  await expect(loadProject(root)).rejects.toMatchObject({code:'FILE_UNSUPPORTED'});
});

it('moving a domain leaves symmetric variant addresses and bytes intact, and approval writes the nested baseline', async () => {
  const { createPlan, writeVariant, readVariant, approvePlan, applyFolderEdit } = await import('../src/index.js');
  const { root, project } = await fixture();
  let current = (await createPlan(root,project.revision,'value-review',{title:'값 비교',status:'review'})).project;
  current = (await writeVariant(root,current.revision,'value-review','A',{set:{'gold/one/value':'0.5'}})).project;
  current = (await writeVariant(root,current.revision,'value-review','B',{set:{'gold/one/value':'0.8'}})).project;
  const patches = [...current.sources].filter(([file])=>file.startsWith('plans/'));
  current = (await applyFolderEdit(root,current.revision,{op:'folder-rename',path:'경제',name:'성장'})).project;
  for (const [file,source] of patches) expect(current.sources.get(file)).toBe(source);
  expect(readPath(readVariant(current,'value-review','A'),'gold/one/value')).toEqual({value:'0.5',present:true});
  expect(readPath(readVariant(current,'value-review','B'),'gold/one/value')).toEqual({value:'0.8',present:true});
  expect(validateProject(current)).toEqual([]);
  current = (await approvePlan(root,current.revision,'value-review','B')).project;
  expect(readPath(current,'gold/one/value')).toEqual({value:'0.8',present:true});
  expect(resourceFile(current,'table','gold')).toBe('tables/성장/재화/gold.yaml');
  expect(current.sources.has('tables/gold.yaml')).toBe(false);
});


it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps an unreadable nested file distinct from a missing planning root', async () => {
  const { root, project } = await fixture();
  const file = 'tables/경제/재화/gold.yaml';
  const source = project.sources.get(file)!;
  await chmod(join(root, file), 0);
  try {
    await expect(writeChanges(project, new Map([[file, source.replace('12.5000', '13.5000')]])))
      .rejects.toMatchObject({ code: 'WRITE_FAILED', written: [] });
    await expect(loadProject(root)).rejects.toMatchObject({ code: 'EACCES' });
  } finally { await chmod(join(root, file), 0o600); }
  expect(await readFile(join(root, file), 'utf8')).toBe(source);
  expect((await loadProject(root)).revision).toBe(project.revision);
});
