import { useEffect, useState } from 'react';
import type { Cell, Column, ImportCell, ImportIssue, ImportMapping, ImportSheet } from '@vibe-spec/core';
import { inferImportColumnType } from '@vibe-spec/core/import-values';
import type { ImportHost, ImportHostMessage } from './importProtocol.js';
import './import.css';

type ImportState = Extract<ImportHostMessage, { type: 'importState' }>;
type ColumnDraft = { code: string; type: Column['type']; typeEdited?: boolean; values: string; table: string };
type Draft = {
  sheet: string; header: string; start: string; data: string;
  table: string; folder: string; schema: string; existing: string; key: string;
  numeric: ImportMapping['numeric']; columns: Record<string, ColumnDraft>;
  representations: NonNullable<ImportMapping['representations']>;
};
type Screen = {
  state: ImportState | null; draft: Draft | null; version: number; planned: number | null;
  pending: 'plan' | 'apply' | null; submitted: number | null; error: string | null;
};
const limit = 50;
const types: Column['type'][] = ['string', 'text', 'integer', 'decimal', 'boolean', 'enum', 'ref'];
const keyTypes: Column['type'][] = ['string', 'text', 'integer'];
function columnType(column: ColumnDraft, key: boolean): Column['type'] {
  if (!key || column.type === 'integer' || column.typeEdited && keyTypes.includes(column.type)) return column.type;
  return 'string';
}
const literal = (value: Cell | undefined) => value === undefined ? '(저장 값 없음)' : value === null ? 'null' : String(value);
const columnIndex = (column: string) => [...column].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
const positiveRow = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

function sheetDraft(sheet: ImportSheet) {
  const columns = Object.fromEntries(sheet.columns.map(source => {
    const header = sheet.cells[source + sheet.header_row]?.raw;
    return [source, { code: typeof header === 'string' && header !== '' ? header : source,
      type: sheet.inferredTypes?.[source] ?? inferImportColumnType(sheet, source), values: '', table: '' }];
  }));
  return { sheet: sheet.name, header: String(sheet.header_row), start: sheet.start_column,
    data: String(sheet.data_start_row), columns,
    key: sheet.columns.find(column => columnIndex(column) >= columnIndex(sheet.start_column)) ?? '',
    representations: {} };
}

function initialDraft(sheet: ImportSheet): Draft {
  return { ...sheetDraft(sheet), table: '', folder: '', schema: '', existing: '', numeric: 'stored' };
}

function inferDraft(sheet: ImportSheet, draft: Draft): Draft {
  if (!positiveRow(draft.data) || !positiveRow(draft.header)) return draft;
  return { ...draft, columns: Object.fromEntries(Object.entries(draft.columns).map(([source, column]) =>
    [source, column.typeEdited ? column : { ...column, type: inferImportColumnType(sheet, source, {
      dataStartRow: Number(draft.data), excludeRows: [Number(draft.header)],
      numeric: draft.numeric, representations: draft.representations,
    }) }])) };
}

function selectedColumns(draft: Draft) {
  return Object.entries(draft.columns).filter(([source, column]) =>
    columnIndex(source) >= columnIndex(draft.start) && column.code !== '');
}

function mappingFor(draft: Draft): ImportMapping {
  const selected = selectedColumns(draft);
  const mapping: ImportMapping = {
    table: draft.table, ...(draft.folder ? { folder: draft.folder } : {}), schema: draft.existing || draft.schema, sheet: draft.sheet,
    header_row: Number(draft.header), data_start_row: Number(draft.data),
    columns: Object.fromEntries(selected.map(([source, column]) => [source, column.code])),
    numeric: draft.numeric,
    ...(Object.keys(draft.representations).length ? { representations: draft.representations } : {}),
  };
  if (!draft.existing) mapping.definition = {
    primary_key: draft.columns[draft.key]?.code ?? '',
    columns: Object.fromEntries(selected.map(([source, column]) => {
      const type = columnType(column, source === draft.key);
      return [column.code, { type, ...(source === draft.key ? { required: true } : {}),
        ...(type === 'enum' ? { values: column.values === '' ? [] : column.values.split('\n') } : {}),
        ...(type === 'ref' ? { table: column.table } : {}) }];
    })),
  };
  return mapping;
}

function Issues({ issues }: { issues: ImportIssue[] }) {
  return issues.length ? <ul className="import-issues">{issues.map((issue, index) =>
    <li key={index} data-severity={issue.severity}>
      <strong>{issue.severity === 'error' ? '오류 / 지원 불가' : '경고'}</strong>{' '}
      <code>{issue.code}</code>{' '}
      {(issue.sheet || issue.cell) && <code>{issue.sheet}{issue.cell ? '!' + issue.cell : ''}</code>}{' '}
      {issue.message}
    </li>)}</ul> : <p className="import-muted">보고된 경고나 지원 불가 항목이 없습니다.</p>;
}

function SourceValue({ cell }: { cell: ImportCell | undefined }) {
  return <>
    <span className="import-literal">{literal(cell?.raw)}</span>
    {cell?.normalizedInteger !== undefined && <div className="import-candidate">
      정수로 가져올 값: <span className="import-literal">{cell.normalizedInteger}</span>
      <span> · XLSX 숫자 셀 정규화 · 저장 원문은 출처 기록에 보존</span>
    </div>}
    {cell?.display !== undefined && cell.display !== cell.raw && <div className="import-candidate">
      계산된 표시 후보: <span className="import-literal">{cell.display}</span>
      {cell.displaySafe !== true && <span> · 안전한 변환을 보장할 수 없음</span>}
    </div>}
    {cell?.formula !== undefined && <div>수식: <code>{cell.formula}</code></div>}
    {cell?.unsupported && <div className="import-unsupported">지원 불가: {cell.unsupported}</div>}
  </>;
}

export function ImportApp({ host }: { host: ImportHost }) {
  const [screen, setScreen] = useState<Screen>({ state: null, draft: null, version: 0, planned: null,
    pending: null, submitted: null, error: null });

  useEffect(() => {
    const unsubscribe = host.subscribe(message => setScreen(previous => {
      if (message.type === 'error') return { ...previous, pending: null, planned: null,
        error: message.code + ': ' + message.message };
      const old = previous.state?.inspection, next = message.inspection ?? old;
      const changed = next && (!old || old.sourceHash !== next.sourceHash || old.file !== next.file);
      const first = next?.sheets[0];
      const draft = changed ? (first ? initialDraft(first) : null) : previous.draft;
      // An answer for a mapping edited while planning remains visible, but cannot be applied.
      const planned = !changed && message.plan && previous.pending === 'plan'
        && message.plan.sourceHash === next?.sourceHash ? previous.submitted : null;
      return { ...previous, state: { ...message, ...(next ? { inspection: next } : {}) }, draft, version: previous.version + (changed ? 1 : 0),
        planned, pending: null, submitted: null, error: null };
    }));
    host.send({ type: 'ready' });
    return unsubscribe;
  }, [host]);

  const { state, draft, pending } = screen;
  const inspection = state?.inspection;
  const sheet = inspection?.sheets.find(item => item.name === draft?.sheet);
  const schema = draft?.existing ? state?.schemas[draft.existing] : undefined;
  const plan = state?.plan;
  const planSheet = inspection?.sheets.find(item => item.name === plan?.mapping.sheet);
  const fresh = Boolean(plan && screen.planned === screen.version && plan.revision === state?.revision);
  const mapped = draft ? selectedColumns(draft) : [];
  const key = schema ? mapped.find(([, column]) => column.code === schema.primary_key)?.[0] : draft?.key;
  const invalid = !draft || !sheet || !draft.table || !(draft.existing || draft.schema)
    || !positiveRow(draft.header) || !positiveRow(draft.data) || Number(draft.data) <= Number(draft.header)
    || !mapped.length || !mapped.some(([source]) => source === key)
    || new Set(mapped.map(([, column]) => column.code)).size !== mapped.length;
  const canApply = Boolean(plan?.canApply && fresh && !pending && !state?.applied);

  function change(update: (value: Draft) => Draft) {
    setScreen(previous => {
      const old = previous.draft;
      if (!old) return previous;
      let next = update(old);
      const source = previous.state?.inspection?.sheets.find(item => item.name === next.sheet);
      if (source && (next.sheet !== old.sheet || next.header !== old.header || next.data !== old.data
        || next.numeric !== old.numeric || next.representations !== old.representations)) next = inferDraft(source, next);
      return { ...previous, draft: next, version: previous.version + 1, error: null };
    });
  }
  function field<K extends keyof Draft>(name: K, value: Draft[K]) {
    change(current => ({ ...current, [name]: value }));
  }
  function columnField(source: string, update: Partial<ColumnDraft>) {
    change(current => ({ ...current, columns: { ...current.columns,
      [source]: { ...current.columns[source]!, ...update } } }));
  }
  function chooseKey(source: string) {
    if (!schema) { field('key', source); return; }
    change(current => ({ ...current, columns: Object.fromEntries(Object.entries(current.columns)
      .map(([name, column]) => [name, { ...column, code: name === source ? schema.primary_key
        : column.code === schema.primary_key ? '' : column.code }])) }));
  }
  function preview() {
    if (!draft || invalid || pending) return;
    setScreen(previous => ({ ...previous, pending: 'plan', submitted: previous.version,
      planned: null, error: null }));
    host.send({ type: 'importPlan', mapping: mappingFor(draft) });
  }
  function apply() {
    if (!plan || !canApply) return;
    setScreen(previous => ({ ...previous, pending: 'apply', error: null }));
    host.send({ type: 'importApply', revision: plan.revision });
  }

  const sourceRows = sheet && draft && positiveRow(draft.data)
    ? Array.from({ length: Math.min(limit, Math.max(0, sheet.rowCount - Number(draft.data) + 1)) },
      (_, index) => Number(draft.data) + index) : [];
  const sourceColumns = sheet?.columns.filter(column => draft && columnIndex(column) >= columnIndex(draft.start)) ?? [];

  return <main className="import-app">
    <header className="import-toolbar">
      <div><h1>파일 불러오기</h1><p>CSV · TSV · XLSX를 조사하고, 매핑과 미리보기를 확인한 뒤 적용합니다.</p></div>
      <button disabled={Boolean(pending)} onClick={() => {
        setScreen(previous => ({ ...previous, planned: null, error: null }));
        host.send({ type: 'importPick' });
      }}>파일 선택</button>
    </header>
    {screen.error && <p className="import-error" role="alert">{screen.error}</p>}
    {!state && <p role="status">불러오기 준비 중…</p>}
    {state && !inspection && <p className="import-empty">불러올 파일을 선택하세요. 적용 전에는 기획 파일을 변경하지 않습니다.</p>}
    {inspection && <>
      <section aria-label="파일 조사" className="import-section">
        <h2>1. 파일 조사</h2>
        <p className="import-file"><code>{inspection.file}</code> · {inspection.format.toUpperCase()}</p>
        <Issues issues={inspection.issues} />
        {!inspection.sheets.length && <p role="alert">불러올 수 있는 시트가 없습니다.</p>}
      </section>
      {draft && sheet && <>
        <fieldset className="import-section import-fields" disabled={pending === 'apply'}>
          <legend>2. 범위와 대상</legend>
          <div className="import-field-grid">
            <label>시트<select value={draft.sheet} onChange={event => {
              const next = inspection.sheets.find(item => item.name === event.target.value);
              if (next) change(current => ({ ...current, ...sheetDraft(next) }));
            }}>{inspection.sheets.map(item => <option key={item.name}>{item.name}</option>)}</select></label>
            <label>헤더 행<input type="number" min="1" step="1" value={draft.header}
              onChange={event => field('header', event.target.value)} /></label>
            <label>시작 열<select value={draft.start} onChange={event => field('start', event.target.value)}>
              {sheet.columns.map(column => <option key={column}>{column}</option>)}
            </select></label>
            <label>데이터 시작 행<input type="number" min="1" step="1" value={draft.data}
              onChange={event => field('data', event.target.value)} /></label>
            <label>테이블 이름<input value={draft.table} placeholder="imported-items"
              onChange={event => field('table', event.target.value)} /></label>
            <label>대상 폴더<input value={draft.folder} placeholder="비워 두면 최상위"
              onChange={event => field('folder', event.target.value)} /></label>
            <label>스키마<select value={draft.existing} onChange={event => field('existing', event.target.value)}>
              <option value="">새 스키마 정의</option>
              {Object.keys(state?.schemas ?? {}).map(name => <option key={name} value={name}>{name}</option>)}
            </select></label>
            {!draft.existing && <label>스키마 이름<input value={draft.schema} placeholder="imported-items"
              onChange={event => field('schema', event.target.value)} /></label>}
          </div>
          <p className="import-muted">조사 제안: 헤더 {sheet.start_column}{sheet.header_row}, 데이터 {sheet.start_column}{sheet.data_start_row}.
            원본 마지막 행 {sheet.rowCount}. 열 코드명과 Key는 직접 확인하세요.</p>
          {schema && <p>기존 스키마의 Key: <code>{schema.primary_key}</code>. 연결할 원본 열 하나를 선택하세요.</p>}
          <div className="import-table-scroll"><table className="import-mapping" aria-label="열 매핑">
            <thead><tr><th scope="col">원본 열 / 헤더</th><th scope="col">열 코드명</th><th scope="col">Key</th>
              <th scope="col">타입</th><th scope="col">타입 옵션</th></tr></thead>
            <tbody>{sourceColumns.map(source => {
              const column = draft.columns[source]!;
              const selected = source === key;
              const type = schema?.columns[column.code]?.type ?? columnType(column, selected);
              return <tr key={source}>
                <th scope="row"><code>{source}{draft.header}</code><div className="import-literal">{literal(sheet.cells[source + draft.header]?.raw)}</div></th>
                <td>{schema ? <select aria-label={`${source} 열 코드명`} value={column.code}
                  onChange={event => columnField(source, { code: event.target.value })}>
                  <option value="">제외</option>
                  {!schema.columns[column.code] && column.code && <option value={column.code}>{column.code} (연결할 열 선택)</option>}
                  {Object.keys(schema.columns).map(code => <option key={code}>{code}</option>)}
                </select> : <input aria-label={`${source} 열 코드명`} value={column.code} placeholder="비우면 제외"
                  onChange={event => columnField(source, { code: event.target.value })} />}</td>
                <td><input type="radio" name="import-key" aria-label={`${source} 열을 Key로 선택`}
                  checked={selected} disabled={!schema && !column.code} onChange={() => chooseKey(source)} /></td>
                <td>{schema ? <span>{schema.columns[column.code]?.type ?? '—'}</span>
                  : <select aria-label={`${source} 열 타입`} value={type} disabled={!column.code}
                    onChange={event => columnField(source, { type: event.target.value as Column['type'], typeEdited: true })}>
                    {(selected ? keyTypes : types).map(value => <option key={value}>{value}</option>)}
                  </select>}</td>
                <td>{!schema && type === 'enum' && <label>허용값 (한 줄에 하나)<textarea aria-label={`${source} enum 허용값`}
                  rows={3} value={column.values} onChange={event => columnField(source, { values: event.target.value })} /></label>}
                {!schema && type === 'ref' && <label>참조 대상 테이블<input aria-label={`${source} 참조 테이블`} value={column.table}
                  onChange={event => columnField(source, { table: event.target.value })} /></label>}
                {schema?.columns[column.code]?.values && <span>{schema.columns[column.code]!.values!.join(', ')}</span>}
                {schema?.columns[column.code]?.table && <code>{schema.columns[column.code]!.table}</code>}</td>
              </tr>;
            })}</tbody>
          </table></div>
          <p className="import-muted">빈 코드명은 해당 열을 제외합니다. 값이 모두 정수인 열은 integer로 제안하고, 나머지는 text (Key는 string)로 제안합니다. 직접 선택한 타입은 유지됩니다. Key는 string·text·integer를 사용할 수 있습니다.</p>
          <fieldset className="import-numeric"><legend>숫자 표현</legend>
            <label><input type="radio" name="import-numeric" value="stored" checked={draft.numeric === 'stored'}
              onChange={() => field('numeric', 'stored')} />저장 원문</label>
            <label><input type="radio" name="import-numeric" value="display" checked={draft.numeric === 'display'}
              onChange={() => field('numeric', 'display')} />계산된 표시 후보</label>
            <p>계산된 표시 후보는 서식으로 계산한 값이며 원문이 아닙니다. 원본 프로그램에서 잃은 정밀도를 복원하지 않습니다.</p>
            <p>XLSX 정수 숫자 셀은 이 설정과 관계없이 정수 문자열로 가져옵니다. 텍스트 셀의 원문은 바꾸지 않습니다.</p>
          </fieldset>
        </fieldset>

        <section className="import-section" aria-label="원본 값 미리보기">
          <h2>원본 값과 좌표</h2>
          <p>데이터 시작 행부터 최대 {limit}행을 표시합니다. 원본 마지막 행: {sheet.rowCount}.</p>
          <div className="import-table-scroll"><table><thead><tr><th scope="col">원본 행</th>
            {sourceColumns.map(source => <th scope="col" key={source}>{source}</th>)}</tr></thead>
            <tbody>{sourceRows.map(row => <tr key={row}><th scope="row">{row}</th>{sourceColumns.map(source => {
              const address = source + row, cell = sheet.cells[address];
              return <td key={source}><code className="import-coordinate">{address}</code><SourceValue cell={cell} />
                {cell?.normalizedInteger === undefined && cell?.display !== undefined && cell.display !== cell.raw && <label className="import-representation">이 셀의 표현
                  <select aria-label={`${address} 숫자 표현`} disabled={pending === 'apply'}
                    value={draft.representations[address] ?? ''} onChange={event => {
                      const value = event.target.value;
                      change(current => {
                        const representations = { ...current.representations };
                        if (value) representations[address] = value as 'stored' | 'display';
                        else delete representations[address];
                        return { ...current, representations };
                      });
                    }}><option value="">전체 설정 사용</option><option value="stored">저장 원문</option>
                    <option value="display" disabled={cell.displaySafe !== true}>계산된 표시 후보{cell.displaySafe !== true ? ' (지원 불가)' : ''}</option>
                  </select></label>}
              </td>;
            })}</tr>)}</tbody>
          </table></div>
        </section>

        <section className="import-section" aria-label="불러오기 미리보기">
          <div className="import-preview-heading"><h2>3. 미리보기와 적용</h2>
            <button disabled={invalid || Boolean(pending)} onClick={preview}>{pending === 'plan' ? '미리보기 생성 중…' : '미리보기'}</button>
          </div>
          {invalid && <p className="import-muted">테이블·스키마 이름, 헤더 뒤의 데이터 시작 행, 서로 다른 열 코드명과 Key 열 하나를 지정하세요.</p>}
          {!plan && <p>미리보기를 생성하면 대상 파일, 값, 경고와 검증 결과를 확인할 수 있습니다. 아직 파일은 변경하지 않습니다.</p>}
          {plan && <>
            {!fresh && !state?.applied && <p className="import-warning" role="status">매핑 또는 파일 상태가 변경되었습니다. 미리보기를 다시 생성하세요.</p>}
            <h3>대상 파일</h3><ul>{plan.files.map(file => <li key={file}><code>{file}</code></li>)}</ul>
            <p data-testid="import-row-count">전체 {plan.rows.length}행 · 처음 {Math.min(limit, plan.rows.length)}행 미리보기</p>
            <p>시트 <code>{plan.mapping.sheet}</code> · 헤더 {plan.mapping.header_row}행 · 데이터 {plan.mapping.data_start_row}행부터 ·
              숫자 표현: {plan.mapping.numeric === 'display' ? '계산된 표시 후보 (원문 아님)' : '저장 원문'}</p>
            <p>XLSX 정수 숫자 셀은 정수 문자열로 적용하며, 원래 저장값은 출처 기록에 보존합니다.</p>
            <p>제외한 원본 열: {planSheet?.columns.filter(column => !(column in plan.mapping.columns)).join(', ') || '없음'} ·
              별도 제외 행: {plan.mapping.exclude_rows?.join(', ') || '없음'}</p>
            {Object.keys(plan.mapping.representations ?? {}).length > 0 && <p>셀별 표현: {Object.entries(plan.mapping.representations!)
              .map(([address, value]) => `${address}: ${value === 'display' ? '계산된 표시 후보 (원문 아님)' : '저장 원문'}`).join(', ')}</p>}
            <div className="import-table-scroll"><table aria-label="적용 값 미리보기"><thead><tr><th scope="col">원본 행</th>
              {Object.entries(plan.mapping.columns).map(([source, code]) => <th scope="col" key={source}>{source} → {code}</th>)}
            </tr></thead><tbody>{plan.rows.slice(0, limit).map((row, index) => <tr key={index}>
              <th scope="row">{row.sourceRow}</th>{Object.entries(plan.mapping.columns).map(([source, code]) => {
                const address = source + row.sourceRow;
                const original = planSheet?.cells[address];
                return <td key={source}><code className="import-coordinate">{address}</code>
                  <span className="import-literal">{literal(row.values[code])}</span>
                  {original?.normalizedInteger !== undefined && <div className="import-candidate">
                    저장 원문: <span className="import-literal">{literal(original.raw)}</span><br />
                    정수 정규화: <span className="import-literal">{original.normalizedInteger}</span>
                  </div>}
                  {original?.display !== undefined && original.display !== original.raw && <div className="import-candidate">
                    저장 원문: <span className="import-literal">{literal(original.raw)}</span><br />
                    계산된 표시 후보 (원문 아님): <span className="import-literal">{original.display}</span>
                  </div>}
                </td>;
              })}</tr>)}</tbody></table></div>
            <h3>경고 / 지원 불가</h3><Issues issues={plan.issues} />
            <h3>검증 결과</h3>{plan.diagnostics.length ? <ul className="import-issues">{plan.diagnostics.map((diagnostic, index) =>
              <li key={index}><code>{diagnostic.code}</code>{' '}<code>{diagnostic.file}</code>{' '}
                <code>{diagnostic.path}</code>{' '}{diagnostic.message}</li>)}</ul> : <p>검증 오류가 없습니다.</p>}
            {!plan.canApply && <p className="import-warning">적용할 수 없습니다. 위 항목을 확인하고 매핑을 수정하세요.</p>}
          </>}
          <button disabled={!canApply} onClick={apply}>{pending === 'apply' ? '적용 중…' : '적용'}</button>
          {state?.applied && <div className="import-success" role="status"><strong>불러오기를 적용했습니다.</strong>
            <p>변경된 파일</p><ul>{state.changed?.map(file => <li key={file}><code>{file}</code></li>)}</ul>
          </div>}
          {state?.applied && <section aria-label="적용 후 검증 결과"><h3>적용 후 검증 결과</h3>
            {state.diagnostics?.length ? <ul className="import-issues">{state.diagnostics.map((diagnostic, index) =>
              <li key={index}><code>{diagnostic.path || diagnostic.file}</code> {diagnostic.code}: {diagnostic.message}</li>)}</ul>
              : <p>검증 오류가 없습니다.</p>}
          </section>}
        </section>
      </>}
    </>}
  </main>;
}
