import { pathContains } from '@vibe-spec/core/paths';
import { diffLines } from 'diff';
import { useEffect, useMemo, useState } from 'react';
import type { PlanValue, PlanView, Variant } from '@vibe-spec/core';
import { planStatusLabels, type PlansClientMessage, type PlansHost, type PlansState } from './plansProtocol';
import './plans.css';

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? '';
}
function cellText(cell: PlanValue): string { return cell.present ? valueText(cell.value) : '없음'; }
// Only identify patch addresses here. All displayed current/alternative values
// come from core's comparison, including values inherited from the baseline.
function touched(variant: Variant | undefined, path: string): boolean {
  if (!variant) return false;
  return Object.keys(variant.documents ?? {}).some(scope => pathContains(path, scope) || pathContains(scope, path)) || Object.hasOwn(variant.set ?? {}, path)
    || Object.keys(variant.add ?? {}).some(row => pathContains(row, path))
    || (variant.remove ?? []).some(row => pathContains(row, path));
}
function DocumentDifference({ before, after }: { before: string; after: string }) {
  const changes = useMemo(() => diffLines(before, after, { timeout: 100 }), [before, after]);
  if (!changes) return <><pre>{after}</pre><small>비교량이 커서 전체 원문을 표시합니다.</small></>;
  const removed = changes.filter(change => change.removed).map(change => change.value).join('');
  return <><pre>{changes.map((change, index) => change.removed ? null : change.added
    ? <mark key={index} data-testid="document-added-lines">{change.value}</mark> : <span key={index}>{change.value}</span>)}</pre>
    {removed && <details><summary>삭제된 줄</summary><pre><del>{removed}</del></pre></details>}</>;
}
type Screen = { state?: PlansState; opened?: PlanView | undefined; busy: boolean; error?: string | undefined; confirm?: string | undefined };

export function PlansApp({ host }: { host: PlansHost }) {
  const [screen, setScreen] = useState<Screen>({ busy: false });
  useEffect(() => {
    const unsubscribe = host.subscribe(message => setScreen(previous => {
      if (message.type === 'error') return { ...previous, busy: false, confirm: undefined,
        error: message.code + ': ' + message.message };
      // A watcher notification must never replace the revision being reviewed.
      if (!message.replace) return { ...previous, state: message,
        ...(previous.opened?.revision !== message.revision ? { confirm: undefined } : {}) };
      return { state: message, opened: message.view, busy: false };
    }));
    host.send({ type: 'ready' });
    return unsubscribe;
  }, [host]);
  const { state, opened: view, busy } = screen;
  const stale = Boolean(view && state?.revision !== view.revision);
  const unavailable = Boolean(view && !state?.view);
  const archived = view?.plan.status === 'approved' || state?.view?.plan.status === 'approved';
  const blocked = busy || stale || unavailable || archived || Boolean(screen.error);
  function send(message: PlansClientMessage) {
    setScreen(previous => ({ ...previous, busy: true, error: undefined }));
    host.send(message);
  }
  return <main className="plans-app">
    <header className="plans-toolbar"><div className="plans-heading"><h1>{view?.plan.title ?? '기획 비교'}</h1>
      {view && <span className="plan-status">{planStatusLabels[view.plan.status]}</span>}</div>
      <button disabled={busy} onClick={() => send({ type: 'planReload' })}>현재 파일 다시 읽기</button>
    </header>
    {screen.error && <p role="alert" className="plans-error">{screen.error}</p>}
    {state?.notice && <p role="status">{state.notice}</p>}
    {!state && <p role="status">기획을 불러오는 중입니다.</p>}
    {state && !view && <section className="plans-empty" aria-label="기획 선택 안내">
      <h2>비교할 기획을 선택해 주세요.</h2>
      <p>{state.plans.length ? '왼쪽 사이드바의 기획 비교 목록에서 하나를 선택하면 기준안과 대안을 나란히 볼 수 있습니다.' : '아직 기획이 없습니다. 기획을 만든 뒤 사이드바에서 선택해 주세요.'}</p>
    </section>}
    {view && <>
      <section aria-label="기획 정보" className="plans-info">
        <p className="plans-location"><code>plans/{view.plan.name}/</code></p>
        {view.plan.question && <p>{view.plan.question}</p>}
        {view.plan.sources?.length ? <details><summary>출처</summary><pre>{JSON.stringify(view.plan.sources, null, 2)}</pre></details> : null}
        {archived && <p className="plans-banner">확정 · {state?.view?.plan.selected ?? view.plan.selected}안 선택 · 변경분 보관됨. 다시 확정하거나 상태를 바꿀 수 없습니다.</p>}
        {!archived && <div className="plans-actions">
          <button disabled={blocked || view.plan.status === 'draft'} onClick={() => send({ type: 'planStatus', name: view.plan.name,
            revision: view.revision, status: 'draft' })}>기획중으로 변경</button>
          <button disabled={blocked || view.plan.status === 'review'} onClick={() => send({ type: 'planStatus', name: view.plan.name,
            revision: view.revision, status: 'review' })}>컨펌 전으로 변경</button>
        </div>}
      </section>
      {stale && <p role="alert" className="plans-warning">파일이 변경되었습니다. 열었을 때의 비교와 revision을 유지합니다. 현재 파일을 다시 읽고 검토한 뒤 진행해 주세요.</p>}
      {unavailable && <p role="alert" className="plans-error">이 기획이 삭제되었거나 읽을 수 없습니다. 현재 파일을 다시 읽어 주세요.</p>}
      <p className="muted">비교 대상: 기준안과 각 대안. 강조된 칸은 해당 안의 변경분이며 나머지는 현재 기준안을 따릅니다.</p>
      <div className="plans-scroll"><table aria-label="기준안과 대안 비교">
        <thead><tr><th scope="col">경로</th><th scope="col">기준안</th>{view.plan.variants.map(name => <th scope="col" key={name}>{name}안</th>)}</tr></thead>
        <tbody>{view.comparison.map(row => <tr key={row.path}>
          <th scope="row"><code>{row.path}</code></th><td><pre>{cellText(row.baseline)}</pre></td>
          {view.plan.variants.map(name => <td key={name} data-touched={touched(view.variants[name], row.path)}
            className={touched(view.variants[name], row.path) ? 'plans-touched' : undefined}>
            {row.kind === 'document' ? <DocumentDifference before={cellText(row.baseline)} after={row.alternatives[name] ? cellText(row.alternatives[name]!) : '없음'} /> : <pre>{row.alternatives[name] ? cellText(row.alternatives[name]!) : '없음'}</pre>}
          </td>)}
        </tr>)}</tbody>
      </table></div>
      {!view.comparison.length && <p>비교할 변경분이 없습니다.</p>}
      {view.diagnostics.length > 0 && <section aria-label="검토 진단" className="plans-diagnostics">
        <h2>검토 진단</h2>{view.diagnostics.map((diagnostic, index) => {
          const row = view.comparison.find(row => row.path === diagnostic.path);
          const variant = view.plan.variants.find(name => diagnostic.file === `plans/${view.plan.name}/${name}.yaml`);
          const patch = variant ? view.variants[variant] : undefined;
          const old = patch?.document_base_values && Object.hasOwn(patch.document_base_values, diagnostic.path) ? patch.document_base_values[diagnostic.path] : patch && Object.hasOwn(patch.base_values, diagnostic.path)
            ? valueText(patch.base_values[diagnostic.path]) : patch?.base_missing.includes(diagnostic.path) ? '없음' : undefined;
          return <article key={index} className={diagnostic.severity === 'warning' ? 'plans-warning' : 'plans-error'}>
            <strong>{diagnostic.severity === 'warning' ? '경고' : '오류'} · {diagnostic.code}</strong>
            <p><code>{diagnostic.file} · {diagnostic.path}</code></p><p>{diagnostic.message}</p>
            {diagnostic.severity === 'warning' && row && variant && old !== undefined && <dl>
              <dt>이전 기준</dt><dd><pre>{old}</pre></dd><dt>현재 기준</dt><dd><pre>{cellText(row.baseline)}</pre></dd>
              <dt>{variant}안</dt><dd><pre>{cellText(row.alternatives[variant]!)}</pre></dd>
            </dl>}
          </article>;
        })}
      </section>}
      <section aria-label="대안 변경분" className="plans-patches">
        <h2>{archived ? '보관된 변경분' : '대안별 변경분과 확정'}</h2>
        {view.plan.variants.map(name => <article key={name}>
          <details><summary>{name}안 변경분 · plans/{view.plan.name}/{name}.yaml</summary><pre>{JSON.stringify(view.variants[name], null, 2)}</pre></details>
          {!archived && <button disabled={blocked} onClick={() => setScreen(previous => ({ ...previous, confirm: name }))}>{name}안 확정</button>}
        </article>)}
      </section>
      {screen.confirm && !blocked && <section role="dialog" aria-modal="true" aria-label="대안 확정 확인" className="plans-confirm">
        <h2>{screen.confirm}안을 기준안에 반영할까요?</h2>
        <p>검토한 변경분을 기준안에 반영하고 이 기획을 확정합니다. 모든 대안의 변경분은 보관되며 다시 확정할 수 없습니다.</p>
        <button onClick={() => setScreen(previous => ({ ...previous, confirm: undefined }))}>취소</button>
        <button onClick={() => send({ type: 'planApprove', name: view.plan.name, revision: view.revision,
          variant: screen.confirm!, confirmed: true })}>확인하고 확정</button>
      </section>}
    </>}
  </main>;
}
