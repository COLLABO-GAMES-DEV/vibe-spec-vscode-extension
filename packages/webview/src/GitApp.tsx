import { useEffect, useState } from 'react';
import type { GitChoice, GitConflict, GitResult, GitStatus } from '@vibe-spec/core';
import type { GitClientMessage, GitHost, GitHostMessage } from './gitProtocol.js';
import './git.css';

type StateMessage = Extract<GitHostMessage, { type: 'gitState' }>;
type Pending = GitResult['action'] | 'refresh';
type Selection = { signature: string; choice: GitChoice['choice'] };
type Screen = {
  state: StateMessage | null;
  pending: Pending | null;
  reason: string;
  choices: Record<string, Selection>;
  error: string | null;
  result: GitResult | null;
  saved: { reason: string; commit?: string } | null;
};
const stateLabels: Record<GitStatus['state'], string> = {
  unsaved: '저장 전', unpublished: '올리기 전', published: '올리기 완료', conflict: '충돌 해결 필요',
};
const progressLabels: Record<Pending, string> = {
  save: '저장 중…', push: '올리는 중…', pull: '받아오는 중…', resolve: '충돌 선택 적용 중…', refresh: '상태 확인 중…',
};
const versions = [
  { choice: 'base', label: '기준' }, { choice: 'ours', label: '내 변경' }, { choice: 'theirs', label: '받은 변경' },
] as const;
const conflictId = (conflict: GitConflict) => JSON.stringify([conflict.kind, conflict.file, conflict.kind === 'row' ? conflict.key : null]);
const signature = (conflict: GitConflict) => JSON.stringify(conflict);
const literal = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value) ?? '없음';

function ConflictValues({ conflict }: { conflict: GitConflict }) {
  const columns = conflict.kind === 'row'
    ? [...new Set(versions.flatMap(({ choice }) => Object.keys(conflict[choice] ?? {})))] : [];
  return <div className="git-comparison-scroll"><table className="git-comparison" aria-label="충돌 값 비교">
    <thead><tr>{versions.map(({ choice, label }) => <th key={choice} scope="col">{label}</th>)}</tr></thead>
    <tbody>{conflict.kind === 'row' && columns.length > 0
      ? columns.map((column, index) => <tr key={column}>{versions.map(({ choice }) => {
        const row = conflict[choice];
        if (row === null) return index === 0
          ? <td key={choice} rowSpan={columns.length}><span className="git-absent">삭제</span></td> : null;
        return <td key={choice}><code className="git-column">{column}</code>
          <pre className="git-literal" data-column={column}>{Object.hasOwn(row, column) ? literal(row[column]) : '없음'}</pre></td>;
      })}</tr>)
      : <tr>{versions.map(({ choice }) => <td key={choice}>{conflict[choice] === null
        ? <span className="git-absent">삭제</span>
        : <pre className="git-literal">{literal(conflict[choice])}</pre>}</td>)}</tr>}
    </tbody>
  </table></div>;
}

export function GitApp({ host }: { host: GitHost }) {
  const [screen, setScreen] = useState<Screen>({ state: null, pending: 'refresh', reason: '',
    choices: {}, error: null, result: null, saved: null });

  useEffect(() => {
    const receive = (message: GitHostMessage) => setScreen(previous => {
      if (message.type === 'error') return { ...previous, pending: null, error: message.code + ': ' + message.message };
      const result = message.result;
      // A watcher refresh is not an operation result and must not erase failures or unlock an active write.
      const finished = previous.pending === 'refresh' || result?.action === previous.pending;
      const saved = result?.action === 'save' && result.completed;
      const choices = Object.fromEntries(message.status.conflicts.flatMap(conflict => {
        const id = conflictId(conflict), selection = previous.choices[id];
        return selection?.signature === signature(conflict) ? [[id, selection]] : [];
      }));
      return { ...previous, state: message, pending: finished ? null : previous.pending, choices,
        error: result?.completed ? null : previous.error,
        result: result ?? previous.result,
        reason: saved ? '' : previous.reason,
        saved: saved ? { reason: previous.reason, ...(result.commit ? { commit: result.commit } : {}) } : previous.saved };
    });
    const unsubscribe = host.subscribe(receive);
    try { host.send({ type: 'ready' }); }
    catch (error) { receive({ type: 'error', code: 'HOST_ERROR', message: String(error) }); }
    return unsubscribe;
  }, [host]);

  const { state, pending, reason, error, result, saved } = screen;
  const status = state?.status;
  const conflicts = status?.conflicts ?? [];
  const blockedConflict = conflicts.some(conflict => conflict.kind === 'file' && !conflict.managed);
  const conflicting = status?.state === 'conflict' || Boolean(conflicts.length) || status?.mergeInProgress;
  const disabled = Boolean(pending) || !status?.repository;
  const canSave = !pending && !state?.editing && !conflicting && Boolean(status?.changes.length) && reason.trim() !== '';
  const canResolve = !disabled && !state?.editing && Boolean(conflicting) && !blockedConflict
    && conflicts.every(conflict => screen.choices[conflictId(conflict)]?.signature === signature(conflict));

  function send(message: GitClientMessage, action: Pending) {
    if (pending) return;
    setScreen(previous => ({ ...previous, pending: action }));
    try { host.send(message); }
    catch (failure) { setScreen(previous => ({ ...previous, pending: null, error: 'HOST_ERROR: ' + String(failure) })); }
  }
  function resolve() {
    if (!status || !canResolve) return;
    const choices: GitChoice[] = conflicts.map(conflict => ({ file: conflict.file,
      ...(conflict.kind === 'row' ? { key: conflict.key } : {}), choice: screen.choices[conflictId(conflict)]!.choice }));
    send({ type: 'gitResolve', revision: status.revision, choices }, 'resolve');
  }

  return <main className="git-app">
    <header className="git-toolbar">
      <div><h1>저장 · 올리기</h1><p className="git-muted">변경을 사유와 함께 저장하고, 함께 쓰는 작업 공간에 올립니다.</p></div>
      <button disabled={Boolean(pending)} onClick={() => send({ type: 'gitRefresh' }, 'refresh')}>상태 새로고침</button>
    </header>

    <section className="git-section" aria-label="현재 상태">
      <div className="git-status-line"><h2>현재 상태</h2>
        <strong className="git-state" data-state={state?.editing ? 'editing' : status?.state}>
          {state?.editing ? '편집 중' : status ? stateLabels[status.state] : '상태 확인 중…'}
        </strong>
      </div>
      {state?.editing && <p>표에서 편집 중인 값을 적용하거나 취소한 뒤 저장하세요.</p>}
      {status && !status.repository && <p>변경 사유를 적어 첫 저장을 완료하세요.</p>}
      {pending && <p role="status">{progressLabels[pending]}</p>}
      {saved && <div className="git-success" role="status" aria-label="저장 결과">
        <strong>저장 완료</strong>{saved.reason && <span> · {saved.reason}</span>}
      </div>}
      {result && !error && !pending && result.action !== 'save' && <p className={result.completed ? 'git-success' : 'git-warning'}
        role="status" aria-label="작업 결과">{result.completed
          ? { push: '올리기를 완료했습니다.', pull: '받아오기를 완료했습니다.', resolve: '충돌 선택을 적용했습니다.' }[result.action]
          : conflicts.length ? '받은 변경에 충돌이 있습니다. 아래에서 사용할 값을 선택하세요.' : '작업을 완료하지 못했습니다.'}</p>}
      {error && <p className="git-error" role="alert">{error}</p>}
    </section>

    {status && <>
      <div className="git-dashboard">
        <section className="git-section" aria-label="저장할 변경">
          <h2>저장할 변경 <span className="git-muted">{status.changes.length}개 파일</span></h2>
          {status.changes.length ? <ul className="git-files">{status.changes.map(file => <li key={file}><code>{file}</code></li>)}</ul>
            : <p className="git-muted">저장할 기획 파일 변경이 없습니다.</p>}
          {status.otherChanges.length > 0 && <details className="git-other-files">
            <summary>기획 외 변경 파일 {status.otherChanges.length}개</summary>
            <ul className="git-files">{status.otherChanges.map(file => <li key={file}><code>{file}</code></li>)}</ul>
          </details>}
          <form onSubmit={event => { event.preventDefault(); if (canSave) send({ type: 'gitSave', reason, revision: status.revision }, 'save'); }}>
            <label className="git-reason">변경 사유<textarea rows={2} value={reason} disabled={Boolean(pending)}
              onChange={event => setScreen(previous => ({ ...previous, reason: event.target.value }))} /></label>
            <button disabled={!canSave} type="submit">변경 사유와 함께 저장</button>
          </form>
        </section>

        <section className="git-section" aria-label="올릴 변경">
          <h2>올릴 저장 내용 <span className="git-muted">{status.outgoing.length}개</span></h2>
          {status.outgoing.length ? <ul className="git-commits">{status.outgoing.map(commit => <li key={commit.hash}>
            <span className="git-literal">{commit.reason}</span>
            {commit.otherFiles && <strong className="git-warning">기획 외 파일 포함</strong>}
          </li>)}</ul> : <p className="git-muted">올릴 저장 내용이 없습니다.</p>}
          <div className="git-actions">
            <button disabled={disabled || Boolean(conflicting) || status.outgoing.length === 0}
              onClick={() => send({ type: 'gitPush' }, 'push')}>올리기</button>
            <button disabled={disabled || Boolean(conflicting) || state?.editing}
              onClick={() => send({ type: 'gitPull' }, 'pull')}>받아오기</button>
          </div>
        </section>
      </div>

      {conflicting && <section className="git-section" aria-label="충돌 해결">
        <h2>충돌 해결 <span className="git-muted">{conflicts.length}개</span></h2>
        <p>{conflicts.length ? '각 행이나 파일에서 사용할 내용을 선택하세요.' : '충돌이 정리되었습니다. 적용하여 받아온 변경을 마무리하세요.'}</p>
        {conflicts.map(conflict => {
          const id = conflictId(conflict), unmanaged = conflict.kind === 'file' && !conflict.managed;
          return <fieldset key={id} className="git-conflict" disabled={Boolean(pending) || unmanaged}>
            <legend>{conflict.kind === 'row' ? `${conflict.table} / ${conflict.key}` : conflict.file}</legend>
            {conflict.kind === 'row' && <p className="git-muted"><code>{conflict.file}</code></p>}
            {conflict.kind === 'file' && <p className={unmanaged ? 'git-warning' : 'git-muted'}>
              {unmanaged ? '이 화면에서 선택할 수 없습니다. ' : ''}{conflict.reason}</p>}
            <ConflictValues conflict={conflict} />
            <div className="git-choices">{versions.map(({ choice, label }) => <label key={choice}>
              <input type="radio" name={id} value={choice} checked={screen.choices[id]?.choice === choice}
                onChange={() => setScreen(previous => ({ ...previous,
                  choices: { ...previous.choices, [id]: { choice, signature: signature(conflict) } } }))} />{label} 사용
            </label>)}</div>
          </fieldset>;
        })}
        {blockedConflict && <p className="git-warning">선택할 수 없는 파일의 충돌을 먼저 해결한 뒤 상태를 새로고침하세요.</p>}
        <button disabled={!canResolve} onClick={resolve}>충돌 선택 적용</button>
      </section>}

      {result && <section className="git-section" aria-label="작업 후 검증 결과">
        <h2>작업 후 검증 결과</h2>
        {result.diagnostics.length ? <>
          <p className="git-warning">저장·전송 결과와 별도로, 기획 내용에서 확인할 항목이 있습니다.</p>
          <ul className="git-diagnostics">{result.diagnostics.map((diagnostic, index) => <li key={index}>
            <code>{diagnostic.path || diagnostic.file}</code> · <code>{diagnostic.code}</code> · {diagnostic.message}
          </li>)}</ul>
        </> : <p className="git-muted">보고된 검증 오류가 없습니다.</p>}
      </section>}
    </>}
  </main>;
}
