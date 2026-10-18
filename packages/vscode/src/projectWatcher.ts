import { lstatSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

/**
 * Watch each real directory, including empty directories and recreated children.
 * Notifications invalidate project state; they are not one acknowledgement per write.
 */
export function watchProject(root: string, changed: () => void, failed: (error: Error) => void) {
  const watchers = new Map<string, { watcher: FSWatcher; identity: string }>();
  let disposed = false;
  const managed = new Set(['schemas', 'tables', 'documents', 'imports', 'plans']);
  function reconcile() {
    if (disposed) return;
    const present = new Set<string>();
    function visit(directory: string) {
      const absolute = join(root, directory);
      try {
        const stat = lstatSync(absolute);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        present.add(directory);
        const identity = stat.dev + ':' + stat.ino + ':' + stat.birthtimeMs;
        if (watchers.get(directory)?.identity !== identity) {
          watchers.get(directory)?.watcher.close(); watchers.delete(directory);
          const watcher = watch(absolute, { persistent: false }, (_, file) => {
            if (disposed) return;
            // Git has its own metadata watcher. Locks and other root files are
            // not planning data and must not start extra project/Git refreshes.
            if (!directory && file !== null && file.toString() !== '.gitattributes' && !managed.has(file.toString())) return;
            reconcile(); changed();
          });
          watcher.on('error', error => {
            watcher.close();
            // A queued error from a retired handle must not remove its replacement.
            if (disposed || watchers.get(directory)?.watcher !== watcher) return;
            reconcile();
            const unchanged = watchers.get(directory)?.watcher === watcher;
            if (unchanged) watchers.delete(directory);
            // Windows reports EPERM for a deleted directory. Only treat it as a
            // change when the original identity is gone; live permission errors
            // still surface. https://nodejs.org/api/fs.html#caveats
            if (unchanged || (error as NodeJS.ErrnoException).code !== 'EPERM') failed(error);
            changed();
          });
          watchers.set(directory, { watcher, identity });
        }
        for (const entry of readdirSync(absolute, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.isSymbolicLink() && (directory || managed.has(entry.name))) {
            visit(directory ? directory + '/' + entry.name : entry.name);
          }
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) failed(error as Error);
      }
    }
    visit('');
    for (const [directory, entry] of watchers) if (!present.has(directory)) {
      entry.watcher.close(); watchers.delete(directory);
    }
  }
  reconcile();
  return { dispose() { disposed = true; for (const entry of watchers.values()) entry.watcher.close(); watchers.clear(); } };
}
