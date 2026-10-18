import { DocumentsApp } from './DocumentsApp';
import type { DocumentsHost } from './documentsProtocol';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ImportApp } from './ImportApp';
import { GitApp } from './GitApp';
import { TablesApp } from './TablesApp';
import { PlansApp } from './PlansApp';
import type { PlansHost } from './plansProtocol';
import type { TablesHost } from './tablesProtocol';
import type { GitHost } from './gitProtocol';
import type { Host } from './protocol';
import type { ImportHost } from './importProtocol';
import './style.css';

declare const acquireVsCodeApi: undefined | (() => { postMessage(message: unknown): void });
function bridge<Message, Reply>(vscode: { postMessage(message: unknown): void }) {
  return {
    send: (message: Message) => vscode.postMessage(message),
    subscribe: (listener: (reply: Reply) => void) => {
      const receive = (event: MessageEvent<Reply>) => listener(event.data);
      window.addEventListener('message', receive);
      return () => window.removeEventListener('message', receive);
    },
  };
}
async function start() {
  const mode = document.body.dataset.mode ?? new URLSearchParams(location.search).get('mode');
  const root = createRoot(document.getElementById('root')!);
  if (typeof acquireVsCodeApi === 'function') {
    const vscode = acquireVsCodeApi();
    if (mode === 'documents') root.render(<DocumentsApp host={bridge(vscode) as DocumentsHost} />);
    else if (mode === 'plans') root.render(<PlansApp host={bridge(vscode) as PlansHost} />);
    else if (mode === 'tables') root.render(<TablesApp host={bridge(vscode) as TablesHost} />);
    else if (mode === 'git') root.render(<GitApp host={bridge(vscode) as GitHost} />);
    else if (mode === 'import') root.render(<ImportApp host={bridge(vscode) as ImportHost} />);
    else root.render(<App host={bridge(vscode) as Host} />);
  } else if (import.meta.env.DEV) {
    if (mode === 'documents') {
      const { createFakeDocumentsHost } = await import('../dev/documentsHost');
      root.render(<DocumentsApp host={createFakeDocumentsHost()} />);
    } else if (mode === 'plans') {
      const { createFakePlansHost } = await import('../dev/plansHost');
      root.render(<PlansApp host={createFakePlansHost()} />);
    } else if (mode === 'tables') {
      const { createFakeTablesHost } = await import('../dev/tablesHost');
      root.render(<TablesApp host={createFakeTablesHost()} />);
    } else if (mode === 'git') {
      const { createFakeGitHost } = await import('../dev/gitHost');
      root.render(<GitApp host={createFakeGitHost()} />);
    } else if (mode === 'import') {
      const { createFakeImportHost } = await import('../dev/importHost');
      root.render(<ImportApp host={createFakeImportHost()} />);
    } else {
      const { createFakeHost } = await import('../dev/fakeHost');
      root.render(<App host={createFakeHost()} />);
    }
  } else document.getElementById('root')!.textContent = 'VS Code에서 vibe-spec을 열어 주세요.';
}
void start();
