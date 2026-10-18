import { replaceFile } from '../../core/src/file-replacement.js';

/** External fixtures need the same bounded Windows sharing policy as the CLI.
 * Their data may deliberately be invalid, so only the file swap is shared.
 * The test owns these paths; no other writer changes them during this swap. */
export async function replaceTestFile(source: string, destination: string) {
  await replaceFile(source, destination, async () => {});
}
