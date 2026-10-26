import { getTargetDocumentView, saveTargetDocumentSnapshots, createPlan, writeVariant, listPlans, resourceNameError, createDocument, deleteDocument, editDocument, getDocumentView, listDocuments, loadProject,
  renameResource, whereUsed, addDocumentImage, readPath, resourceFile, saveDocumentSnapshots, getGitStatus, saveProject, VibeError } from '@vibe-spec/core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, sep } from 'node:path';
import type { GitStatus, Project, WriteResult } from '@vibe-spec/core';
import type { DocumentsClientMessage, DocumentsHostMessage } from '../src/documentsProtocol.js';

const exec = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await exec('git', ['-C', root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;
async function fence(status: GitStatus) {
  if (!status.repository) return { control: '', changes: [] as string[] };
  const [head, index, changes] = await Promise.all([git(status.repository, 'rev-parse', '--revs-only', 'HEAD'),
    git(status.repository, 'ls-files', '--stage', '-z'), git(status.repository, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')]);
  return { control: JSON.stringify([status.repository, status.branch, status.mergeInProgress, head, index]), changes: changes.split('\0').filter(Boolean) };
}
export function createDocumentsServer(root: () => string) {
  const pending = new Map<string, { requestId: string; root: string; name: string; revision: string; expires: number }>();
  let saving = false;
  const selected = new Map<string,string>();
  const targets = new Map<string, { target: string; scopes?: string[] }>();
  async function state(client: string, replace = false, focusPath?: string, baseline?: Project): Promise<Extract<DocumentsHostMessage, { type: 'documentsState' }>> {
    const project = baseline ?? await loadProject(root()), name = selected.get(client);
    const assets = Object.fromEntries([...(project.assets ?? [])].map(([file,bytes]) => [file.slice(10),
      'data:image/' + (file.endsWith('.jpg') ? 'jpeg' : file.split('.').at(-1)) + ';base64,' + Buffer.from(bytes).toString('base64')]));
    return { type:'documentsState', revision:project.revision, documents:listDocuments(project), assets,replace,
      ...(name && resourceFile(project,'document',name) ? {view:getTargetDocumentView(project,name,targets.get(client)?.target,targets.get(client)?.scopes)} : {}), ...(focusPath ? {focusPath}: {}) };
  }
  return {
    reset() { selected.clear(); pending.clear(); targets.clear(); },
    async fixture(source?: string, variants = false) {
      let project = await loadProject(root());
      const name = '기획 문서';
      if (resourceFile(project,'document',name)) project = (await deleteDocument(root(),project.revision,name)).project;
      const image = await addDocumentImage(root(),project.revision, {name:'example.png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
      project = await loadProject(root());
      const markdown = source ?? '# 기획\n\n원문 **강조**  유지 👋\n\n<!-- name: 보상 -->\n[아이템](items/currency_gold/name)\n\n- 하나\n- 둘\n\n| 이름 | 값 |\n| --- | --- |\n| 확률 | 12.5000 |\n\n- [ ] 확인\n\n> 인용문\n\n```text\n코드\n```\n\n![그림]('+image.path+')\n\n<aside>보존할 원문</aside>';
      const result = await createDocument(root(),project.revision,name,markdown);
      if (variants) {
        let p = (await createPlan(root(), result.project.revision, 'document-review', { title: '문서 대안 시험', status: 'review' })).project;
        p = (await writeVariant(root(), p.revision, 'document-review', 'A', {})).project;
        await writeVariant(root(), p.revision, 'document-review', 'B', {});
      }
      // Only this disposable browser fixture configures an identity.
      await git(root(), 'init', '-b', 'main');
      await git(root(), 'config', 'user.name', 'Browser Test');
      await git(root(), 'config', 'user.email', 'browser@example.invalid');
      await git(root(), 'config', 'commit.gpgsign', 'false');
      return { name, source:markdown, revision:result.project.revision };
    },
    async handle(raw: Record<string,unknown>): Promise<DocumentsHostMessage | unknown> {
      const message = raw as unknown as DocumentsClientMessage, client=String(raw.client ?? 'inspection');
      try {
        if (raw.type === 'documentSaveCancel') {
          if (pending.get(client)?.requestId === raw.requestId) pending.delete(client);
          return { type: 'documentFlushResult', requestId: raw.requestId, ok: false, code: 'CANCELLED' };
        }
        if (raw.type === 'documentSavePrepare') {
          const name = selected.get(client);
          if (!name || typeof raw.requestId !== 'string') throw new VibeError('INVALID_EDIT', '저장할 문서를 열어 주세요.');
          const status = await getGitStatus(root());
          pending.set(client, { requestId: raw.requestId, root: root(), name, revision: status.revision, expires: Date.now() + 300_000 });
          return { type: 'documentSavePrepared', requestId: raw.requestId };
        }
        if (message.type === 'documentSnapshot') {
          const prepared = pending.get(client);
          if (!prepared || prepared.requestId !== message.requestId || prepared.root !== root() || prepared.name !== message.name ||
            selected.get(client) !== message.name || prepared.expires < Date.now()) throw new VibeError('INVALID_EDIT', '저장 요청이 만료되었거나 문서가 바뀌었습니다.');
          if (saving) throw new VibeError('OPERATION_RUNNING', '이전 저장이 끝난 뒤 다시 시도해 주세요.');
          pending.delete(client);
          saving = true;
          const saveRoot = prepared.root;
          let written: WriteResult | undefined;
          try {
            if (typeof raw.reason !== 'string' || !raw.reason.trim()) throw new VibeError('REASON_REQUIRED', '변경 사유를 입력해 주세요.');
            const status = await getGitStatus(saveRoot), beforeFence = await fence(status);
            if (status.revision !== prepared.revision) throw new VibeError('STALE_REVISION', '사유 입력 중 파일이나 Git 상태가 바뀌었습니다.');
            const project = await loadProject(saveRoot);
            if (typeof message.dirty !== 'boolean' || !Array.isArray(message.blocks)) throw new VibeError('INVALID_EDIT', '문서 저장 응답을 확인해 주세요.');
            if (message.dirty && message.revision !== project.revision) throw new VibeError('STALE_REVISION', '문서 편집 중 파일이 바뀌었습니다.');
            if ((await getGitStatus(saveRoot)).revision !== prepared.revision) throw new VibeError('STALE_REVISION', '파일이나 Git 상태가 바뀌었습니다.');
            if (root() !== saveRoot) throw new VibeError('PROJECT_CHANGED', '기획 폴더가 바뀌었습니다.');
            if (message.dirty) written = await saveTargetDocumentSnapshots(saveRoot, project.revision, [{ name: message.name, blocks: message.blocks, ...targets.get(client) }], {});
            let commitRevision = prepared.revision;
            if (written) {
              const afterStatus = await getGitStatus(saveRoot), afterFence = await fence(afterStatus);
              const prefix = afterStatus.repository ? relative(afterStatus.repository, afterStatus.root).split(sep).filter(Boolean).join('/') : '';
              const own = new Set(written.changed.map(file => (prefix ? prefix + '/' : '') + file));
              const unrelated = (changes: string[]) => JSON.stringify(changes.filter(change => !own.has(change.slice(3))).sort());
              if ((await loadProject(saveRoot)).revision !== written.planned.revision || beforeFence.control !== afterFence.control ||
                unrelated(beforeFence.changes) !== unrelated(afterFence.changes)) throw new VibeError('STALE_REVISION', '문서 반영 중 다른 파일이나 Git 상태가 바뀌었습니다.');
              commitRevision = afterStatus.revision;
            }
            if (root() !== saveRoot) throw new VibeError('PROJECT_CHANGED', '기획 폴더가 바뀌었습니다.');
            await saveProject(saveRoot, raw.reason, commitRevision);
            return { type: 'documentFlushResult', requestId: message.requestId, ok: true, state: await state(client, true, undefined, written?.planned ?? project) };
          } catch (error) {
            if (written) {
              // Rebaseline to exactly our file result, not an external writer's later revision.
              return { type: 'documentFlushResult', requestId: message.requestId, ok: true,
                state: { ...await state(client, true, undefined, written.planned),
                  notice: '문서 파일에는 반영했지만 Git 커밋하지 못했습니다. 값은 유지됩니다. ' + (error as Error).message } };
            }
            throw error;
          } finally { saving = false; }
        }
        let project = await loadProject(root());
        if (message.type === 'documentVariantCreate') {
          if (message.revision !== project.revision) throw new VibeError('STALE_REVISION', '기획 파일이 바뀌었습니다.');
          if (resourceNameError(message.variant) || message.variant === '_plan') throw new VibeError('NAME_INVALID', '대안 이름을 확인해 주세요.');
          const existing = listPlans(project).find(p => p.name === message.plan);
          if (existing?.variants.includes(message.variant)) throw new VibeError('NAME_EXISTS', '이미 있는 대안입니다.');
          if (!existing) project = (await createPlan(root(), project.revision, message.plan, { title: message.plan, status: 'draft' })).project;
          await writeVariant(root(), project.revision, message.plan, message.variant, {});
          targets.set(client, { target: message.plan + '/' + message.variant });
          return state(client, true);
        }
        if (message.type === 'documentTarget') {
          const name = selected.get(client)!; getTargetDocumentView(project, name, message.target, message.scopes);
          targets.set(client, { target: message.target, ...(message.scopes ? { scopes: message.scopes } : {}) });
          return state(client, true);
        }
        if (message.type === 'documentOpen') { getDocumentView(project,message.name); selected.set(client,message.name); }
        else if (message.type === 'ready' && typeof raw.name === 'string') selected.set(client,raw.name);
        else if (message.type === 'documentCreate') {
          await createDocument(root(),message.revision,message.name,'# '+message.name+'\n'); selected.set(client,message.name);
        } else if (message.type === 'documentEdit') await editDocument(root(),message.revision,message.name,message.operations);
        else if (message.type === 'documentDelete') {
          if (!message.confirmed) throw new Error('삭제 확인이 필요합니다.');
          await deleteDocument(root(),message.revision,message.name); selected.delete(client);
        } else if (message.type === 'documentRename') {
          await renameResource(root(),message.revision,message.kind,message.path,message.to);
          if (message.kind === 'document' && selected.get(client) === message.path) selected.set(client,message.to);
        } else if (message.type === 'documentImage') {
          const bytes = Buffer.from(message.data, 'base64');
          if (project.revision !== message.revision) throw new VibeError('STALE_REVISION', '이미지를 넣기 전에 파일이 바뀌었습니다.');
          const result = await addDocumentImage(root(), message.revision, { name: message.name, bytes });
          const after = await loadProject(root()), expectedAssets = new Map(project.assets);
          expectedAssets.set('documents/' + result.path, bytes);
          if (after.revision !== result.revision || after.sources.size !== project.sources.size ||
            [...project.sources].some(([file, source]) => after.sources.get(file) !== source) ||
            JSON.stringify(after.directories) !== JSON.stringify(project.directories) || after.assets?.size !== expectedAssets.size ||
            [...expectedAssets].some(([file, bytes]) => !Buffer.from(after.assets?.get(file) ?? []).equals(Buffer.from(bytes)))) {
            throw new VibeError('STALE_REVISION', '이미지 업로드 중 파일이 바뀌었습니다. 초안을 유지합니다.');
          }
          return {type:'documentImageAdded',path:result.path,revision:result.revision};
        } else if (message.type === 'documentUsage') return {type:'documentUsages',path:message.path,usages:await whereUsed(project,message.path)};
        else if (message.type === 'documentNavigate') {
          readPath(project,message.path);
          if (resourceFile(project,'document',message.path.split('/')[0]!)) selected.set(client,message.path.split('/')[0]!);
          return state(client,true,message.path);
        }
        return state(client, message.type !== 'documentsRefresh' && message.type !== 'ready', message.type === 'documentOpen' ? message.path : undefined);
      } catch(error) { return { ...(message.type === 'documentSnapshot' ? {type:'documentFlushResult',requestId:message.requestId,ok:false} : {type:'error'}),code:error instanceof VibeError?error.code:'DOCUMENT_FAILED',message:(error as Error).message}; }
    },
  };
}
