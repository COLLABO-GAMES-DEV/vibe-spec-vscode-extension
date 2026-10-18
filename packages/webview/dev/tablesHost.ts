import type { TablesClientMessage, TablesHost, TablesHostMessage } from '../src/tablesProtocol.js';
export function createFakeTablesHost(): TablesHost {
  const client = crypto.randomUUID(), listeners = new Set<(message: TablesHostMessage) => void>();
  const params = new URLSearchParams(location.search);
  let revision = '', generation = 0, busy = false, polling = false, timer: ReturnType<typeof setInterval> | undefined;
  const emit = (reply: TablesHostMessage) => {
    if (reply.type === 'tablesState') revision = reply.revision;
    for (const listener of listeners) listener(reply);
  };
  async function request(message: TablesClientMessage) {
    return (await fetch('/__vibe/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, client, ...(message.type === 'ready' ? { mode: params.get('action') ?? 'list', table: params.get('table') ?? undefined } : {}) })
    })).json() as Promise<TablesHostMessage | { type: 'openTable'; table: string }>;
  }
  async function refresh() {
    if (busy || polling) return;
    polling = true; const ticket = generation;
    try {
      const reply = await request({ type: 'tablesRefresh' });
      if (!busy && ticket === generation && reply.type === 'tablesState' && reply.revision !== revision) emit(reply);
    } catch { /* The next request reports a persistent host error. */ }
    finally { polling = false; }
  }
  return { send(message: TablesClientMessage) {
    generation++; busy = true;
    void request(message).then(reply => {
      if (reply.type === 'openTable') { location.assign('/?table=' + encodeURIComponent(reply.table)); return; }
      emit(reply);
    }).catch(error => emit({ type: 'error', code: 'TABLE_FAILED', message: String(error) })).finally(() => { busy = false; });
  }, subscribe(listener) {
    listeners.add(listener); timer ??= setInterval(() => { void refresh(); }, 500);
    return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
  } };
}
