import { slugify } from 'transliteration';
import filenamify from 'filenamify/browser';
import filenameReservedRegex, { windowsReservedNameRegex } from 'filename-reserved-regex';
import { caseFold } from 'unicode-case-folding';

const resourceNameCollator = new Intl.Collator('ko', { numeric: true });
/** Display order only; original spelling breaks collation ties deterministically. */
export function compareResourceNames(a: string, b: string): number {
  return resourceNameCollator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Compare filesystem identities without changing the stored spelling. */
export const resourceNameKey = (name: string): string => caseFold(name.normalize('NFC')).normalize('NFC');
export function resourceNameError(name: string): string | undefined {
  if (!name) return '이름을 입력해 주세요.';
  if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(name)) !== name) return '유효한 Unicode 파일 이름을 입력해 주세요.';
  if (filenameReservedRegex().test(name) || /[\u0000-\u001f]/.test(name)) return '파일 이름에 사용할 수 없는 문자가 있습니다.';
  if (/^[.]+$/.test(name) || /[. ]$/.test(name) || windowsReservedNameRegex().test(name)) return 'Windows에서 사용할 수 없는 파일 이름입니다.';
  if (new TextEncoder().encode(name + '.yaml').length > 255) return '파일 이름이 너무 깁니다.';
  return undefined;
}
export function suggestResourceName(name: string, existing: readonly string[] = []): string {
  // Keep the proposal under the filesystem byte limit even with Korean text.
  const unicode = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(name));
  const sanitized = filenamify(unicode || 'table', { replacement: '_', maxLength: Infinity }) || 'table';
  const truncated = filenamify(sanitized + '.yaml', { replacement: '_', maxLength: 85 }).slice(0, -5);
  const base = filenamify(truncated, { replacement: '_', maxLength: Infinity }) || 'table';
  const occupied = new Set(existing.map(resourceNameKey));
  let result = base, suffix = 2;
  while (occupied.has(resourceNameKey(result))) result = base + '_' + suffix++;
  return result;
}
export function validColumnCode(code: string): boolean { return /^[a-z0-9_]+$/.test(code); }
export function suggestColumnCode(label: string, existing: readonly string[] = []): string {
  const base = slugify(label, { separator: '_', lowercase: true }).replace(/[^a-z0-9_]/g, '') || 'column';
  let code = base, suffix = 2;
  while (existing.includes(code)) code = base + '_' + suffix++;
  return code;
}
export function tableNameError(name: string, existing: readonly string[]): string | undefined {
  if (!name) return '테이블 이름을 입력해 주세요.';
  const error = name.includes('/') ? '테이블 이름에는 /를 사용할 수 없습니다.' : resourceNameError(name);
  if (error) return error + ' 이름 제안: ' + suggestResourceName(name, existing);
  if (existing.some(other => resourceNameKey(other) === resourceNameKey(name))) {
    return '이미 같은 이름의 테이블이 있습니다. 대소문자만 다른 이름도 중복입니다. 이름 제안: ' + suggestResourceName(name, existing);
  }
  return undefined;
}
