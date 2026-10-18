import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';
import type { Column, ColumnPosition, StructureOperation, StructurePreview } from '@vibe-spec/core';
import { suggestColumnCode, validColumnCode } from '@vibe-spec/core/names';
import type { Host, Snapshot } from './protocol';
import './columns.css';

export type ColumnChange =
  | { kind: 'structure'; operation: StructureOperation; revision?: string }
  | { kind: 'rename'; column: string; to: string; revision: string };
export interface ColumnEditorHandle { open(column: string, x: number, y: number): void }
interface Form {
  kind: 'add' | 'update' | 'rename' | 'delete';
  column: string;
  revision: string;
  original: Column;
  position?: ColumnPosition;
  label: string;
  code: string;
  codeEdited: boolean;
  type: Column['type'];
  required: boolean;
  values: string;
  table: string;
  confirmed: boolean;
}
const types: [Column['type'], string][] = [
  ['string', '텍스트'], ['text', '여러 줄 텍스트'], ['integer', '정수'], ['decimal', '소수'],
  ['boolean', '참/거짓'], ['enum', '선택지'], ['ref', '참조'],
];

export function ColumnEditor({ host, snapshot, control, busy, error, onWrite, onDraftChange, onClose }: {
  host: Host; snapshot: Snapshot; control: Ref<ColumnEditorHandle>; busy: boolean; error: string;
  onWrite: (change: ColumnChange, applied: () => void) => void;
  onDraftChange: (active: boolean) => void;
  onClose: () => void;
}) {
  const [menu, setMenu] = useState<{ column: string; x: number; y: number }>();
  const [form, setForm] = useState<Form>();
  const formRef = useRef(form); formRef.current = form;
  const [preview, setPreview] = useState<StructurePreview>();
  const [previewError, setPreviewError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const isOpen = Boolean(form);
  useImperativeHandle(control, () => ({ open(column, x, y) {
    // App opens this only after withCommit has received its acknowledgement.
    if (!formRef.current) setMenu({ column, x, y });
  } }), []);
  useEffect(() => { onDraftChange(isOpen); }, [isOpen, onDraftChange]);
  useEffect(() => {
    if (isOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [isOpen]);
  useEffect(() => {
    if (!menu) return;
    menuElement.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: globalThis.PointerEvent) => {
      if (!menuElement.current?.contains(event.target as Node)) setMenu(undefined);
    };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [menu]);
  useEffect(() => host.subscribe(message => {
    const current = formRef.current;
    if (current?.kind !== 'delete') return;
    if (message.type === 'structurePreview' && message.preview.operation.op === 'column-delete'
      && message.preview.operation.table === snapshot.table && message.preview.operation.column === current.column) {
      setPreview(message.preview); setPreviewError('');
    }
    if (message.type === 'error' && !message.requestId) setPreviewError(message.code + ': ' + message.message);
  }), [host, snapshot.table]);

  function close(focus = true) {
    dialog.current?.close(); setForm(undefined); formRef.current = undefined; setPreview(undefined); setPreviewError('');
    if (focus) onClose();
  }
  function requestPreview(column: string) {
    setPreview(undefined); setPreviewError('');
    host.send({ type: 'structurePreview', operation: { op: 'column-delete', table: snapshot.table, column } });
  }
  function open(kind: Form['kind'], side?: ColumnPosition['side']) {
    if (!menu) return;
    const definition = snapshot.schema.columns[menu.column];
    if (!definition || kind === 'delete' && menu.column === snapshot.schema.primary_key) return;
    const next: Form = {
      kind, column: menu.column, revision: snapshot.revision, original: definition, ...(side ? { position: { anchor: menu.column, side } } : {}),
      label: kind === 'add' ? '' : definition.label ?? menu.column,
      code: kind === 'add' ? suggestColumnCode('', Object.keys(snapshot.schema.columns)) : menu.column,
      codeEdited: false, type: kind === 'add' ? 'string' : definition.type,
      required: kind === 'add' ? false : Boolean(definition.required || menu.column === snapshot.schema.primary_key),
      values: kind === 'add' ? '' : (definition.values ?? []).join('\n'),
      table: kind === 'add' ? '' : definition.table ?? '', confirmed: false,
    };
    setForm(next); formRef.current = next; setMenu(undefined);
    if (kind === 'delete') requestPreview(next.column);
  }
  function change(values: Partial<Form>) { setForm(current => current ? { ...current, ...values } : current); }

  const existing = Object.keys(snapshot.schema.columns);
  const values = form?.values.split(/\r?\n/).filter(value => value.length > 0) ?? [];
  const codeError = form && (form.kind === 'add' || form.kind === 'rename' && form.code !== form.column)
    ? !validColumnCode(form.code) ? '코드명은 영문 소문자, 숫자, 밑줄(_)만 사용할 수 있습니다.'
      : existing.includes(form.code) && (form.kind === 'add' || form.code !== form.column) ? '이미 같은 코드명의 열이 있습니다.' : '' : '';
  const definitionError = form && (form.kind === 'add' || form.kind === 'update')
    ? form.type === 'enum' && !values.length ? '선택지 값을 한 줄에 하나씩 입력해 주세요.'
      : form.type === 'enum' && new Set(values).size !== values.length ? '선택지 값은 서로 달라야 합니다.'
        : form.type === 'ref' && !form.table ? '참조할 표를 선택해 주세요.' : '' : '';
  // A preview may arrive after a newer snapshot. It must still match the version
  // the person opened, until they explicitly ask to review the new impact.
  const stalePreview = preview && (preview.revision !== form?.revision || preview.revision !== snapshot.revision);
  const sharedTables = preview?.tables ?? snapshot.schemaTables ?? [snapshot.table];
  const title = form?.kind === 'add' ? '열 삽입' : form?.kind === 'update' ? '열 수정'
    : form?.kind === 'rename' ? '코드명 바꾸기' : '열 삭제';
  const invalid = Boolean(codeError || definitionError || form?.kind === 'rename' && form.code === form.column
    || form?.kind === 'delete' && (!preview || preview.blocked || stalePreview || !form.confirmed));

  function submit() {
    if (!form || busy || invalid) return;
    const done = () => close(false);
    if (form.kind === 'rename') { onWrite({ kind: 'rename', column: form.column, to: form.code, revision: form.revision }, done); return; }
    if (form.kind === 'delete') {
      if (!preview || form.column === snapshot.schema.primary_key) return;
      onWrite({ kind: 'structure', operation: preview.operation, revision: form.revision }, done); return;
    }
    const definition: Column = { type: form.type, label: form.label, required: form.required,
      ...(form.type === 'enum' ? { values } : {}), ...(form.type === 'ref' ? { table: form.table } : {}) };
    const changes: Partial<Column> = {};
    if (form.label !== (form.original.label ?? form.column)) changes.label = form.label;
    if (form.type !== form.original.type) changes.type = form.type;
    if (form.required !== Boolean(form.original.required || form.column === snapshot.schema.primary_key)) changes.required = form.required;
    if (form.type === 'enum' && (form.original.type !== 'enum' || JSON.stringify(values) !== JSON.stringify(form.original.values))) changes.values = values;
    if (form.type === 'ref' && (form.original.type !== 'ref' || form.table !== form.original.table)) changes.table = form.table;
    const operation: StructureOperation = form.kind === 'add'
      ? { op: 'column-add', table: snapshot.table, column: form.code, definition, ...(form.position ? { position: form.position } : {}) }
      : { op: 'column-update', table: snapshot.table, column: form.column, changes };
    onWrite({ kind: 'structure', operation, revision: form.revision }, done);
  }

  return <>
    {menu && <div className="column-menu" role="menu" aria-label="열 작업" ref={menuElement} data-view-controls
      style={{ left: Math.max(0, Math.min(menu.x, window.innerWidth - 200)), top: Math.max(0, Math.min(menu.y, window.innerHeight - 205)) }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setMenu(undefined); onClose(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      }}>
      <button role="menuitem" disabled={busy || menu.column === snapshot.schema.primary_key} onClick={() => open('add', 'before')}>왼쪽에 열 삽입</button>
      <button role="menuitem" disabled={busy} onClick={() => open('add', 'after')}>오른쪽에 열 삽입</button>
      <button role="menuitem" disabled={busy} onClick={() => open('update')}>열 수정</button>
      <button role="menuitem" disabled={busy} onClick={() => open('rename')}>코드명 바꾸기</button>
      <button role="menuitem" disabled={busy || menu.column === snapshot.schema.primary_key} onClick={() => open('delete')}>열 삭제</button>
    </div>}
    <dialog className="column-dialog" ref={dialog} aria-label={title} data-view-controls
      onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
      {form && <form onSubmit={event => { event.preventDefault(); submit(); }} onKeyDown={event => {
        if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
      }}>
        <h2>{title}</h2>
        {sharedTables.length > 1 && <p className="column-shared" role="note">공유 스키마 영향: {sharedTables.join(', ')}. 이 표들에 함께 반영됩니다.</p>}
        {form.kind === 'delete' ? <>
          <p><strong>{form.label}</strong> <code>{form.column}</code> 열과 저장된 값이 삭제됩니다.</p>
          {!preview && !previewError && <p aria-live="polite">사용처와 변경 파일을 확인하는 중입니다…</p>}
          {previewError && <p className="column-error">{previewError}</p>}
          {preview && <>
            <section aria-label="영향받는 표"><h3>영향받는 표</h3><ul>{preview.tables.map(table => <li key={table}>{table}</li>)}</ul></section>
            <section aria-label="변경 파일"><h3>변경 파일</h3><ul>{preview.files.map(file => <li key={file}><code>{file}</code></li>)}</ul></section>
            {(['references', 'candidates'] as const).map(kind => <section key={kind} aria-label={kind === 'references' ? '선언된 참조' : '본문 텍스트 후보'}>
              <h3>{kind === 'references' ? '선언된 참조' : '본문 텍스트 후보'} ({preview.usages[kind].length})</h3>
              {preview.usages[kind].length ? <ul>{preview.usages[kind].map((usage, index) => <li key={index}>
                <code>{usage.path || `${usage.file}:${usage.line}`}</code><p>{usage.text}</p>
              </li>)}</ul> : <p className="muted">없음</p>}
            </section>)}
            {preview.blocked && <p className="column-error">{preview.blocked}</p>}
          </>}
          {stalePreview && <p className="column-error">파일이 바뀌었습니다. 삭제 영향을 다시 확인해 주세요.</p>}
          {(stalePreview || previewError) && <button type="button" disabled={busy} onClick={() => {
            const definition = snapshot.schema.columns[form.column];
            change({ revision: snapshot.revision, confirmed: false, ...(definition ? { original: definition, label: definition.label ?? form.column } : {}) });
            requestPreview(form.column);
          }}>영향 다시 확인</button>}
          <label className="column-check"><input type="checkbox" checked={form.confirmed} disabled={busy || !preview || Boolean(preview.blocked) || Boolean(stalePreview)}
            onChange={event => change({ confirmed: event.target.checked })} />열의 데이터가 삭제됨을 확인했습니다</label>
        </> : <>
          {form.revision !== snapshot.revision && <p className="column-error" aria-live="polite">창을 연 뒤 파일이 변경되었습니다. 입력은 유지됩니다. 최신 설정을 확인하려면 취소하고 다시 열어 주세요.</p>}
          {form.kind !== 'rename' && <label>표시명<input aria-label="표시명" value={form.label} disabled={busy} autoFocus onChange={event => {
            const label = event.target.value;
            change({ label, ...(form.kind === 'add' && !form.codeEdited ? { code: suggestColumnCode(label, existing) } : {}) });
          }} /></label>}
          <label>코드명<input aria-label="코드명" value={form.code} readOnly={form.kind === 'update'} disabled={busy}
            autoFocus={form.kind === 'rename'} spellCheck={false} onChange={event => change({ code: event.target.value, codeEdited: true })} /></label>
          <p className="muted">{form.kind === 'update' ? '코드명은 헤더 메뉴의 “코드명 바꾸기”로 변경할 수 있습니다.'
            : form.kind === 'rename' ? '선언된 참조와 열 경로를 함께 변경합니다. 표시명은 유지됩니다.' : '표시명에서 코드명을 제안합니다. 직접 수정한 코드는 유지됩니다.'}</p>
          {codeError && <p className="column-error" aria-live="polite">{codeError}</p>}
          {form.kind !== 'rename' && <>
            <label>타입<select aria-label="타입" value={form.type} disabled={busy}
              onChange={event => change({ type: event.target.value as Column['type'] })}>
              {types.filter(([type]) => form.kind !== 'update' || form.column !== snapshot.schema.primary_key
                || ['string', 'text', 'integer'].includes(type))
                .map(([type, label]) => <option key={type} value={type}>{label} ({type})</option>)}
            </select></label>
            {form.type === 'enum' && <label>선택지 값<textarea aria-label="선택지 값" rows={4} value={form.values} disabled={busy}
              placeholder={'한 줄에 하나씩 입력\n예: 일반\n희귀'} onChange={event => change({ values: event.target.value })} /></label>}
            {form.type === 'ref' && <label>대상 표<select aria-label="대상 표" value={form.table} disabled={busy} onChange={event => change({ table: event.target.value })}>
              <option value="">표 선택</option>
              {[...new Set([...(snapshot.tables ?? [snapshot.table]), ...(form.table ? [form.table] : [])])].map(table => <option key={table} value={table}>{table}</option>)}
            </select></label>}
            <label className="column-check"><input type="checkbox" checked={form.required} disabled={busy || form.kind === 'update' && form.column === snapshot.schema.primary_key}
              onChange={event => change({ required: event.target.checked })} />필수 입력</label>
            <p className="muted">{form.kind === 'add' ? '기존 행의 값은 비워 둡니다. 필수 입력을 켜면 빈칸이 검증 오류로 표시됩니다.'
              : '타입을 바꿔도 기존 값은 그대로 보존됩니다. 새 규칙에 맞지 않는 값은 검증 오류로 표시됩니다.'}</p>
            {definitionError && <p className="column-error" aria-live="polite">{definitionError}</p>}
          </>}
        </>}
        {error && <p className="column-error">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={() => close()}>취소</button>
          <button type="submit" disabled={busy || invalid}>{busy ? '반영 중…' : form.kind === 'delete' ? '열 삭제 확정' : form.kind === 'rename' ? '코드명 변경' : form.kind === 'add' ? '열 추가' : '변경 적용'}</button></footer>
      </form>}
    </dialog>
  </>;
}
