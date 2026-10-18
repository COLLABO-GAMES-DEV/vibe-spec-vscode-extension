import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { formattedSources, initProject, loadProject, writeChanges } from '../src/project.js';
import { saveProject, getGitStatus } from '../src/git.js';
it('tracks normalization provenance in revision and Git without formatting its JSON bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-provenance-'));
  try {
    const before = await initProject(root);
    const git = (...args: string[]) => execFileSync('git', args, {cwd:root,encoding:'utf8'});
    git('init','-q'); git('config','user.name','Test'); git('config','user.email','test@example.invalid'); git('config','commit.gpgsign','false');
    const source = '{ "normalizations": [{"raw":"1.0", "value":"1", "cell":"A4"}] }\n';
    const file = 'imports/' + createHash('sha256').update(source).digest('hex') + '.json';
    await mkdir(join(root,'imports')); await writeFile(join(root,file),source);
    const project = await loadProject(root);
    expect(project.revision).not.toBe(before.revision);
    expect(project.sources.get(file)).toBe(source);
    expect(await writeChanges(project,formattedSources(project))).toEqual([]);
    expect((await getGitStatus(root)).changes).toContain(file);
    await saveProject(root,'Keep import provenance');
    expect(git('show','HEAD:'+file)).toBe(source);
    expect(await readFile(join(root,file),'utf8')).toBe(source);
  } finally { await rm(root,{recursive:true,force:true,maxRetries:3}); }
},process.platform==='win32'?60_000:30_000);
