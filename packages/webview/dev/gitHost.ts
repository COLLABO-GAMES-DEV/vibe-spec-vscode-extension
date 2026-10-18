import type { GitClientMessage, GitHost, GitHostMessage } from '../src/gitProtocol.js';
export function createFakeGitHost(): GitHost {
  const listeners = new Set<(message: GitHostMessage) => void>();
  return {
    send(message: GitClientMessage) {
      void fetch('/__vibe/git', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) })
        .then(response => response.json() as Promise<GitHostMessage>)
        .then(reply => { for (const listener of listeners) listener(reply); })
        .catch(error => { for (const listener of listeners) listener({ type: 'error', code: 'GIT_FAILED', message: String(error) }); });
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
