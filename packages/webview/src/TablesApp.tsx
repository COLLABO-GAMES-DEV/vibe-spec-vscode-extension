import { useEffect, useState } from 'react';
import type { StructurePreview, Usages } from '@vibe-spec/core';
import { suggestColumnCode, tableNameError, validColumnCode } from '@vibe-spec/core/names';
import type { TablesClientMessage, TablesHost, TablesHostMessage, TablesMode } from './tablesProtocol.js';
import './tables.css';

type TablesState = Extract<TablesHostMessage, { type: 'tablesState' }>;
type Draft = { name: string; keyLabel: string; keyCode: string; manualCode: boolean };
type Pending = 'create' | 'rename' | 'delete' | 'preview' | 'select' | 'open' | null;
type Screen = {
  state: TablesState | null;
  draft: Draft;
  preview: StructurePreview | null;
  invalidated: boolean;
  confirmed: boolean;
  pending: Pending;
  error: string | null;
};
const initialDraft = (name = ''): Draft => ({ name, keyLabel: 'Key', keyCode: 'key', manualCode: false });
const headings: Record<TablesMode, string> = {
  list: '테이블', create: '새 테이블 만들기', rename: '테이블 이름 바꾸기', delete: '테이블 삭제',
};

function UsageList({ usages }: { usages: Usages }) {
  return <section aria-label="사용처" className="tables-section">
    <h2>사용처</h2>
    {(['references', 'candidates'] as const).map(kind => <section key={kind}
      aria-label={kind === 'references' ? '선언된 참조' : '본문 텍스트 후보'}>
      <h3>{kind === 'references' ? '선언된 참조' : '본문 텍스트 후보'} ({usages[kind].length})</h3>
      {usages[kind].length ? <ul className="tables-usages">{usages[kind].map((usage, index) => <li key={index}>
        <code>{usage.file}:{usage.line}</code>
        {usage.path && <code>{usage.path}</code>}
        <span>{usage.text}</span>
      </li>)}</ul> : <p className="tables-muted">없습니다.</p>}
    </section>)}
  </section>;
}

export function TablesApp({ host }: { host: TablesHost }) {
  const [screen, setScreen] = useState<Screen>({ state: null, draft: initialDraft(), preview: null,
    invalidated: false, confirmed: false, pending: null, error: null });

  useEffect(() => {
    const unsubscribe = host.subscribe(message => setScreen(previous => {
      if (message.type === 'error') return { ...previous, pending: null,
        error: message.code + ': ' + message.message,
        invalidated: previous.invalidated || message.code === 'STALE_REVISION', confirmed: false };
      const changed = previous.state?.mode !== message.mode || previous.state?.selected !== message.selected;
      const revisionChanged = previous.state?.revision !== message.revision;
      const receivedPreview = !changed && previous.pending === 'preview' && message.mode === 'delete'
        && message.preview?.operation.op === 'table-delete'
        && message.preview.operation.table === message.selected
        && message.preview.revision === message.revision;
      const preview = receivedPreview ? message.preview! : changed ? null : previous.preview;
      return { state: message,
        draft: changed ? initialDraft(message.mode === 'rename' ? message.selected : '') : previous.draft,
        preview,
        invalidated: changed ? false : receivedPreview ? preview!.revision !== message.revision
          : previous.invalidated || Boolean(preview && revisionChanged),
        confirmed: changed || revisionChanged || receivedPreview ? false : previous.confirmed,
        pending: changed || receivedPreview ? null : previous.pending,
        // Background refreshes and local validation must not erase a failed submission.
        error: changed ? null : previous.error,
      };
    }));
    host.send({ type: 'ready' });
    return unsubscribe;
  }, [host]);

  const state = screen.state;
  const mode = state?.mode;
  const selectedName = state?.selected;
  useEffect(() => {
    if (mode !== 'delete' || !selectedName) return;
    setScreen(previous => ({ ...previous, pending: 'preview', confirmed: false }));
    host.send({ type: 'tablePreviewDelete', table: selectedName });
  }, [host, mode, selectedName]);

  function send(message: TablesClientMessage, pending: Pending) {
    setScreen(previous => ({ ...previous, pending, error: null,
      ...(pending === 'preview' ? { confirmed: false } : {}) }));
    host.send(message);
  }
  function select(next: TablesMode, table = '') {
    send({ type: 'tableSelect', mode: next, table }, 'select');
  }
  function updateDraft(changes: Partial<Draft>) {
    setScreen(previous => ({ ...previous, draft: { ...previous.draft, ...changes } }));
  }

  if (!state) return <main className="tables-app"><p role="status">테이블을 불러오는 중입니다.</p>
    {screen.error && <p role="alert" className="tables-error">{screen.error}</p>}
    {screen.error && <button onClick={() => host.send({ type: 'tablesRefresh' })}>다시 불러오기</button>}
  </main>;

  const selected = state.tables.find(table => table.name === state.selected);
  const busy = screen.pending !== null;
  const { draft, preview } = screen;
  const nameError = tableNameError(draft.name, state.tables
    .filter(table => state.mode !== 'rename' || table.name !== state.selected).map(table => table.name));
  const codeError = validColumnCode(draft.keyCode) ? undefined : '영문 소문자, 숫자, _만 사용할 수 있습니다.';
  const stale = screen.invalidated || Boolean(preview && preview.revision !== state.revision);
  const canDelete = Boolean(selected && preview?.operation.op === 'table-delete'
    && preview.operation.table === selected.name && !preview.blocked && !stale);

  return <main className="tables-app">
    <header className="tables-toolbar">
      <h1>{headings[state.mode]}</h1>
      {state.mode !== 'list' && <button className="tables-secondary" disabled={busy}
        onClick={() => select('list')}>테이블 목록</button>}
      {state.mode === 'list' && <button disabled={busy} onClick={() => select('create')}>새 테이블 만들기</button>}
    </header>
    {screen.error && <p role="alert" className="tables-error">{screen.error}</p>}
    {state.notice && <p role="status" className="tables-notice">{state.notice}</p>}

    {state.mode === 'list' && <>
      <p className="tables-muted">테이블을 열거나 이름과 사용처를 확인하세요.</p>
      {state.tables.length ? <div className="tables-list-scroll"><table aria-label="테이블 목록">
        <thead><tr><th>테이블 이름</th><th>행 수</th><th>작업</th></tr></thead>
        <tbody>{state.tables.map(table => <tr key={table.name}>
          <th scope="row">{table.name}</th><td>{table.rows.toLocaleString()}행</td>
          <td><div className="tables-actions">
            <button disabled={busy} onClick={() => send({ type: 'tableOpen', table: table.name }, 'open')}>열기</button>
            <button className="tables-secondary" disabled={busy} onClick={() => select('rename', table.name)}>이름 바꾸기</button>
            <button className="tables-secondary" disabled={busy} onClick={() => select('delete', table.name)}>테이블 삭제</button>
          </div></td>
        </tr>)}</tbody>
      </table></div> : <p className="tables-section">아직 테이블이 없습니다. 새 테이블을 만들어 보세요.</p>}
    </>}

    {(state.mode === 'create' || state.mode === 'rename') && <form className="tables-form" onSubmit={event => {
      event.preventDefault();
      if (busy || nameError) return;
      if (state.mode === 'create') {
        if (codeError) return;
        send({ type: 'tableCreate', revision: state.revision, table: draft.name,
          key: { code: draft.keyCode, label: draft.keyLabel } }, 'create');
      } else if (selected && draft.name !== selected.name) {
        send({ type: 'tableRename', revision: state.revision, table: selected.name, to: draft.name }, 'rename');
      }
    }}>
      <p className="tables-muted">{state.mode === 'create'
        ? 'Key는 각 행을 구별하는 고유한 값입니다. 만들면 빈 테이블이 열립니다.'
        : '새 이름을 입력하세요. 다른 테이블의 연결도 함께 바뀝니다.'}</p>
      {state.mode === 'rename' && <p>현재 테이블: <strong>{state.selected}</strong></p>}
      {state.mode === 'rename' && !selected && <p role="alert" className="tables-error">선택한 테이블을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.</p>}
      <div className="tables-field">
        <label htmlFor="table-name">테이블 이름</label>
        <input id="table-name" value={draft.name} autoComplete="off" spellCheck={false}
          disabled={busy} aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'table-name-error' : undefined}
          onChange={event => updateDraft({ name: event.target.value })} />
        {nameError && <p id="table-name-error" className="tables-field-error" role="alert">{nameError}</p>}
      </div>
      {state.mode === 'create' && <>
        <div className="tables-field">
          <label htmlFor="table-key-label">Key 표시명</label>
          <input id="table-key-label" value={draft.keyLabel} disabled={busy} onChange={event => {
            const keyLabel = event.target.value;
            updateDraft({ keyLabel, ...(!draft.manualCode ? { keyCode: suggestColumnCode(keyLabel, []) } : {}) });
          }} />
        </div>
        <div className="tables-field">
          <label htmlFor="table-key-code">Key 코드명</label>
          <input id="table-key-code" value={draft.keyCode} disabled={busy} autoComplete="off" spellCheck={false}
            aria-invalid={Boolean(codeError)} aria-describedby={'table-key-help' + (codeError ? ' table-key-error' : '')}
            onChange={event => updateDraft({ keyCode: event.target.value, manualCode: true })} />
          <p id="table-key-help" className="tables-muted">표시명을 바탕으로 제안합니다. 직접 바꾼 코드명은 유지됩니다.</p>
          {codeError && <p id="table-key-error" className="tables-field-error" role="alert">{codeError}</p>}
        </div>
      </>}
      <button type="submit" disabled={busy || Boolean(nameError) || (state.mode === 'create' ? Boolean(codeError)
        : !selected || draft.name === selected.name)}>{state.mode === 'create' ? '새 테이블 만들기' : '이름 바꾸기'}</button>
    </form>}

    {state.mode === 'delete' && <>
      <p><strong>{state.selected}</strong>{selected && <> · {selected.rows.toLocaleString()}행</>}</p>
      <p className="tables-muted">사용처와 삭제할 파일을 확인해 주세요. 테이블의 모든 행이 함께 삭제됩니다.</p>
      {!selected && <p role="alert" className="tables-error">선택한 테이블을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.</p>}
      <button className="tables-secondary" disabled={busy || !selected}
        onClick={() => send({ type: 'tablePreviewDelete', table: selected!.name }, 'preview')}>
        {preview || stale ? '삭제 내용 다시 확인' : '삭제 내용 확인'}
      </button>
      {screen.pending === 'preview' && <p role="status">삭제할 내용과 사용처를 확인하는 중입니다.</p>}
      {stale && <p role="alert" className="tables-warning">파일이 변경되었습니다. 삭제 내용을 다시 확인하고 확인란을 선택해 주세요.</p>}
      {preview && <>
        {preview.blocked && <section className="tables-error" aria-label="삭제 차단 사유" role="alert">
          <h2>삭제할 수 없습니다</h2><p>{preview.blocked}</p>
        </section>}
        <section className="tables-section" aria-label="영향받는 파일">
          <h2>영향받는 파일</h2>
          {preview.files.length ? <ul>{preview.files.map(file => <li key={file}><code>{file}</code></li>)}</ul>
            : <p className="tables-muted">없습니다.</p>}
        </section>
        <UsageList usages={preview.usages} />
      </>}
      <div className="tables-delete-actions">
        <label className="tables-confirm"><input type="checkbox" checked={screen.confirmed} disabled={busy || !canDelete}
          onChange={event => setScreen(previous => ({ ...previous, confirmed: event.target.checked }))} />
          삭제할 내용을 확인했습니다</label>
        <button disabled={busy || !canDelete || !screen.confirmed} onClick={() => {
          if (!canDelete || !screen.confirmed || !preview || !selected) return;
          send({ type: 'tableDelete', revision: preview.revision, table: selected.name, confirmed: true }, 'delete');
        }}>테이블 삭제</button>
      </div>
    </>}
  </main>;
}
