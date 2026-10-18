import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent, PointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Cell, CellAddress, ColumnPosition, EditOperation } from '@vibe-spec/core';
import type { Host, Snapshot } from './protocol';
import { sameCell, selectionBounds, shortcut, tableColumns } from './gridModel';
import type { Selection } from './gridModel';
import { FindBar, ViewTools, useTableView } from './ViewTools';
import type { FindHandle } from './ViewTools';
import { ColumnResize, useWidths } from './ColumnResize';
import { UsagePanel } from './UsagePanel';
import { DraftRow } from './DraftRow';
import type { RowDraft } from './DraftRow';
import { ColumnEditor } from './ColumnEditor';
import type { ColumnChange, ColumnEditorHandle } from './ColumnEditor';

interface Edit extends CellAddress { original: unknown; present: boolean; draft: string; conflict: boolean }
interface Destination { cell: CellAddress; focus: boolean; edit?: boolean; row?: boolean; extend?: boolean }
type AfterWrite = (snapshot: Snapshot, rename?: { from: string; to: string }) => void;
const display = (value: unknown) => value === undefined ? '' : value === null ? 'null' : String(value);
const input = (value: unknown) => value == null ? '' : String(value);
const tsv = (value: unknown) => {
  const text = input(value);
  return /[\t\r\n"]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
};

export function App({ host }: { host: Host }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const snapshotRef = useRef<Snapshot | undefined>(undefined);
  const view = useTableView(snapshot);
  const viewRef = useRef(view); viewRef.current = view;
  const sizing = useWidths(host, snapshot);
  const [active, setActiveState] = useState<CellAddress>();
  const activeRef = useRef<CellAddress | undefined>(undefined);
  const [selection, setSelectionState] = useState<Selection>();
  const selectionRef = useRef<Selection | undefined>(undefined);
  const [edit, setEditState] = useState<Edit>();
  const editRef = useRef<Edit | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef<{ id: string; edit?: Edit; column?: ColumnChange; complete?: () => void } | undefined>(undefined);
  const afterWrite = useRef<AfterWrite | undefined>(undefined);
  const afterComposition = useRef<AfterWrite | undefined>(undefined);
  const composing = useRef(false);
  const receiver = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const desired = useRef<Destination | undefined>(undefined);
  const drag = useRef<{ anchor: CellAddress; moved: boolean } | undefined>(undefined);
  const find = useRef<FindHandle>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rowDraft, setRowDraft] = useState<RowDraft>();
  const rowDraftRef = useRef<RowDraft | undefined>(undefined); rowDraftRef.current = rowDraft;
  const draftPosition = rowDraft ? Math.max(0, view.rows.findIndex(row => row[snapshot?.schema.primary_key ?? ''] === rowDraft.anchor) + (rowDraft.after ? 1 : 0)) : -1;
  const [menu, setMenu] = useState<{ key: string; x: number; y: number }>();
  const columnEditor = useRef<ColumnEditorHandle>(null);
  const [columnDraft, setColumnDraft] = useState(false);
  const columnDraftRef = useRef(columnDraft); columnDraftRef.current = columnDraft;
  const columnDrag = useRef<string | undefined>(undefined);
  const [columnDrop, setColumnDrop] = useState<ColumnPosition>();
  const rowIndex = useMemo(() => new Map(view.rows.map((row, index) =>
    [String(row[snapshot?.schema.primary_key ?? '']), index])), [view.rows, snapshot?.schema.primary_key]);
  const codes = view.columns.map(([code]) => code);
  const bounds = selectionBounds(selection, rowIndex, codes);
  const virtualizer = useVirtualizer({ count: view.rows.length + (rowDraft ? 1 : 0), getScrollElement: () => scroller.current,
    estimateSize: () => 42, overscan: 8, scrollMargin: 52, scrollPaddingStart: 52 });
  const virtualRows = virtualizer.getVirtualItems();
  const [scrollLeft, setScrollLeft] = useState(0);
  const gridWidth = sizing.widths.reduce((sum, width) => sum + width, 0);
  const gridStyle = { gridTemplateColumns: sizing.widths.map(width => `${width}px`).join(' '), width: gridWidth };
  const setEdit = (next: Edit | undefined) => { editRef.current = next; setEditState(next); };
  const setActive = (next: CellAddress | undefined) => { activeRef.current = next; setActiveState(next); };
  const setSelection = (next: Selection | undefined) => { selectionRef.current = next; setSelectionState(next); };

  function startEdit(cell: CellAddress, draft?: string) {
    if (rowDraftRef.current) return;
    const current = snapshotRef.current;
    const row = current?.rows.find(row => row[current.schema.primary_key] === cell.key);
    if (!row || !current?.schema.columns[cell.column]) return;
    setEdit({ ...cell, original: row[cell.column], present: Object.hasOwn(row, cell.column),
      draft: draft ?? input(row[cell.column]), conflict: false });
  }
  function select(destination: Destination) {
    const current = snapshotRef.current;
    if (!current) return;
    if (!current.rows.some(row => row[current.schema.primary_key] === destination.cell.key)) {
      const first = current.rows[0];
      if (!first) { setActive(undefined); setSelection(undefined); setEdit(undefined); return; }
      destination = { ...destination, cell: { ...destination.cell, key: String(first[current.schema.primary_key]) } };
    }
    const ordered = tableColumns(current.schema, current.columnOrder).map(([code]) => code);
    if (!current.schema.columns[destination.cell.column]) destination = {
      ...destination, cell: { ...destination.cell, column: current.schema.primary_key },
    };
    setActive(destination.cell);
    setSelection(destination.row ? {
      anchor: { key: destination.cell.key, column: ordered[0]! },
      focus: { key: destination.cell.key, column: ordered.at(-1)! },
    } : { anchor: destination.extend ? selectionRef.current?.anchor ?? destination.cell : destination.cell, focus: destination.cell });
    setEdit(undefined);
    if (destination.edit) startEdit(destination.cell);
    desired.current = destination;
  }
  function navigate(destination: Destination) {
    if (rowDraftRef.current) { setError('새 행을 확정하거나 취소한 뒤 이동해 주세요.'); return; }
    withCommit((_, renamed) => select({ ...destination, cell: {
      ...destination.cell, key: renamed?.from === destination.cell.key ? renamed.to : destination.cell.key,
    } }));
  }
  function withCommit(action: AfterWrite) {
    const current = snapshotRef.current;
    if (!current) return;
    if (composing.current) { afterComposition.current = action; receiver.current?.blur(); return; }
    if (pendingRef.current) { afterWrite.current = action; return; }
    const editing = editRef.current;
    if (editing?.conflict) { setError('파일 변경 충돌의 값을 먼저 선택해 주세요.'); return; }
    if (editing && editing.draft !== input(editing.original)) {
      afterWrite.current = action; commit();
    } else { setEdit(undefined); setError(''); action(current); }
  }
  function send(operations: EditOperation[], edited = editRef.current) {
    const current = snapshotRef.current;
    if (!current || pendingRef.current) return;
    const id = crypto.randomUUID();
    pendingRef.current = { id, ...(edited ? { edit: { ...edited } } : {}) };
    setPending(true); setError('');
    host.send({ type: 'apply', requestId: id, revision: current.revision, operations });
  }
  function commit(value?: Cell, resolved = false) {
    const current = snapshotRef.current, editing = editRef.current;
    if (!current || !editing || pendingRef.current || composing.current || editing.conflict && !resolved) return;
    const definition = current.schema.columns[editing.column];
    if (!definition) return;
    const result: Cell = value !== undefined ? value
      : editing.present && editing.draft === input(editing.original)
        && (editing.original === null || typeof editing.original === 'string' || typeof editing.original === 'boolean')
        ? editing.original : definition.type === 'boolean' && ['true', 'false'].includes(editing.draft)
          ? editing.draft === 'true' : editing.draft;
    if (editing.column === current.schema.primary_key) {
      const id = crypto.randomUUID(); pendingRef.current = { id, edit: { ...editing } }; setPending(true); setError('');
      host.send({ type: 'rename', requestId: id, revision: current.revision, key: editing.key, to: String(result) });
    } else send([{ op: 'update', table: current.table, key: editing.key, values: { [editing.column]: result } }]);
  }
  function cancel() {
    if (pendingRef.current) return;
    const source = editRef.current ?? activeRef.current;
    setEdit(undefined); afterWrite.current = undefined; setError('');
    if (source) select({ cell: source, focus: true });
  }
  function move(rowDelta: number, columnDelta: number, extend = false, confirm = false) {
    const current = snapshotRef.current, point = activeRef.current;
    if (!current || !point) return;
    const visible = viewRef.current;
    let row = visible.rows.findIndex(item => item[current.schema.primary_key] === point.key);
    let column = visible.columns.findIndex(([code]) => code === point.column);
    row += rowDelta; column += columnDelta;
    if (column >= visible.columns.length) { column = 0; row++; }
    if (column < 0) { column = visible.columns.length - 1; row--; }
    row = Math.max(0, Math.min(visible.rows.length - 1, row));
    const target = visible.rows[row], field = visible.columns[column]?.[0];
    if (!target || !field) return;
    const destination = { cell: { key: String(target[current.schema.primary_key]), column: field }, focus: true, extend };
    if (confirm) {
      afterWrite.current = (_, renamed) => select({ ...destination, cell: { ...destination.cell,
        key: renamed?.from === destination.cell.key ? renamed.to : destination.cell.key } });
      commit();
    } else navigate(destination);
  }

  useEffect(() => host.subscribe(message => {
    if (message.type === 'copied') { setNotice('선택한 칸을 복사했습니다.'); return; }
    if (message.type === 'notice') { setNotice(message.message); return; }
    if (message.type === 'focus') {
      navigate({ cell: message, focus: true, ...(message.row ? { row: true } : {}) }); return;
    }
    if (message.type === 'error') {
      setError(message.code + ': ' + message.message);
      if (message.requestId && message.requestId === pendingRef.current?.id) {
        const source = pendingRef.current.edit;
        pendingRef.current = undefined; afterWrite.current = undefined; setPending(false);
        if (source) { setEdit(source); setActive(source); desired.current = { cell: source, focus: true, edit: true }; }
      }
      return;
    }
    if (message.type !== 'snapshot') return;
    const previous = snapshotRef.current;
    snapshotRef.current = message; setSnapshot(message);
    if (message.table !== previous?.table) {
      setEdit(undefined); setRowDraft(undefined); setMenu(undefined); setSelection(undefined); setColumnDraft(false);
      columnDrag.current = undefined; setColumnDrop(undefined);
      const first = message.rows[0];
      if (first) select({ cell: { key: String(first[message.schema.primary_key]), column: message.schema.primary_key }, focus: false });
      else { setActive(undefined); desired.current = undefined; }
      return;
    }
    const sentColumn = message.requestId === pendingRef.current?.id ? pendingRef.current?.column : undefined;
    const renamedColumn = sentColumn?.kind === 'rename' ? sentColumn : undefined;
    const visible = viewRef.current;
    if (visible.sort && !message.schema.columns[visible.sort.column]) visible.setSort(renamedColumn?.column === visible.sort.column
      ? { ...visible.sort, column: renamedColumn.to } : undefined);
    if (visible.filterColumn && !message.schema.columns[visible.filterColumn]) visible.setFilterColumn(
      renamedColumn?.column === visible.filterColumn ? renamedColumn.to : '');
    const currentCell = activeRef.current;
    const oldColumns = previous ? tableColumns(previous.schema, previous.columnOrder).map(([code]) => code) : [];
    const nextColumns = tableColumns(message.schema, message.columnOrder).map(([code]) => code);
    const nextColumn = currentCell && !message.schema.columns[currentCell.column]
      ? renamedColumn?.column === currentCell.column ? renamedColumn.to
        : nextColumns[Math.min(Math.max(0, oldColumns.indexOf(currentCell.column)), nextColumns.length - 1)]!
      : currentCell?.column;
    if (message.requestId && message.requestId === pendingRef.current?.id) {
      const sent = pendingRef.current;
      const renamed = sent?.edit?.column === message.schema.primary_key ? { from: sent.edit.key, to: sent.edit.draft } : undefined;
      pendingRef.current = undefined; setPending(false); setEdit(undefined); setError('');
      if (sent.column) setNotice(sent.column.kind === 'rename' ? `${sent.column.column} → ${sent.column.to} 코드명을 변경했습니다.`
        : sent.column.operation.op === 'column-delete' ? '열과 데이터를 삭제했습니다. 되돌리기로 복원할 수 있습니다.'
          : '열 변경을 반영했습니다.');
      sent.complete?.();
      const action = afterWrite.current; afterWrite.current = undefined;
      if (action) action(message, renamed);
      else if (activeRef.current) select({ cell: { ...activeRef.current,
        column: nextColumn ?? message.schema.primary_key,
        key: renamed?.from === activeRef.current.key ? renamed.to : activeRef.current.key }, focus: true });
    } else if (editRef.current) {
      const editing = editRef.current;
      const row = message.rows.find(item => item[message.schema.primary_key] === editing.key);
      if (!row || !message.schema.columns[editing.column] || Object.hasOwn(row, editing.column) !== editing.present || row[editing.column] !== editing.original) {
        setEdit({ ...editing, conflict: true });
      }
    } else if (currentCell && nextColumn !== currentCell.column) {
      select({ cell: { ...currentCell, column: nextColumn! }, focus: false });
    }
  }), [host]);
  useEffect(() => { host.send({ type: 'ready' }); }, [host]);
  useEffect(() => { host.send({ type: 'draftState', active: pending || columnDraft || Boolean(rowDraft) || Boolean(edit && edit.draft !== input(edit.original)) }); }, [host, pending, columnDraft, rowDraft, edit]);
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => keyCapture(event);
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [host]);

  useEffect(() => {
    const target = desired.current;
    if (!target || !snapshot || pending) return;
    const index = rowIndex.get(target.cell.key);
    if (index === undefined) {
      if (snapshot.rows.some(row => row[snapshot.schema.primary_key] === target.cell.key) && view.filter) {
        view.setFilter(''); setNotice('대상 칸을 보이도록 필터를 해제했습니다.');
      }
      return;
    }
    virtualizer.scrollToIndex(index + (draftPosition >= 0 && draftPosition <= index ? 1 : 0), { align: 'auto' });
    const column = codes.indexOf(target.cell.column), container = scroller.current;
    if (container && column > 0) {
      const left = sizing.widths.slice(0, column).reduce((a, b) => a + b, 0);
      const right = left + sizing.widths[column]!;
      if (left < container.scrollLeft + sizing.widths[0]!) container.scrollLeft = Math.max(0, left - sizing.widths[0]!);
      else if (right > container.scrollLeft + container.clientWidth) container.scrollLeft = right - container.clientWidth;
    }
    if (target.focus) receiver.current?.focus({ preventScroll: true });
    desired.current = undefined;
  }, [active, snapshot, view.rows, sizing.widths, pending]);
  useEffect(() => { if (rowDraft) virtualizer.scrollToIndex(draftPosition, { align: 'auto' }); }, [rowDraft?.anchor, rowDraft?.after]);

  function history(type: 'undo' | 'redo') {
    if (rowDraftRef.current) return;
    withCommit(current => {
      if (!(type === 'undo' ? current.history?.canUndo : current.history?.canRedo)) return;
      const id = crypto.randomUUID(); pendingRef.current = { id }; setPending(true); setError('');
      host.send({ type, requestId: id, revision: current.revision });
    });
  }
  function copy() {
    const current = snapshotRef.current, visible = viewRef.current;
    if (!current) return;
    const indices = new Map(visible.rows.map((row, index) => [String(row[current.schema.primary_key]), index]));
    const area = selectionBounds(selectionRef.current, indices, visible.columns.map(([code]) => code));
    if (!area) return;
    host.send({ type: 'copy', text: visible.rows.slice(area.top, area.bottom + 1).map(row =>
      visible.columns.slice(area.left, area.right + 1).map(([column]) => tsv(row[column])).join('\t')).join('\n') });
  }
  function keyCapture(event: KeyboardEvent | globalThis.KeyboardEvent) {
    const native = 'nativeEvent' in event ? event.nativeEvent : event;
    if (!shortcut(event) || native.isComposing || columnDraftRef.current) return;
    const key = event.key.toLowerCase();
    if (key === 'f') { event.preventDefault(); event.stopPropagation(); withCommit(() => find.current?.open()); }
    const inViewControls = (event.target as HTMLElement).closest('[data-view-controls]');
    const redo = key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey;
    if ((key === 'z' || redo) && !inViewControls && !(editRef.current && editRef.current.draft !== input(editRef.current.original))) {
      event.preventDefault(); event.stopPropagation(); history(redo || event.shiftKey ? 'redo' : 'undo');
    }
    if (key === 'c' && !editRef.current && (event.target === receiver.current || (event.target as HTMLElement).closest('[role="gridcell"]'))) {
      event.preventDefault(); event.stopPropagation(); copy();
    }
  }
  function receiverKey(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
    if (shortcut(event) || event.altKey) return;
    if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
    if (editRef.current) {
      if (event.key === 'Enter' && !(event.shiftKey && snapshotRef.current?.schema.columns[editRef.current.column]?.type === 'text')) {
        event.preventDefault(); move(event.shiftKey ? -1 : 1, 0, false, true);
      }
      if (event.key === 'Tab') { event.preventDefault(); move(0, event.shiftKey ? -1 : 1, false, true); }
      return;
    }
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault(); if (activeRef.current) startEdit(activeRef.current); return;
    }
    const arrows: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] };
    const delta = arrows[event.key];
    if (delta) { event.preventDefault(); move(delta[0], delta[1], event.shiftKey); }
    if (event.key === 'Tab') { event.preventDefault(); move(0, event.shiftKey ? -1 : 1); }
  }
  function draft(value: string) {
    if (editRef.current) setEdit({ ...editRef.current, draft: value });
    else if (activeRef.current) startEdit(activeRef.current, value);
  }
  function paste(event: ClipboardEvent) {
    if ((event.target as HTMLElement).closest('.draft-row')) return;
    if (editRef.current) return; // Native editor paste, including multiline text, stays in its draft.
    const current = snapshotRef.current, start = activeRef.current, visible = viewRef.current;
    if (!current || !start || pendingRef.current) return;
    const lines = event.clipboardData.getData('text/plain').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map(line => line.split('\t'));
    event.preventDefault();
    const row = visible.rows.findIndex(item => item[current.schema.primary_key] === start.key);
    const column = visible.columns.findIndex(([code]) => code === start.column);
    if (row + lines.length > visible.rows.length || lines.some(line => column + line.length > visible.columns.length)) { setError('붙여넣기 범위가 표를 벗어납니다.'); return; }
    const operations: EditOperation[] = [];
    for (const [i, values] of lines.entries()) {
      const update: Record<string, Cell> = {};
      for (const [j, value] of values.entries()) {
        const [code, definition] = visible.columns[column + j]!;
        if (code === current.schema.primary_key) { setError('Key는 개별 편집으로 이름을 바꿔 주세요.'); return; }
        update[code] = definition.type === 'boolean' && ['true', 'false'].includes(value) ? value === 'true' : value;
      }
      operations.push({ op: 'update', table: current.table, key: String(visible.rows[row + i]![current.schema.primary_key]), values: update });
    }
    send(operations);
  }
  function clickCell(cell: CellAddress, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) {
    if (drag.current?.moved) { drag.current = undefined; return; }
    drag.current = undefined;
    if (shortcut(event) && snapshotRef.current?.schema.columns[cell.column]?.type === 'ref') {
      return; // Handled on pointerdown, including macOS Control-click's context-menu gesture.
    }
    navigate({ cell, focus: true, extend: event.shiftKey, edit: Boolean(editRef.current) && !event.shiftKey });
  }
  function pointerDown(cell: CellAddress, event: PointerEvent) {
    if (rowDraftRef.current) return;
    if (event.button === 2) { event.preventDefault(); return; }
    if (event.button === 0 && shortcut(event) && snapshotRef.current?.schema.columns[cell.column]?.type === 'ref') {
      event.preventDefault(); event.stopPropagation();
      withCommit((_, renamed) => host.send({ type: 'follow', key: renamed?.from === cell.key ? renamed.to : cell.key, column: cell.column }));
      return;
    }
    if (event.button !== 0 || shortcut(event) || editRef.current) return;
    event.preventDefault();
    drag.current = { anchor: event.shiftKey ? selectionRef.current?.anchor ?? cell : cell, moved: false };
    select({ cell, focus: true, extend: event.shiftKey });
  }
  function insertRow(anchor: string | undefined, after: boolean) {
    withCommit(() => {
      if (rowDraftRef.current) { setError('입력 중인 새 행을 확정하거나 취소해 주세요.'); return; }
      setRowDraft({ ...(anchor ? { anchor } : {}), after, values: {} }); setMenu(undefined);
      setNotice('삽입 위치는 입력 위치입니다. 확정하면 파일 끝에 추가합니다.');
    });
  }
  function createRow() {
    const current = snapshotRef.current, draft = rowDraftRef.current;
    if (!current || !draft || pendingRef.current) return;
    const key = draft.values[current.schema.primary_key];
    if (!key) { setError('Key를 입력해야 파일에 반영됩니다. 새 행은 draft로 유지됩니다.'); return; }
    const row = Object.fromEntries(Object.entries(draft.values).map(([code, value]) => [code,
      current.schema.columns[code]?.type === 'boolean' && ['true', 'false'].includes(value) ? value === 'true' : value]));
    afterWrite.current = () => {
      setRowDraft(undefined); setNotice(key + ' 행을 추가했습니다. 파일 끝에 추가했고 현재 보기 순서의 해당 행으로 이동했습니다.');
      select({ cell: { key, column: current.schema.primary_key }, focus: true, row: true });
    };
    send([{ op: 'create', table: current.table, row }], undefined);
  }
  function selectedKeys(fallback: string) {
    const current = snapshotRef.current, visible = viewRef.current;
    if (!current) return [fallback];
    const indices = new Map(visible.rows.map((row, index) => [String(row[current.schema.primary_key]), index]));
    const area = selectionBounds(selectionRef.current, indices, visible.columns.map(([code]) => code));
    const at = indices.get(fallback);
    return area && at !== undefined && at >= area.top && at <= area.bottom
      ? visible.rows.slice(area.top, area.bottom + 1).map(row => String(row[current.schema.primary_key])) : [fallback];
  }
  function deleteRows(key: string) {
    const keys = selectedKeys(key); setMenu(undefined);
    withCommit(current => {
      afterWrite.current = () => {
        setNotice(keys.length + '개 행을 삭제했습니다. 되돌리기로 복원할 수 있습니다.');
        select({ cell: { key, column: current.schema.primary_key }, focus: true });
      };
      send(keys.map(key => ({ op: 'delete', table: current.table, key })), undefined);
    });
  }
  function toolbarFocus() {
    if (editRef.current && !pendingRef.current) withCommit(() => {});
  }
  function openColumnMenu(column: string, x: number, y: number) {
    if (rowDraftRef.current) { setError('새 행을 확정하거나 취소한 뒤 열을 변경해 주세요.'); return; }
    setMenu(undefined);
    withCommit(() => columnEditor.current?.open(column, x, y));
  }
  function writeColumn(change: ColumnChange, complete?: () => void) {
    if (rowDraftRef.current) { setError('새 행을 확정하거나 취소한 뒤 열을 변경해 주세요.'); return; }
    withCommit(current => {
      const id = crypto.randomUUID();
      pendingRef.current = { id, column: change, ...(complete ? { complete } : {}) };
      setPending(true); setError('');
      if (change.kind === 'rename') host.send({ type: 'columnRename', requestId: id, revision: change.revision, column: change.column, to: change.to });
      else host.send({ type: 'structureEdit', requestId: id, revision: change.revision ?? current.revision, operation: change.operation });
    });
  }
  function dropPosition(column: string, event: DragEvent<HTMLDivElement>): ColumnPosition | undefined {
    if (!columnDrag.current || columnDrag.current === column || pendingRef.current || rowDraftRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const side = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    if (column === snapshotRef.current?.schema.primary_key && side === 'before') return;
    return { anchor: column, side };
  }

  if (!snapshot) return <main className="empty-state"><h1>vibe-spec</h1><p>{error || '표를 불러오는 중입니다.'}</p></main>;
  const columnIndex = active ? codes.indexOf(active.column) : -1;
  const activeIndex = active ? rowIndex.get(active.key) : undefined;
  const definition = active ? snapshot.schema.columns[active.column] : undefined;
  const options = definition?.type === 'ref' ? snapshot.references[active!.column] ?? [] : definition?.type === 'enum' ? definition.values : definition?.type === 'boolean' ? ['true', 'false'] : undefined;
  const receiverStyle = activeIndex === undefined || columnIndex < 0 ? { display: 'none' } : {
    top: (activeIndex + (draftPosition >= 0 && draftPosition <= activeIndex ? 1 : 0)) * 42 + 4, left: columnIndex === 0 ? scrollLeft + 4 : sizing.widths.slice(0, columnIndex).reduce((a, b) => a + b, 0) + 4,
    width: (sizing.widths[columnIndex] ?? 64) - 8,
  };
  const receiverProps = {
    'aria-label': edit ? '값 편집' : '선택한 칸 입력',
    className: 'cell-receiver' + (edit ? ' editing' : ' selecting'),
    style: receiverStyle, value: edit?.draft ?? '', disabled: pending, spellCheck: false,
    onInput: (event: { currentTarget: { value: string } }) => draft(event.currentTarget.value),
    onChange: () => {}, onKeyDown: receiverKey, onPaste: paste,
    onCompositionStart: () => { composing.current = true; if (!editRef.current && activeRef.current) startEdit(activeRef.current, ''); },
    onCompositionEnd: (event: { currentTarget: { value: string } }) => {
      composing.current = false; draft(event.currentTarget.value);
      const action = afterComposition.current; afterComposition.current = undefined;
      if (action) withCommit(action);
    },
  };
  const diagnostics = new Map<string, string[]>();
  for (const item of snapshot.diagnostics) diagnostics.set(item.path, [...(diagnostics.get(item.path) ?? []), item.message]);
  const conflictRow = edit?.conflict ? snapshot.rows.find(row => row[snapshot.schema.primary_key] === edit.key) : undefined;
  return <main className="app" onPointerDown={event => { if (!(event.target as HTMLElement).closest('.row-menu')) setMenu(undefined); }}>
    <header className="toolbar"><div><h1>{snapshot.table}</h1><span className="muted">{view.rows.length.toLocaleString()} / {snapshot.rows.length.toLocaleString()}행</span></div>
      <div className="toolbar-actions"><button disabled={pending || Boolean(rowDraft)} onClick={() => insertRow(active?.key, true)}>행 추가</button><button disabled={pending || !snapshot.history?.canUndo} onClick={() => history('undo')}>되돌리기</button>
        <button disabled={pending || !snapshot.history?.canRedo} onClick={() => history('redo')}>다시 하기</button>
        <button onClick={() => withCommit(() => find.current?.open())}>찾기</button>
        <button disabled={!active} onClick={() => withCommit((_, renamed) => { if (activeRef.current) host.send({ type: 'whereUsed', key: renamed?.from === activeRef.current.key ? renamed.to : activeRef.current.key }); })}>행 사용처 보기</button></div>
    </header>
    <p className="baseline-banner"><strong>편집 대상: 기준안</strong> · 이 표의 변경은 모든 대안이 참고하는 기준안에 반영됩니다.</p>
    <ViewTools view={view} onFocus={toolbarFocus} />
    <FindBar snapshot={snapshot} control={find} onNavigate={cell => navigate({ cell, focus: false })} />
    <p className="hint">클릭 선택 · 바로 타이핑하면 덮어쓰기 · Enter/F2/더블클릭 편집 · Shift+클릭/드래그로 범위 선택 · Cmd/Ctrl+C 복사 · Cmd/Ctrl+F 찾기</p>
    {snapshot.schemaTables && snapshot.schemaTables.length > 1 && <p className="hint">공유 스키마: {snapshot.schemaTables.join(', ')} · 열 변경은 이 표들에 함께 반영됩니다.</p>}
    {error && <div role="alert" className="error-banner">{error}</div>}
    <span role="status" className="muted">{pending ? '파일에 반영 중…' : notice || '편집은 파일에 반영됩니다. Esc로 입력 취소.'}</span>
    <div className="grid-scroll" data-testid="grid-scroll" ref={scroller} role="grid" aria-label={`${snapshot.table} 테이블`}
      aria-rowcount={view.rows.length + 1 + (rowDraft ? 1 : 0)} aria-colcount={codes.length} aria-busy={pending}
      onScroll={event => setScrollLeft(event.currentTarget.scrollLeft)} onPaste={paste}>
      <div role="row" className="grid-header" style={gridStyle}>
        {view.columns.map(([code, column], index) => <div role="columnheader" key={code} className={index === 0 ? 'key-cell' : ''}
          data-column={code} data-drop-side={columnDrop?.anchor === code ? columnDrop.side : undefined} tabIndex={0}
          draggable={index > 0 && !pending && !rowDraft}
          onContextMenu={event => { event.preventDefault(); openColumnMenu(code, event.clientX, event.clientY); }}
          onKeyDown={event => {
            if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
              event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openColumnMenu(code, rect.left, rect.bottom);
            }
          }}
          onDragStart={event => {
            if (index === 0 || pending || rowDraft || (event.target as HTMLElement).closest('.column-resize')) { event.preventDefault(); return; }
            drag.current = undefined; columnDrag.current = code; setMenu(undefined);
            event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', code);
          }}
          onDragOver={event => {
            const position = dropPosition(code, event); setColumnDrop(position);
            if (position) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
          }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setColumnDrop(undefined); }}
          onDrop={event => {
            const position = dropPosition(code, event), column = columnDrag.current;
            event.preventDefault(); columnDrag.current = undefined; setColumnDrop(undefined);
            if (position && column) writeColumn({ kind: 'structure', operation: { op: 'column-move', table: snapshot.table, column, position } });
          }}
          onDragEnd={() => { columnDrag.current = undefined; setColumnDrop(undefined); }}>
          <strong>{column.label ?? code}</strong><span>{code} · {code === snapshot.schema.primary_key ? 'Key' : column.type}</span>
          <ColumnResize column={code} width={sizing.widths[index]!} resize={sizing.resize} />
        </div>)}
      </div>
      <div className="virtual-body" style={{ height: virtualizer.getTotalSize(), width: gridWidth }}>
        {virtualRows.map(virtualRow => {
          if (rowDraft && virtualRow.index === draftPosition) return <DraftRow key="draft" columns={view.columns}
            primaryKey={snapshot.schema.primary_key} draft={rowDraft} pending={pending}
            style={{ ...gridStyle, transform: `translateY(${virtualRow.start - 52}px)`, height: virtualRow.size }}
            change={values => setRowDraft({ ...rowDraft, values })} submit={createRow} cancel={() => { setRowDraft(undefined); setError(''); }} />;
          const rowPosition = virtualRow.index - (rowDraft && virtualRow.index > draftPosition ? 1 : 0);
          const row = view.rows[rowPosition]!, key = String(row[snapshot.schema.primary_key]);
          return <div role="row" className="grid-row" key={'row:' + key} aria-rowindex={virtualRow.index + 2}
            style={{ ...gridStyle, transform: `translateY(${virtualRow.start - 52}px)`, height: virtualRow.size }}
            onContextMenu={event => { event.preventDefault(); if (shortcut(event)) return;
              withCommit(() => { if (selectedKeys(key).length === 1) select({ cell: { key, column: snapshot.schema.primary_key }, focus: true, row: true }); setMenu({ key, x: event.clientX, y: event.clientY }); }); }}>
            {view.columns.map(([column], index) => {
              const cell = { key, column }, issues = diagnostics.get(`${snapshot.table}/${key}/${column}`) ?? [];
              const selected = bounds && rowPosition >= bounds.top && rowPosition <= bounds.bottom && index >= bounds.left && index <= bounds.right;
              return <div role="gridcell" aria-label={`${key}/${column}`} aria-selected={Boolean(selected)} aria-invalid={issues.length > 0}
                data-active={sameCell(active, cell)} tabIndex={-1} key={column}
                className={`grid-cell${index === 0 ? ' key-cell' : ''}${selected ? ' selected' : ''}${sameCell(active, cell) ? ' active' : ''}${issues.length ? ' invalid' : ''}`}
                title={[display(row[column]), ...issues].join('\n')}
                onFocus={() => { if (!editRef.current && !pendingRef.current) select({ cell, focus: true }); }}
                onPointerDown={event => pointerDown(cell, event)} onPointerEnter={event => {
                  if (drag.current && event.buttons === 1) {
                    drag.current.moved = true; setActive(cell); setSelection({ anchor: drag.current.anchor, focus: cell });
                    desired.current = { cell, focus: true };
                  }
                }} onClick={event => clickCell(cell, event)} onDoubleClick={() => navigate({ cell, focus: true, edit: true })}>
                <span className={row[column] === null ? 'null-value' : ''}>{display(row[column]).replace(/\r\n|\r|\n/g, ' ↵ ')}</span>
              </div>;
            })}
          </div>;
        })}
        {definition?.type === 'text' ? <textarea {...receiverProps} rows={1} ref={element => {
          receiver.current = element;
          if (element) { element.style.height = '32px'; if (edit) element.style.height = `${Math.max(32, Math.min(240, element.scrollHeight + 2))}px`; }
        }} /> : <input {...receiverProps} type="text" list={edit && options ? 'cell-options' : undefined} ref={element => { receiver.current = element; }} />}
        {edit && options && <datalist id="cell-options">{options.map(option => <option key={option} value={option} />)}</datalist>}
      </div>
    </div>
    {rowDraft && <div className="edit-actions" data-view-controls><span>새 행 입력 중 · 확정 후 파일 끝에 추가</span>
      <button disabled={pending} onClick={createRow}>행 추가 확정</button><button disabled={pending} onClick={() => { setRowDraft(undefined); setError(''); }}>새 행 취소</button></div>}
    {menu && <div className="row-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      <button role="menuitem" disabled={pending || Boolean(rowDraft)} onClick={() => insertRow(menu.key, false)}>위에 행 삽입</button>
      <button role="menuitem" disabled={pending || Boolean(rowDraft)} onClick={() => insertRow(menu.key, true)}>아래에 행 삽입</button>
      <button role="menuitem" disabled={pending || Boolean(rowDraft)} onClick={() => deleteRows(menu.key)}>행 삭제</button>
      <span>{selectedKeys(menu.key).length}개 행 선택</span><button role="menuitem" onClick={() => { host.send({ type: 'whereUsed', key: menu.key }); setMenu(undefined); }}>사용처 보기</button></div>}
    {edit && !edit.conflict && <div className="edit-actions"><code>{edit.key}/{edit.column}</code>
      <button disabled={pending} onClick={() => commit()}>입력 반영</button>
      {definition?.nullable && <button disabled={pending} onClick={() => commit(null)}>null로 설정</button>}
      <button disabled={pending} onClick={cancel}>취소</button></div>}
    {edit?.conflict && <section role="dialog" aria-label="파일 변경 충돌" className="conflict"><h2>편집 중인 칸의 파일 값이 바뀌었습니다</h2>
      <dl><dt>편집 시작 값</dt><dd>{display(edit.original)}</dd><dt>현재 파일 값</dt><dd>{conflictRow ? display(conflictRow[edit.column]) : '(행이 삭제되거나 이름이 바뀜)'}</dd><dt>내 입력</dt><dd>{edit.draft}</dd></dl>
      <button disabled={pending || !conflictRow || !definition} onClick={() => commit(undefined, true)}>내 입력 적용</button><button disabled={pending} onClick={cancel}>파일 값 사용</button></section>}
    <section className="diagnostics" aria-label="검증 오류"><h2>검증 오류 {snapshot.diagnostics.length}</h2>
      {!snapshot.diagnostics.length ? <p className="muted">검증 오류가 없습니다.</p> : <ul>{snapshot.diagnostics.map((item, index) => <li key={index}><button onClick={() => {
        const [table, key, column] = item.path.split('/'); if (table === snapshot.table && key && column) navigate({ cell: { key, column }, focus: true });
      }}><code>{item.path || item.file}</code> {item.message}</button></li>)}</ul>}
    </section>
    <UsagePanel host={host} />
    <ColumnEditor key={snapshot.table} host={host} snapshot={snapshot} control={columnEditor} busy={pending} error={error}
      onWrite={writeColumn} onDraftChange={setColumnDraft} onClose={() => {
        setError(''); if (activeRef.current) select({ cell: activeRef.current, focus: true });
      }} />
  </main>;
}
