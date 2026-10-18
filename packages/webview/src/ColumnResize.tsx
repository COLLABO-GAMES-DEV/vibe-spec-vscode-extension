import { useEffect, useRef, useState } from 'react';
import type { Host, Snapshot } from './protocol';
import { useColumnWidths } from './columnWidths';
import { tableColumns } from './gridModel';

export function useWidths(host: Host, snapshot: Snapshot | undefined) {
  const auto = useColumnWidths(snapshot);
  const [saved, setSaved] = useState<Record<string, Record<string, number>>>({});
  const manual = saved[snapshot?.table ?? ''] ?? {};
  const manualRef = useRef(manual);
  manualRef.current = manual;
  const tableRef = useRef(snapshot?.table); tableRef.current = snapshot?.table;
  useEffect(() => host.subscribe(message => {
    if (message.type === 'viewState') {
      if (message.table === tableRef.current) manualRef.current = message.widths;
      setSaved(previous => ({ ...previous, [message.table]: message.widths }));
    }
  }), [host]);
  const sourceCodes = Object.keys(snapshot?.schema.columns ?? {});
  const widths = snapshot ? tableColumns(snapshot.schema, snapshot.columnOrder).map(([code]) => manual[code] ?? auto[sourceCodes.indexOf(code)] ?? 64) : [];
  const resize = (column: string, width: number | undefined, persist: boolean) => {
    const next = { ...manualRef.current };
    if (width === undefined) delete next[column];
    else next[column] = Math.max(48, Math.min(3000, Math.round(width)));
    manualRef.current = next; setSaved(previous => ({ ...previous, [tableRef.current!]: next }));
    if (persist) host.send({ type: 'widths', widths: next });
  };
  return { widths, resize };
}

export function ColumnResize({ column, width, resize }: {
  column: string; width: number; resize: (column: string, width: number | undefined, persist: boolean) => void;
}) {
  const drag = useRef<{ start: number; width: number } | undefined>(undefined);
  return <div className="column-resize" role="separator" aria-label={column + ' 열 너비'} aria-orientation="vertical"
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); resize(column, undefined, true); }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { start: event.clientX, width };
    }} onPointerMove={event => {
      if (drag.current) resize(column, drag.current.width + event.clientX - drag.current.start, false);
    }} onPointerUp={event => {
      if (drag.current) resize(column, drag.current.width + event.clientX - drag.current.start, true);
      drag.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={() => { drag.current = undefined; }} />;
}
