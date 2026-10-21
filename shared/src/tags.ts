import { LIMITS } from './constants.js';

const TAG_RE = /^[a-z0-9_-]+$/;

export type TagProblem = 'empty' | 'chars' | 'too-long';

export function checkTag(tag: string): TagProblem | null {
  if (!tag) return 'empty';
  if (tag.length > LIMITS.maxTagLength) return 'too-long';
  if (!TAG_RE.test(tag)) return 'chars';
  return null;
}

/** Tag tự sinh từ tên file: Santa Claus.png → santa-claus, X07.jpg → x07 (Mục 3.2). */
export function suggestTag(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, '');
  const tag = base
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, LIMITS.maxTagLength);
  return tag || 'anh';
}

/** Đảm bảo tag đề xuất không trùng tag đã có: santa → santa-2. */
export function uniqueTag(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10000; i++) {
    const suffix = `-${i}`;
    const candidate = base.slice(0, LIMITS.maxTagLength - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}
