import { pathParts, pathFromParts } from '@vibe-spec/core/paths';
import type { DocumentsClientMessage, DocumentsHost, DocumentsHostMessage } from '../src/documentsProtocol';
export function createFakeDocumentsHost(): DocumentsHost {
  const client = crypto.randomUUID(), listeners = new Set<(message: DocumentsHostMessage) => void>();
  const name = new URLSearchParams(location.search).get('document');
  let busy = false, polling = false, revision = '', generation = 0, timer: ReturnType<typeof setInterval> | undefined;
  let saving: { requestId: string; reason: string; timeout: ReturnType<typeof setTimeout> } | undefined;
  const emit = (message: DocumentsHostMessage) => {
    if (message.type === 'documentsState' || message.type === 'documentImageAdded') revision = message.revision;
    if (message.type === 'documentFlushResult' && message.state) revision = message.state.revision;
    if (message.type === 'documentsState' && message.focusPath && !message.documents.some(doc => doc.name === pathParts(message.focusPath!)[0])) {
      const [table, key, column] = pathParts(message.focusPath);
      location.href = '/?table=' + encodeURIComponent(table!) + (key ? '&key=' + encodeURIComponent(key) : '') + (column ? '&column=' + encodeURIComponent(column) : ''); return;
    }
    for (const listener of listeners) listener(message);
  };
  const request = async (message: DocumentsClientMessage | Record<string, unknown>): Promise<DocumentsHostMessage> =>
    (await fetch('/__vibe/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...message, client, ...(message.type === 'ready' && name ? { name } : {}) }) })).json();
  const finish = (message: DocumentsHostMessage) => {
    if (saving) clearTimeout(saving.timeout);
    saving = undefined; busy = false; emit(message);
  };
  async function save(reason?: string) {
    if (busy) return;
    busy = true; generation++;
    const requestId = crypto.randomUUID();
    try {
      const prepared = await request({ type: 'documentSavePrepare', requestId });
      if (prepared.type === 'error') { busy = false; emit(prepared); return; }
      reason ??= window.prompt('변경 사유와 함께 저장: 이번 변경의 이유를 적어 주세요.') ?? undefined;
      if (!reason?.trim()) { await request({ type: 'documentSaveCancel', requestId }); busy = false; return; }
      saving = { requestId, reason, timeout: setTimeout(() => {
        void request({ type: 'documentSaveCancel', requestId });
        finish({ type: 'documentFlushResult', requestId, ok: false, code: 'DOCUMENT_FLUSH_TIMEOUT', message: '문서 편집기가 저장에 응답하지 않습니다. 초안을 유지합니다.' });
      }, 10_000) };
      emit({ type: 'documentFlush', requestId });
    } catch (error) { busy = false; emit({ type: 'error', code: 'DOCUMENT_FAILED', message: String(error) }); }
  }
  async function refresh() {
    if (busy || polling) return;
    polling = true; const ticket = generation;
    try {
      const message = await request({ type: 'documentsRefresh' });
      if (!busy && ticket === generation && message.type === 'documentsState' && message.revision !== revision) emit(message);
    } finally { polling = false; }
  }
  return {
    send(message) {
      if (message.type === 'documentDraft') return;
      if (message.type === 'documentSaveRequest') { void save(message.reason); return; }
      if (message.type === 'documentSnapshot' || message.type === 'documentSnapshotError') {
        if (!saving || saving.requestId !== message.requestId) return;
        const { requestId, reason, timeout } = saving;
        clearTimeout(timeout);
        if (message.type === 'documentSnapshotError') {
          void request({ type: 'documentSaveCancel', requestId });
          finish({ type: 'documentFlushResult', requestId, ok: false, code: 'DOCUMENT_SNAPSHOT_FAILED', message: message.message }); return;
        }
        void request({ ...message, reason }).then(finish).catch(error => finish({ type: 'documentFlushResult', requestId, ok: false, code: 'DOCUMENT_FAILED', message: String(error) }));
        return;
      }
      if (saving) return;
      busy = true; generation++;
      void request(message).then(emit).catch(error => emit({ type: 'error', code: 'DOCUMENT_FAILED', message: String(error) })).finally(() => { busy = false; });
    },
    subscribe(listener) {
      listeners.add(listener); timer ??= setInterval(() => { void refresh(); }, 500);
      return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
    },
  };
}
