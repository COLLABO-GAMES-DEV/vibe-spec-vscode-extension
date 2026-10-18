import type { CSSProperties } from 'react';
import type { Column } from '@vibe-spec/core';

export interface RowDraft { anchor?: string; after: boolean; values: Record<string, string> }
export function DraftRow({ columns, primaryKey, draft, style, pending, change, submit, cancel }: {
  columns: (readonly [string, Column])[]; primaryKey: string; draft: RowDraft; style: CSSProperties; pending: boolean;
  change(values: Record<string, string>): void; submit(): void; cancel(): void;
}) {
  return <div role="row" aria-label="새 행 입력" className="grid-row draft-row" style={style} data-view-controls
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    }}>
    {columns.map(([code]) => <div role="gridcell" className={'grid-cell' + (code === primaryKey ? ' key-cell' : '')} key={code}>
      <input aria-label={code === primaryKey ? '새 행 Key' : '새 행 ' + code} type="text" autoFocus={code === primaryKey}
        disabled={pending} placeholder={code === primaryKey ? 'Key를 입력하세요' : code}
        value={draft.values[code] ?? ''} onChange={event => change({ ...draft.values, [code]: event.target.value })} />
    </div>)}
  </div>;
}
