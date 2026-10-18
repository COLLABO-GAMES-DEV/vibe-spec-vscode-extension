import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEdits, getGitStatus, loadProject, pullProject, pushProject, resolveProject, saveProject, VibeError } from '@vibe-spec/core';
import type { EditOperation, GitChoice, GitResult } from '@vibe-spec/core';
import type { GitHostMessage } from '../src/gitProtocol.js';
const exec = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await exec('git', ['-C', root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
export function createGitServer(getRoot: () => string) {
  let sandbox: string | undefined, peer: string | undefined;
  const identity = async (root: string) => {
    await git(root, 'config', 'user.name', 'Browser Test'); await git(root, 'config', 'user.email', 'browser@example.invalid');
    await git(root, 'config', 'commit.gpgsign', 'false');
  };
  async function prepare() {
    if (peer) return;
    const root = getRoot(); sandbox = await mkdtemp(join(tmpdir(), 'vibe browser Git 한글-'));
    const remote = join(sandbox, 'remote.git'); peer = join(sandbox, 'peer');
    await exec('git', ['init', '--bare', '-b', 'main', remote]);
    await git(root, 'init', '-b', 'main'); await identity(root);
    await saveProject(root, 'Initial browser fixture'); await git(root, 'remote', 'add', 'origin', remote); await pushProject(root);
    await exec('git', ['clone', remote, peer]); await identity(peer);
  }
  return {
    async reset() { peer = undefined; if (sandbox) await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }); sandbox = undefined; },
    async handle(body: Record<string, unknown>, fixture = false): Promise<GitHostMessage> {
      const root = getRoot(); let result: GitResult | undefined;
      if (fixture) {
        await prepare();
        if (body.action === 'edit') {
          const project = await loadProject(root); await applyEdits(root, project.revision, body.operations as EditOperation[]);
        } else if (body.action === 'remote') {
          await pullProject(peer!); const project = await loadProject(peer!);
          await applyEdits(peer!, project.revision, body.operations as EditOperation[]);
          await saveProject(peer!, String(body.reason ?? 'Peer changes')); await pushProject(peer!);
        } else if (body.action === 'remoteFailure') await git(root, 'remote', 'set-url', 'origin', join(sandbox!, 'missing-remote.git'));
      } else {
        // Browser fixtures have a configured identity; the product host uses the user's Git configuration.
        if (body.type === 'gitSave') result = await saveProject(root, String(body.reason ?? ''), String(body.revision));
        if (body.type === 'gitPush') result = await pushProject(root);
        if (body.type === 'gitPull') result = await pullProject(root);
        if (body.type === 'gitResolve') result = await resolveProject(root, String(body.revision), body.choices as GitChoice[]);
      }
      return { type: 'gitState', status: result?.status ?? await getGitStatus(root), editing: false, ...(result ? { result } : {}) };
    },
  };
}
