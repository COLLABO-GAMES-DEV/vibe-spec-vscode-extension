import { createHash } from 'node:crypto';
import { readFile, mkdir, open, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { loadProject, withLock } from './project.js';
import { temporarySibling, replaceFile } from './file-replacement.js';
import { resourceNameError, suggestResourceName } from './names.js';
import { VibeError, type MutationOptions } from './types.js';

export async function addDocumentImage(root: string, revision: string,
  input: string | { name: string; bytes: Uint8Array }, options: MutationOptions = {}) {
  const bytes = typeof input === 'string' ? await readFile(input) : Buffer.from(input.bytes);
  const name = basename(typeof input === 'string' ? input : input.name);
  const extension = extname(name).toLowerCase();
  const valid = extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : ['.jpg','.jpeg'].includes(extension) ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : extension === '.gif' ? /^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'))
    : extension === '.webp' && bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP';
  if (!valid) throw new VibeError('IMAGE_UNSUPPORTED', 'PNG, JPEG, GIF 또는 WebP 이미지 파일을 선택해 주세요.');
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new VibeError('IMAGE_TOO_LARGE', '이미지는 20 MB 이하로 넣어 주세요.');
  const stem = suggestResourceName(name.slice(0, -extension.length)).slice(0,40);
  const filename = stem + '-' + createHash('sha256').update(bytes).digest('hex').slice(0,16) + extension;
  if (resourceNameError(filename)) throw new VibeError('NAME_INVALID', '이미지 파일 이름을 확인해 주세요.');
  const file = 'documents/assets/' + filename;
  return withLock(root, async () => {
    const before = await loadProject(root);
    if (!revision || before.revision !== revision) throw new VibeError('STALE_REVISION', '파일이 바뀌었습니다. 다시 읽은 뒤 이미지를 추가해 주세요.');
    const existing = before.assets?.get(file);
    if (existing && !Buffer.from(existing).equals(bytes)) throw new VibeError('NAME_EXISTS', '같은 이름의 다른 이미지가 있습니다.');
    if (options.dryRun || existing) return { path: 'assets/' + filename, revision, applied: !options.dryRun };
    const destination = join(root,file), temporary = temporarySibling(destination);
    await mkdir(join(root,'documents/assets'), {recursive:true});
    const handle = await open(temporary,'wx');
    try {
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      await replaceFile(temporary,destination,async () => {
        if ((await loadProject(root)).revision !== revision) throw new VibeError('STALE_REVISION', '이미지를 넣기 전에 파일이 바뀌었습니다.');
      });
    } finally { await rm(temporary,{force:true}); }
    return { path: 'assets/' + filename, revision:(await loadProject(root)).revision, applied:true };
  });
}
