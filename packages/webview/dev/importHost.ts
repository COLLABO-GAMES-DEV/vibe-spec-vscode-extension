import type { ImportClientMessage, ImportHost, ImportHostMessage } from '../src/importProtocol.js';
export function createFakeImportHost(): ImportHost {
  const client = crypto.randomUUID(), listeners = new Set<(message: ImportHostMessage) => void>();
  const emit = (message: ImportHostMessage) => { for (const listener of listeners) listener(message); };
  async function request(body: unknown) {
    emit(await (await fetch('/__vibe/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body as object, client }) })).json() as ImportHostMessage);
  }
  async function send(message: ImportClientMessage) {
    if (message.type !== 'importPick') { await request(message); return; }
    document.querySelector('[data-import-file]')?.remove();
    const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.csv,.tsv,.xlsx';
    picker.dataset.importFile = ''; picker.style.display = 'none'; document.body.append(picker);
    picker.onchange = async () => {
      const file = picker.files?.[0]; if (!file) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        await request({ type: 'upload', name: file.name, content: btoa(binary) });
      } catch (error) { emit({ type: 'error', code: 'IMPORT_FAILED', message: String(error) }); }
    };
    picker.click();
  }
  return { send(message) { void send(message).catch(error => emit({ type: 'error', code: 'IMPORT_FAILED', message: String(error) })); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
