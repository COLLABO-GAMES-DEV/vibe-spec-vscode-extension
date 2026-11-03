#!/usr/bin/env node
// Creates a synthetic planning folder for local development through the real CLI.
// Usage: node scripts/dev-sample.mjs [folder] [--force]
// Default folder: ~/vibe-spec-dev/sample-planning. No real planning data is used.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const force = args.includes('--force');
const folder = resolve(args.find(arg => !arg.startsWith('--')) ?? join(homedir(), 'vibe-spec-dev', 'sample-planning'));
const cli = fileURLToPath(new URL('../packages/cli/dist/main.js', import.meta.url));
if (!existsSync(cli)) throw new Error('Run pnpm build first: ' + cli);
if (existsSync(folder) && readdirSync(folder).length) {
  if (!force) throw new Error('Folder is not empty (use --force to recreate): ' + folder);
  // --force only replaces an existing planning folder, never an arbitrary directory.
  if (!existsSync(join(folder, '.vibe-spec.json'))) throw new Error('Refusing to delete a folder without .vibe-spec.json: ' + folder);
  rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
}

const work = mkdtempSync(join(tmpdir(), 'vibe-sample-'));
let revision;
let step = 0;
function vibe(...command) {
  let output;
  try {
    output = execFileSync(process.execPath, [cli, ...command, '--json'], { encoding: 'utf8' });
  } catch (error) {
    throw new Error('vibe ' + command.join(' ') + ' failed:\n' + (error.stdout || error.message));
  }
  const result = JSON.parse(output);
  if (!result.ok) throw new Error('vibe ' + command.join(' ') + ' failed:\n' + output);
  revision = result.revision;
  return result;
}
function input(value, extension = '.json') {
  const file = join(work, 'input-' + ++step + extension);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}
const write = (...command) => vibe(...command, '--expect-revision', revision, '--project', folder);
const edit = operation => write('edit', '--target', 'base', '--input', input(operation));

try {
  vibe('init', folder);
  vibe('validate', '--project', folder);
  write('folder', 'create', '경제', '--target', 'base');

  // items: 재화·소모품·장비
  edit({ op: 'table-create', table: 'items', folder: '경제', key: { code: 'code', label: '코드' } });
  edit({ op: 'column-add', table: 'items', column: 'name', definition: { type: 'text', label: '이름', required: true } });
  edit({ op: 'column-add', table: 'items', column: 'kind', definition: { type: 'enum', label: '종류', values: ['currency', 'consumable', 'equipment'] } });
  edit({ op: 'column-add', table: 'items', column: 'rarity', definition: { type: 'enum', label: '등급', values: ['common', 'rare', 'epic'], nullable: true } });
  edit({ op: 'column-add', table: 'items', column: 'note', definition: { type: 'text', label: '메모' } });
  write('apply', '--target', 'base', '--input', input([
    { op: 'create', table: 'items', row: { code: 'gold', name: '골드', kind: 'currency', note: '기본 재화' } },
    { op: 'create', table: 'items', row: { code: 'gem', name: '보석', kind: 'currency', note: '유료 재화' } },
    { op: 'create', table: 'items', row: { code: 'potion_small', name: '작은 회복약', kind: 'consumable', rarity: 'common' } },
    { op: 'create', table: 'items', row: { code: 'potion_large', name: '큰 회복약', kind: 'consumable', rarity: 'rare' } },
    { op: 'create', table: 'items', row: { code: 'sword_wood', name: '나무 검', kind: 'equipment', rarity: 'common' } },
    { op: 'create', table: 'items', row: { code: 'sword_star', name: '별빛 검', kind: 'equipment', rarity: 'epic', note: '시험용 합성 장비' } },
  ]));

  // offers: 상점 상품 (items 참조, 숫자·불리언 예시)
  edit({ op: 'table-create', table: 'offers', folder: '경제', key: { code: 'sku', label: '상품 코드' } });
  edit({ op: 'column-add', table: 'offers', column: 'item', definition: { type: 'ref', table: 'items', label: '상품', required: true, on_delete: 'restrict' } });
  edit({ op: 'column-add', table: 'offers', column: 'count', definition: { type: 'integer', label: '수량', minimum: '1' } });
  edit({ op: 'column-add', table: 'offers', column: 'currency', definition: { type: 'ref', table: 'items', label: '결제 재화', on_delete: 'restrict' } });
  edit({ op: 'column-add', table: 'offers', column: 'price', definition: { type: 'decimal', label: '가격', minimum: '0' } });
  edit({ op: 'column-add', table: 'offers', column: 'available', definition: { type: 'boolean', label: '판매 중', required: true } });
  write('apply', '--target', 'base', '--input', input([
    { op: 'create', table: 'offers', row: { sku: 'starter_pack', item: 'potion_small', count: '10', currency: 'gem', price: '120', available: true } },
    { op: 'create', table: 'offers', row: { sku: 'potion_bundle', item: 'potion_large', count: '5', currency: 'gold', price: '2500.50', available: true } },
    { op: 'create', table: 'offers', row: { sku: 'star_sword', item: 'sword_star', count: '1', currency: 'gem', price: '980', available: false } },
  ]));

  // 문서: 제목 주소와 표 값 링크
  write('document', 'create', '상점 안내', '--folder', '경제', '--target', 'base', '--input', input([
    '# 상점 안내', '', '시험용 합성 기획 문서입니다. 실제 기획 데이터가 아닙니다.', '',
    '## 스타터 팩', '', '첫 구매 유저에게 [작은 회복약](items/potion_small) 묶음을 제공합니다.', '',
    '현재 가격: [가격](offers/starter_pack/price) 보석', '',
    '## 판매 규칙', '', '- 판매 중인 상품만 노출합니다.', '- 별빛 검은 이벤트 기간에만 판매합니다.', '',
  ].join('\n'), '.md'));

  // Independent copy for free editing.
  write('duplicate', 'table', 'offers', '--to', 'offers_B');

  vibe('fmt', '--check', '--project', folder); // every write above must already be fmt-clean
  const validation = vibe('validate', '--project', folder);
  console.log('Synthetic planning folder ready: ' + folder);
  console.log('revision ' + validation.revision + ', diagnostics ' + validation.diagnostics.length);
} finally {
  rmSync(work, { recursive: true, force: true });
}
