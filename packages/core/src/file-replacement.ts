import { rename, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const waits = [20, 40, 80, 160, 200];

export function temporarySibling(destination: string): string {
  const name = basename(destination);
  if (Buffer.byteLength(name + '.vibe-tmp', 'utf8') <= 255) return destination + '.vibe-tmp';
  return join(dirname(destination), createHash('sha256').update(name).digest('hex') + extname(name) + '.vibe-tmp');
}

/** Short Windows sharing violations must not bypass the caller's stale-data check. */
export async function replaceFile(temporary: string, destination: string, assertCurrent: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await assertCurrent();
    try { await rename(temporary, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= waits.length ||
          !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay(waits[attempt]);
    }
  }
}

/** Retry short Windows directory locks; rmdir still refuses newly added contents. */
export async function removeEmptyDirectory(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rmdir(directory); return; }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= waits.length ||
          (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
      await delay(waits[attempt]);
    }
  }
}
