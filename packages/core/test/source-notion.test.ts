import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectNotionSource } from '../src/source-notion.js';

const roots: string[] = [];
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const pageId = '11111111111111111111111111111111';
const targetId = 'abcdef1234567890abcdef1234567890';
const dbId = '33333333333333333333333333333333';

async function archive(files: Record<string, string | Uint8Array>, level: 0 | 6 = 6): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibe-source-notion-'));
  roots.push(root);
  const file = join(root, '한글 원문.zip');
  await writeFile(file, zipSync(Object.fromEntries(Object.entries(files).map(([path, content]) => [
    path, typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
  ])), { level }));
  return file;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Notion source ZIP inspection', () => {
  it.each([0, 6] as const)('preserves Korean paths, UTF-8 originals and binary hashes (ZIP level %s)', async level => {
    const page = `기획/한글 (초안) ${pageId}.md`;
    const csv = `기획/수치 ${dbId}.csv`;
    const markdown = '\uFEFF# 한글 원문\r\n\r\n| 숫자 | 표현 |\r\n| --- | --- |\r\n| 900719925474099312345 | +001.2300E+0002 |\r\n';
    const table = '\uFEFFKey,값,설명\r\n001,-0.000,"줄 1\r\n줄 2"\r\n002,1e400," 따옴표 ""원문"" "\r\n';
    const image = new Uint8Array([137, 80, 78, 71, 0, 255, 42]);
    const file = await archive({ '기획/': '', [page]: markdown, [csv]: table, '기획/그림 (1).png': image }, level);
    const original = await readFile(file);
    const source = await inspectNotionSource(relative(process.cwd(), file));
    expect(source).toMatchObject({ kind: 'notion', file, sourceHash: hash(original), issues: [] });
    expect(source.files).toEqual([
      { path: page, text: markdown, sha256: hash(Buffer.from(markdown)), bytes: Buffer.byteLength(markdown) },
      { path: csv, text: table, sha256: hash(Buffer.from(table)), bytes: Buffer.byteLength(table) },
      { path: '기획/그림 (1).png', sha256: hash(image), bytes: image.byteLength },
    ]);
    expect(source.pages).toEqual([{ id: pageId, path: page, title: '한글 (초안)', links: [] }]);
    expect(source.databases).toEqual([{ id: dbId, preferred: csv, files: [csv] }]);
    expect(await readFile(file)).toEqual(original);
    expect(await readdir(roots.at(-1)!)).toEqual(['한글 원문.zip']);
  });

  it('reads parentheses and reference links with a Markdown parser, including self links and anchors', async () => {
    const page = `한글/시작 ${pageId}.md`;
    const target = `한글/하위/문서 (조건(둘)) ${targetId.toUpperCase()}.md`;
    const targetUrl = `하위/문서%20(조건(둘))%20${targetId.toUpperCase()}.md#부분%20하나`;
    const ownUrl = `시작%20${pageId}.md#자기`;
    const notionUrl = `https://www.notion.so/renamed-${targetId}?view=1#위치`;
    const markdown = [
      `[괄호](${targetUrl})`,
      `[자기](${ownUrl})`,
      '[제목](#부분%20하나)',
      '[참조][reference]',
      '',
      `[reference]: <하위/문서 (조건(둘)) ${targetId.toUpperCase()}.md>`,
      '',
      `[ID로 연결](옛이름%20${targetId}.md)`,
      `[Notion](${notionUrl})`,
      `[Notion 자기](https://example.notion.site/renamed-${pageId})`,
      `[외부](https://example.com/${pageId}#external)`,
      '![이미지](그림%20(1).png)',
      '`[코드](missing-inline.md)`',
      '',
      '```md',
      '[코드](missing-fenced.md)',
      '```',
    ].join('\n');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    const source = await inspectNotionSource(await archive({
      [page]: markdown, [target]: '# 대상\n', '한글/그림 (1).png': new Uint8Array([0, 255]),
    }));
    expect(source.pages[0]?.links).toEqual([
      { kind: 'link', url: targetUrl, targetId, targetPath: target, self: false, anchor: '부분 하나' },
      { kind: 'link', url: ownUrl, targetId: pageId, targetPath: page, self: true, anchor: '자기' },
      { kind: 'link', url: '#부분%20하나', targetId: pageId, targetPath: page, self: true, anchor: '부분 하나' },
      { kind: 'link', url: `하위/문서 (조건(둘)) ${targetId.toUpperCase()}.md`, targetId, targetPath: target, self: false },
      { kind: 'link', url: `옛이름%20${targetId}.md`, targetId, targetPath: target, self: false },
      { kind: 'link', url: notionUrl, targetId, targetPath: target, self: false, anchor: '위치' },
      { kind: 'link', url: `https://example.notion.site/renamed-${pageId}`, targetId: pageId, targetPath: page, self: true },
      { kind: 'link', url: `https://example.com/${pageId}#external`, self: false, anchor: 'external' },
      { kind: 'image', url: '그림%20(1).png', targetPath: '한글/그림 (1).png', self: false },
    ]);
    expect(source.files[0]?.text).toBe(markdown);
    expect(source.issues).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('groups CSV files by ID, prefers _all.csv in either order and retains every original', async () => {
    const view = `표/보기 ${dbId}.csv`;
    const all = `표/전체 ${dbId}_all.csv`;
    const otherView = `다른 경로/보기 ${dbId}.csv`;
    const fallbackId = '44444444444444444444444444444444';
    const fallback = `이름 ${fallbackId}.csv`;
    const page = `페이지 ${pageId}.md`;
    const link = `https://notion.so/${dbId}`;
    for (const paths of [[view, all, otherView], [all, otherView, view]]) {
      const source = await inspectNotionSource(await archive({
        ...Object.fromEntries(paths.map((path, index) => [path, `Key,원문\n${index},+001.2300E+0002\n`])),
        [fallback]: 'Key,값\n001,-0.000\n',
        [page]: `[데이터베이스](${link})`,
      }));
      expect(source.databases).toEqual([
        { id: dbId, preferred: all, files: paths },
        { id: fallbackId, preferred: fallback, files: [fallback] },
      ]);
      expect(source.files.filter(file => file.path.endsWith('.csv')).map(file => file.path)).toEqual([...paths, fallback]);
      paths.forEach((path, index) => expect(source.files.find(file => file.path === path)?.text).toBe(`Key,원문\n${index},+001.2300E+0002\n`));
      expect(source.pages[0]?.links).toEqual([{ kind: 'link', url: link, targetId: dbId, targetPath: all, self: false }]);
      expect(source.issues).toEqual([]);
    }
  });

  it('retains nested ZIPs and unrecognized filenames without inventing page identities or decoding invalid UTF-8', async () => {
    const nested = zipSync({ [`안쪽 ${targetId}.md`]: Buffer.from('# nested') });
    const invalid = new Uint8Array([0xc3, 0x28]);
    const badPage = `깨진 글 ${pageId}.md`;
    const source = await inspectNotionSource(await archive({
      '포장/안쪽.zip': nested, 'README.md': '# ordinary Markdown\n', '기타.csv': '001,+002\n', [badPage]: invalid,
    }));
    expect(source.files).toEqual([
      { path: '포장/안쪽.zip', sha256: hash(nested), bytes: nested.byteLength },
      expect.objectContaining({ path: 'README.md', text: '# ordinary Markdown\n' }),
      expect.objectContaining({ path: '기타.csv', text: '001,+002\n' }),
      { path: badPage, sha256: hash(invalid), bytes: invalid.byteLength },
    ]);
    expect(source.pages).toEqual([{ id: pageId, path: badPage, title: '깨진 글', links: [] }]);
    expect(source.databases).toEqual([]);
    expect(source.issues).toEqual([
      expect.stringContaining('Nested ZIP'),
      expect.stringContaining('README.md'),
      expect.stringContaining('기타.csv'),
      expect.stringContaining('not valid UTF-8'),
    ]);
  });

  it('reports missing, ambiguous and malformed destinations while preserving link URLs', async () => {
    const source = await inspectNotionSource(await archive({
      [`페이지 ${pageId}.md`]: `[missing](../없는파일.md#없는제목)\n[ambiguous](https://notion.so/${targetId})\n[encoding](bad%zz.md)`,
      [`첫째 ${targetId}.md`]: '# first',
      [`둘째 ${targetId}.md`]: '# second',
    }));
    expect(source.pages[0]?.links).toEqual([
      { kind: 'link', url: '../없는파일.md#없는제목', targetPath: '../없는파일.md', anchor: '없는제목', self: false },
      { kind: 'link', url: `https://notion.so/${targetId}`, targetId, self: false },
      { kind: 'link', url: 'bad%zz.md', targetPath: 'bad%zz.md', self: false },
    ]);
    expect(source.issues).toEqual([
      expect.stringContaining('Target is not in the ZIP'),
      expect.stringContaining('Ambiguous Notion ID'),
      expect.stringContaining('Invalid URL encoding'),
      expect.stringContaining('Target is not in the ZIP'),
    ]);
  });

  it('accepts an empty ZIP and rejects unsupported inputs or broken archives', async () => {
    const file = await archive({});
    expect(await inspectNotionSource(file)).toMatchObject({ files: [], pages: [], databases: [], issues: [] });
    await expect(inspectNotionSource(file.replace(/\.zip$/, '.md'))).rejects.toThrow('requires a ZIP');
    await writeFile(file, 'not a zip archive');
    await expect(inspectNotionSource(file)).rejects.toThrow();
  });
});
