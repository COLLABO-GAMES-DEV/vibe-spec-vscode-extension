import type { PlansClientMessage, PlansHost, PlansHostMessage } from '../src/plansProtocol';

export function createFakePlansHost(): PlansHost {
  const client = crypto.randomUUID(), listeners = new Set<(message: PlansHostMessage) => void>();
  const name = new URLSearchParams(location.search).get('plan');
  let revision = '', generation = 0, busy = false, polling = false, timer: ReturnType<typeof setInterval> | undefined;
  const emit = (message: PlansHostMessage) => {
    if (message.type === 'plansState') revision = message.revision;
    for (const listener of listeners) listener(message);
  };
  async function request(message: PlansClientMessage): Promise<PlansHostMessage> {
    return (await fetch('/__vibe/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, client, ...(message.type === 'ready' && name ? { name } : {}) }),
    })).json();
  }
  async function refresh() {
    if (busy || polling) return;
    polling = true; const ticket = generation;
    try {
      const message = await request({ type: 'plansRefresh' });
      if (!busy && ticket === generation && message.type === 'plansState' && message.revision !== revision) emit(message);
    } catch { /* An explicit request reports persistent host errors. */ }
    finally { polling = false; }
  }
  return {
    send(message) {
      generation++; busy = true;
      void request(message).then(emit).catch(error => emit({ type: 'error', code: 'PLAN_FAILED', message: String(error) }))
        .finally(() => { busy = false; });
    },
    subscribe(listener) {
      listeners.add(listener); timer ??= setInterval(() => { void refresh(); }, 500);
      return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
    },
  };
}
