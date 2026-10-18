import { useEffect, useState } from 'react';
import type { Usages } from '@vibe-spec/core';
import type { Host } from './protocol';

export function UsagePanel({ host }: { host: Host }) {
  const [result, setResult] = useState<{ key: string; result: Usages }>();
  useEffect(() => host.subscribe(message => {
    if (message.type === 'usages') setResult(message);
    if (message.type === 'error' && message.usages) setResult(message.usages);
  }), [host]);
  if (!result) return null;
  return <aside className="usage-panel" aria-label="사용처">
    <header><strong>{result.key} 사용처</strong><button onClick={() => setResult(undefined)}>사용처 닫기</button></header>
    {(['references', 'candidates'] as const).map(kind => <section key={kind} aria-label={kind === 'references' ? '선언된 참조' : '본문 텍스트 후보'}>
      <h2>{kind === 'references' ? '선언된 참조' : '본문 텍스트 후보'} ({result.result[kind].length})</h2>
      {result.result[kind].map((usage, index) => <button key={index} onClick={() => host.send({ type: 'openUsage', kind, index })}>
        <code>{usage.path || usage.file + ':' + usage.line}</code><span>{usage.text}</span>
      </button>)}
    </section>)}
  </aside>;
}
