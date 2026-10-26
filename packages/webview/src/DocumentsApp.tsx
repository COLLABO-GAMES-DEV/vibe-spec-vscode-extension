import { pathParts, pathFromParts } from '@vibe-spec/core/paths';
import { useEffect, useRef, useState } from 'react';
import type { TargetDocumentView, DocumentView, Usages } from '@vibe-spec/core';
import type { DocumentsClientMessage, DocumentsHost, DocumentsState } from './documentsProtocol';
import { DocumentEditor, type DocumentEditorHandle } from './DocumentEditor';
import './documents.css';

type Management = { kind: 'rename' | 'delete'; name: string; revision: string; value: string; confirmed: boolean };
type Screen = { state?: DocumentsState; active?: { view: DocumentView; revision: string } | undefined; dirty: boolean;
  discard?: boolean; epoch?: number;
  firstHeading: boolean; pending?: 'manage' | 'image' | undefined; flush?: string | undefined;
  error?: string | undefined; management?: Management | undefined; usages?: { path: string; usages: Usages } | undefined };
const displayValue = (value: unknown): string => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
export function DocumentsApp({ host }: { host: DocumentsHost }) {
  const [planName, setPlanName] = useState('');
  const [variantName, setVariantName] = useState('A');
  const [screen, setScreen] = useState<Screen>({ dirty: false, firstHeading: false });
  const current = useRef(screen);
  const editor = useRef<DocumentEditorHandle | undefined>(undefined);
  const imageTarget = useRef<{ resolve: (url: string) => void; reject: (error: Error) => void } | undefined>(undefined);
  // Host messages and keyboard events can arrive before React renders again.
  function update(fn: (previous: Screen) => Screen) { current.current = fn(current.current); setScreen(current.current); }
  useEffect(() => {
    const unsubscribe = host.subscribe(message => {
      if (message.type === 'documentFlush') {
        const active = current.current.active;
        try {
          if (current.current.pending) throw new Error('진행 중인 문서 작업을 마친 뒤 다시 저장해 주세요.');
          if (current.current.flush) throw new Error('이미 저장하고 있습니다.');
          if (!active || !editor.current) throw new Error('열린 문서 편집기가 없습니다.');
          const snapshot = editor.current.snapshot();
          update(previous => ({ ...previous, flush: message.requestId, error: undefined }));
          host.send({ type: 'documentSnapshot', requestId: message.requestId, name: active.view.name,
            revision: active.revision, ...('target' in active.view ? { target: (active.view as TargetDocumentView).target } : {}), ...snapshot });
        } catch (error) {
          update(previous => ({ ...previous, error: String(error) }));
          host.send({ type: 'documentSnapshotError', requestId: message.requestId, message: String(error) });
        }
        return;
      }
      if (message.type === 'documentFlushResult') {
        if (current.current.flush !== message.requestId) return;
        editor.current?.unlock();
        const state = message.state;
        update(previous => ({ ...previous, flush: undefined,
          ...(message.ok && state?.view ? { state, active: { view: state.view, revision: state.revision }, dirty: false } : {}),
          error: message.ok ? undefined : `${message.code ?? 'DOCUMENT_SAVE_FAILED'}: ${message.message ?? '저장하지 못했습니다. 초안은 유지됩니다.'}` }));
        if (message.ok) host.send({ type: 'documentDraft', dirty: current.current.dirty });
        return;
      }
      if (message.type === 'documentImageAdded') {
        const target = imageTarget.current;
        imageTarget.current = undefined;
        if (!target) return;
        // Only the acknowledged own asset mutation may advance a dirty draft's
        // revision. It does not replace its body/source offsets.
        update(previous => ({ ...previous, pending: undefined, active: previous.active &&
          { ...previous.active, revision: message.revision }, error: undefined }));
        target.resolve(message.path);
        host.send({ type: 'documentsRefresh' });
        return;
      }
      if (message.type === 'error') {
        imageTarget.current?.reject(new Error(`${message.code}: ${message.message}`));
        imageTarget.current = undefined;
        editor.current?.unlock();
        update(previous => ({ ...previous, pending: undefined, flush: undefined, error: `${message.code}: ${message.message}` }));
        return;
      }
      if (message.type === 'documentUsages') { update(previous => ({ ...previous, usages: message })); return; }
      update(previous => {
        const preserve = previous.dirty || Boolean(previous.flush) || previous.pending === 'image';
        return { ...previous, state: message,
          ...(!preserve ? { active: message.view ? { view: message.view, revision: message.revision } : undefined,
            firstHeading: Boolean(message.view?.blocks.some(block => block.kind === 'heading' && /^#\s/.test(block.markdown))),
            management: undefined, pending: undefined } : {}),
        };
      });
    });
    host.send({ type: 'ready' });
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!current.current.flush && !current.current.pending) host.send({ type: 'documentSaveRequest' });
      }
    };
    window.addEventListener('keydown', save, true);
    return () => { unsubscribe(); window.removeEventListener('keydown', save, true); };
  }, [host]);
  const { state, active, dirty, pending, flush, management, error } = screen;
  const view = active?.view;
  const targetView = view && 'target' in view ? view as TargetDocumentView : undefined;
  const isVariant = targetView && targetView.target !== 'base';
  const allowedBlocks = isVariant ? view!.blocks.filter(block => targetView.selectedScopes.some(path => {
    const scope = targetView.scopes.find(s => s.path === path);
    return scope && (block.start >= scope.start || block.path === path) && block.end <= scope.end;
  })).map(b => b.index) : undefined;
  const busy = Boolean(pending || flush);
  const stale = Boolean(dirty && active && state && active.revision !== state.revision);
  function send(message: DocumentsClientMessage) {
    update(previous => ({ ...previous, pending: 'manage', error: undefined })); host.send(message);
  }
  function navigate(path: string) {
    if (current.current.dirty) { update(previous => ({ ...previous, error: '이동하기 전에 변경 사유와 함께 저장해 주세요.' })); return; }
    const link = current.current.active?.view.links.find(item => item.destination === path);
    host.send({ type: 'documentNavigate', path: link?.path ?? path });
  }
  function manage(kind: Management['kind']) {
    if (!active || dirty || busy) return;
    update(previous => ({ ...previous, error: undefined, management: { kind, name: active.view.name,
      revision: active.revision, value: active.view.name, confirmed: false } }));
  }
  async function uploadImage(file: File): Promise<string> {
    const target = current.current.active;
    if (!target || current.current.pending || current.current.flush) throw new Error('현재 문서 작업을 먼저 마쳐 주세요.');
    update(previous => ({ ...previous, pending: 'image', error: undefined }));
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(reader.error ?? new Error('이미지를 읽지 못했습니다.'));
        reader.readAsDataURL(file);
      });
      return await new Promise<string>((resolve, reject) => {
        imageTarget.current = { resolve, reject };
        host.send({ type: 'documentImage', name: file.name, data, revision: target.revision });
      });
    } catch (error) { update(previous => ({ ...previous, pending: undefined })); throw error; }
  }
  if (!state) return <main className="documents-app"><p role="status">문서를 불러오는 중입니다.</p>{error && <p role="alert">{error}</p>}</main>;
  return <main className="documents-app"><div className="documents-content">
    {error && <p role="alert" className="document-error">{error}</p>}
    {state.notice && <p role="status" className="document-notice">{state.notice}</p>}
    {busy && <p role="status">처리하고 있습니다.</p>}
    {stale && <p role="alert" className="document-warning">파일이 변경되었습니다. 초안과 편집 기준은 유지됩니다.</p>}
    {dirty && !state.view && <p className="document-warning">문서가 삭제되었거나 이동했습니다. 초안은 유지됩니다.</p>}
    {dirty && (stale || error) && <details className="document-current"><summary>현재 원문</summary>
      <pre>{state.view?.name === view?.name ? state.view?.source : '문서가 삭제되었거나 이동했습니다. 현재 원문을 불러올 수 없습니다.'}</pre>
    </details>}
    {management && <form className="document-management" aria-label="문서 작업" onSubmit={event => {
      event.preventDefault(); if (busy) return;
      if (management.kind === 'rename' && management.value.trim()) send({ type: 'documentRename', kind: 'document',
        path: management.name, to: management.value, revision: management.revision });
      if (management.kind === 'delete' && management.confirmed) send({ type: 'documentDelete', name: management.name,
        revision: management.revision, confirmed: true });
    }}>
      <h2>{management.kind === 'rename' ? '이름 바꾸기' : '삭제 확인'}</h2><p><code>{management.name}</code></p>
      {management.kind === 'rename' ? <label>이름<input autoFocus value={management.value} disabled={busy}
        onChange={event => update(previous => ({ ...previous, management: previous.management && { ...previous.management, value: event.target.value } }))} /></label>
        : <label><input type="checkbox" checked={management.confirmed} disabled={busy}
          onChange={event => update(previous => ({ ...previous, management: previous.management && { ...previous.management, confirmed: event.target.checked } }))} />문서 전체를 삭제합니다</label>}
      <div className="document-actions"><button type="submit" disabled={busy || (management.kind === 'rename' ? !management.value.trim() : !management.confirmed)}>
        {management.kind === 'rename' ? '이름 변경 적용' : '삭제 적용'}</button>
        <button type="button" disabled={busy} onClick={() => update(previous => ({ ...previous, management: undefined }))}>취소</button></div>
    </form>}
    {view ? <>
      <header className="document-header">
        {!screen.firstHeading && <h1>{view.name}</h1>}
        <span className="document-save-state">{dirty ? '저장하지 않은 변경' : ''}</span>
        <button disabled={busy} onClick={() => host.send({ type: 'documentSaveRequest' })}>변경 사유와 함께 저장</button>
        <details className="document-menu"><summary aria-label="문서 메뉴">⋯</summary><div className="document-menu-items">
          <button disabled={busy || dirty || Boolean(isVariant)} onClick={() => manage('rename')}>문서 이름 바꾸기</button>
          <button disabled={busy || dirty || Boolean(isVariant)} onClick={() => manage('delete')}>문서 삭제</button>
          <button onClick={() => host.send({ type: 'documentUsage', path: view.name })}>문서 사용처</button>
          <button disabled={busy} onClick={() => host.send({ type: 'documentsRefresh' })}>문서 새로 고침</button>
        </div></details>
      </header>
      {targetView && <section className="document-target" aria-label="문서 편집 대상">
        <strong>편집 대상: {isVariant ? targetView.target : '기준안'}</strong>
        <label>대상 선택<select aria-label="문서 편집 대상 선택" value={targetView.target} disabled={busy || dirty}
          onChange={event => send({ type: 'documentTarget', target: event.target.value })}>
          {targetView.targets.map(target => <option key={target} value={target}>{target === 'base' ? '기준안' : target}</option>)}
        </select></label>
        <details><summary>새 기획·대안 만들기</summary><form onSubmit={event => { event.preventDefault();
          send({ type: 'documentVariantCreate', plan: planName, variant: variantName, revision: active!.revision }); }}>
          <label>기획 이름<input aria-label="기획 이름" value={planName} onChange={event => setPlanName(event.target.value)} /></label>
          <label>대안 이름<input aria-label="대안 이름" value={variantName} onChange={event => setVariantName(event.target.value)} /></label>
          <button disabled={busy || dirty || !planName.trim() || !variantName.trim()}>대안 만들기</button>
        </form></details>
        {isVariant && <details open><summary>쟁점 범위 선택</summary>
          <p>선택 범위 밖은 기준안에서 상속합니다. 목록·표만 따로 선택할 수 없습니다. 저장된 범위 제거는 CLI plan variant에서 변경분을 제외합니다.</p>
          {targetView.scopes.map(scope => <label key={scope.path} className="document-scope-option">
            <input type="checkbox" title={targetView.persistedScopes.includes(scope.path) ? "이미 저장한 변경 범위입니다" : undefined} disabled={busy || dirty || targetView.persistedScopes.includes(scope.path)} checked={targetView.selectedScopes.includes(scope.path)}
              onChange={event => send({ type: 'documentTarget', target: targetView.target, scopes: event.target.checked
                ? [...targetView.selectedScopes, scope.path] : targetView.selectedScopes.filter(path => path !== scope.path) })} />
            {scope.path} ({scope.kind === 'document' ? '문서 전체' : scope.kind === 'section' ? '섹션' : '이름표 문단'})
          </label>)}
        </details>}
        {dirty && <><p>대상이나 범위를 바꾸려면 초안을 저장하거나 버려 주세요.</p>
          <button disabled={busy} onClick={() => update(previous => ({ ...previous, discard: true }))}>초안 버리기</button></>}
        {screen.discard && <section role="dialog" aria-label="초안 버리기 확인"><p>저장하지 않은 초안을 버릴까요?</p>
          <button onClick={() => update(previous => ({ ...previous, discard: false }))}>유지</button>
          <button onClick={() => { update(previous => ({ ...previous, discard: false, dirty: false, error: undefined,
            epoch: (previous.epoch ?? 0) + 1, active: previous.state?.view ? { view: previous.state.view, revision: previous.state.revision } : undefined }));
            host.send({ type: 'documentDraft', dirty: false }); }}>버리고 현재 파일 읽기</button></section>}
      </section>}
      <section className="document-blocks" aria-label="문서 본문">
        <DocumentEditor key={JSON.stringify([view.name, targetView?.target, targetView?.selectedScopes.slice().sort(), screen.epoch])} allowedBlocks={allowedBlocks} lockedHeadings={isVariant ? targetView.selectedScopes.filter(path => targetView.scopes.some(s => s.path === path && s.kind === 'section')) : []} view={view} assets={state.assets} disabled={busy} focusPath={state.focusPath}
          handleRef={editor} uploadImage={uploadImage} navigate={navigate}
          onError={message => update(previous => ({ ...previous, error: message }))}
          onChange={(nextDirty, firstHeading) => {
            const changed = current.current.dirty !== nextDirty;
            if (changed || current.current.firstHeading !== firstHeading) update(previous => ({ ...previous, dirty: nextDirty, firstHeading }));
            if (changed) host.send({ type: 'documentDraft', dirty: nextDirty });
          }} />
        {view.links.some(link => link.kind === 'resource') && <ul className="document-references" aria-label="연결된 기획 값">
          {view.links.filter(link => link.kind === 'resource').map((link, index) => <li key={index}>
            <button className="document-link" onClick={() => navigate(link.path || link.destination)}><code>{link.path || link.destination}</code>
              {(link.path ? pathParts(link.path).length : 0) === 3 && !state.documents.some(item => item.name === pathParts(link.path!)[0])
                && link.value !== undefined && (link.value === null || typeof link.value !== 'object') && <span className="document-value">{displayValue(link.value)}</span>}
              {link.resolved === false && <span>대상을 찾을 수 없습니다</span>}
            </button></li>)}
        </ul>}
      </section>
      {view.diagnostics.length > 0 && <section className="document-diagnostics" aria-label="문서 진단"><h2>확인할 내용</h2><ul>
        {view.diagnostics.map((diagnostic, index) => <li key={index}><code>{diagnostic.code}</code> {diagnostic.path} · {diagnostic.message}</li>)}
      </ul></section>}
    </> : <p className="document-empty">사이드바에서 문서를 열어 주세요.</p>}
    {screen.usages && <section className="document-usages" aria-label="문서 사용처 결과">
      <header><h2>{screen.usages.path} 사용처</h2><button onClick={() => update(previous => ({ ...previous, usages: undefined }))}>사용처 닫기</button></header>
      {(['references', 'candidates'] as const).map(kind => <section key={kind}><h3>{kind === 'references' ? '선언된 참조' : '본문 텍스트 후보'} ({screen.usages!.usages[kind].length})</h3><ul>
        {screen.usages!.usages[kind].map((usage, index) => <li key={index}><code>{usage.file}:{usage.line}</code> {usage.path} <span>{usage.text}</span>
          {usage.path && <button onClick={() => navigate(usage.path)}>위치로 이동</button>}</li>)}
      </ul></section>)}
    </section>}
  </div></main>;
}
