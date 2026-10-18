import type { ClientMessage, Host, HostMessage, Snapshot } from '../src/protocol.js';

export function createFakeHost(): Host {
  const listeners = new Set<(message: HostMessage) => void>();
  let table = new URLSearchParams(location.search).get('table') ?? 'items';
  const client = crypto.randomUUID();
  let revision = '';
  let polling = false;
  let pending = 0;
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const emit = (message: HostMessage) => {
    if (message.type === 'snapshot') revision = message.revision;
    for (const listener of listeners) listener(message);
  };
  const preferences = () => emit({ type: 'viewState', table,
    widths: JSON.parse(localStorage.getItem('vibe.widths:' + table) ?? '{}') as Record<string, number> });
  async function refresh(force = false) {
    if (!force && (polling || pending)) return;
    polling = true;
    const ticket = generation, selected = table;
    try {
      const snapshot = await (await fetch('/__vibe/snapshot?table=' + encodeURIComponent(selected) + '&client=' + client)).json() as Snapshot;
      if (ticket === generation && table === selected && (force || snapshot.revision !== revision)) emit(snapshot);
    } finally { polling = false; }
  }
  async function send(message: ClientMessage) {
    if (message.type === 'draftState') return;
    if (message.type === 'ready') { await refresh(true); preferences(); return; }
    if (message.type === 'widths') { localStorage.setItem('vibe.widths:' + table, JSON.stringify(message.widths)); preferences(); return; }
    if (message.type === 'copy') { await navigator.clipboard.writeText(message.text); emit({ type: 'copied' }); return; }
    const path = ['follow', 'whereUsed', 'openUsage', 'structurePreview'].includes(message.type) ? '/__vibe/action' : '/__vibe/apply';
    const writing = path === '/__vibe/apply';
    if (writing) pending++;
    generation++;
    try {
      const result = await (await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...message, table, client }),
      })).json() as HostMessage | { type: 'navigate'; snapshot: Snapshot; focus: Extract<HostMessage, { type: 'focus' }> };
      if (result.type === 'navigate') {
        table = result.snapshot.table;
        history.replaceState(null, '', '?table=' + encodeURIComponent(table));
        emit(result.snapshot); preferences(); emit(result.focus); return;
      }
      emit(result);
      if (result.type === 'error') await refresh(true);
    } finally { if (writing) pending--; }
  }
  return {
    send(message) { void send(message).catch(error => emit({ type: 'error', code: 'HOST_ERROR', message: String(error),
      ...('requestId' in message ? { requestId: message.requestId } : {}) })); },
    subscribe(listener) {
      listeners.add(listener);
      timer ??= setInterval(() => { void refresh().catch(() => {}); }, 500);
      return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
    },
  };
}
