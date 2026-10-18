import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Decimal } from 'decimal.js';
import type { CellAddress } from '@vibe-spec/core';
import type { Snapshot } from './protocol';
import { tableColumns } from './gridModel';

const text = (value: unknown) => value === undefined ? '' : String(value);
export function useTableView(snapshot: Snapshot | undefined) {
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' }>();
  const [filter, setFilter] = useState('');
  const [filterColumn, setFilterColumn] = useState('');
  useEffect(() => { setSort(undefined); setFilter(''); setFilterColumn(''); }, [snapshot?.table]);
  const columns = useMemo(() => snapshot ? tableColumns(snapshot.schema, snapshot.columnOrder) : [], [snapshot?.schema, snapshot?.columnOrder]);
  const rows = useMemo(() => {
    const query = filter.toLocaleLowerCase();
    const source = (snapshot?.rows ?? []).filter(row => !query ||
      (filterColumn ? [filterColumn] : columns.map(([code]) => code)).some(code => text(row[code]).toLocaleLowerCase().includes(query)));
    // Keep file order until an explicit sort; integer Keys use the same exact
    // string comparison as other numeric columns, without Number conversion.
    if (!sort) return source;
    const numeric = ['integer', 'decimal'].includes(snapshot?.schema.columns[sort.column]?.type ?? '');
    const compare = (a: unknown, b: unknown) => {
      if (a == null || b == null) return a == null ? b == null ? 0 : 1 : -1;
      if (numeric && typeof a === 'string' && typeof b === 'string') {
        try { return new Decimal(a).cmp(new Decimal(b)); } catch { /* Invalid data stays visible and sortable. */ }
      }
      return text(a).localeCompare(text(b));
    };
    return source.sort((a, b) => compare(a[sort.column], b[sort.column]) * (sort.direction === 'asc' ? 1 : -1));
  }, [snapshot?.rows, snapshot?.schema, columns, filter, filterColumn, sort]);
  return { columns, rows, sort, setSort, filter, setFilter, filterColumn, setFilterColumn };
}

export function ViewTools({ view, onFocus }: { view: ReturnType<typeof useTableView>; onFocus: () => void }) {
  return <div className="view-tools" data-view-controls onFocus={onFocus}>
    <label>정렬 <select aria-label="정렬 열" value={view.sort?.column ?? ''} onChange={event =>
      view.setSort(event.target.value ? { column: event.target.value, direction: view.sort?.direction ?? 'asc' } : undefined)}>
      <option value="">파일 순서</option>
      {view.columns.map(([code, column]) => <option key={code} value={code}>{column.label ?? code}</option>)}
    </select></label>
    {view.sort && <select aria-label="정렬 방향" value={view.sort.direction} onChange={event =>
      view.setSort({ ...view.sort!, direction: event.target.value as 'asc' | 'desc' })}>
      <option value="asc">오름차순</option><option value="desc">내림차순</option>
    </select>}
    <label>필터 <select aria-label="필터 열" value={view.filterColumn} onChange={event => view.setFilterColumn(event.target.value)}>
      <option value="">모든 열</option>
      {view.columns.map(([code, column]) => <option key={code} value={code}>{column.label ?? code}</option>)}
    </select></label>
    <input aria-label="텍스트 필터" value={view.filter} onChange={event => view.setFilter(event.target.value)} placeholder="포함할 텍스트" />
    {(view.sort || view.filter) && <><span role="status">보기 전용 정렬·필터 적용 중</span>
      <button onClick={() => { view.setSort(undefined); view.setFilter(''); }}>보기 초기화</button></>}
  </div>;
}

export interface FindHandle { open(): void }
export function FindBar({ snapshot, control, onNavigate }: {
  snapshot: Snapshot | undefined; control: Ref<FindHandle>; onNavigate: (cell: CellAddress) => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    if (!snapshot || !query) return [];
    const needle = query.toLocaleLowerCase();
    return snapshot.rows.flatMap(row => Object.keys(snapshot.schema.columns)
      .filter(column => text(row[column]).toLocaleLowerCase().includes(needle))
      .map(column => ({ key: String(row[snapshot.schema.primary_key]), column })));
  }, [snapshot?.rows, snapshot?.schema, query]);
  useImperativeHandle(control, () => ({ open() { setOpen(true); requestAnimationFrame(() => input.current?.focus()); } }));
  useEffect(() => { setQuery(''); setIndex(0); }, [snapshot?.table]);
  useEffect(() => {
    setIndex(0);
    if (open && matches[0]) onNavigate(matches[0]);
  }, [query, open, snapshot?.table]);
  const move = (direction: number) => {
    if (!matches.length) return;
    const next = (index + direction + matches.length) % matches.length;
    setIndex(next); onNavigate(matches[next]!);
  };
  if (!open) return null;
  return <section className="find-bar" aria-label="표에서 찾기" data-view-controls>
    <input ref={input} aria-label="찾을 내용" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); } }} />
    <span aria-live="polite">{matches.length ? Math.min(index + 1, matches.length) : 0} / {matches.length}</span>
    <button disabled={!matches.length} onClick={() => move(-1)}>이전 일치</button>
    <button disabled={!matches.length} onClick={() => { if (matches[index]) onNavigate(matches[index]!); }}>일치 칸으로</button>
    <button disabled={!matches.length} onClick={() => move(1)}>다음 일치</button>
    <button onClick={() => setOpen(false)}>찾기 닫기</button>
  </section>;
}
