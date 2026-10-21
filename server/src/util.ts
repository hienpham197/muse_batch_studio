import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomId(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export const newTaskId = () => `task_${randomId(8)}`;
export const newId = (prefix: string) => `${prefix}_${randomId(12)}`;

/** Bỏ dấu + chữ thường để tìm kiếm không phân biệt dấu. */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

export type Clock = () => number;
