/**
 * Phân tích chuỗi cookie người dùng dán vào để đăng nhập bằng phiên có sẵn.
 * Hàm này chỉ trả về số lượng và tên cookie cho UI; không bao giờ đưa giá trị vào thông báo lỗi.
 */

export interface CookiePair {
  name: string;
  value: string;
}

export type CookieProblem = 'empty' | 'format' | 'too-large' | 'too-many';

export type CookieParse = { ok: true; cookies: CookiePair[] } | { ok: false; reason: CookieProblem };

export const COOKIE_LIMITS = { maxBytes: 32 * 1024, maxCount: 100 } as const;

// Tên theo RFC 6265 (token). Giá trị: ký tự in được trừ khoảng trắng và dấu chấm phẩy.
const NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VALUE_RE = /^[\x21-\x3A\x3C-\x7E]*$/;

function unquote(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

function fromJson(text: string): CookiePair[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const out: CookiePair[] = [];
  if (Array.isArray(data)) {
    // Định dạng xuất từ tiện ích trình duyệt: [{ "name": "...", "value": "..." }, ...]
    for (const item of data) {
      if (!item || typeof item !== 'object') return null;
      const { name, value } = item as Record<string, unknown>;
      if (typeof name !== 'string' || typeof value !== 'string') return null;
      out.push({ name, value });
    }
    return out;
  }
  if (data && typeof data === 'object') {
    for (const [name, value] of Object.entries(data)) {
      if (typeof value !== 'string') return null;
      out.push({ name, value });
    }
    return out;
  }
  return null;
}

export function parseCookies(input: string): CookieParse {
  let text = input.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > COOKIE_LIMITS.maxBytes) return { ok: false, reason: 'too-large' };
  text = text.replace(/^cookie\s*:\s*/i, '');

  let pairs: CookiePair[];
  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = fromJson(text);
    if (!parsed) return { ok: false, reason: 'format' };
    pairs = parsed;
  } else {
    pairs = [];
    for (const part of text.split(';')) {
      const piece = part.trim();
      if (!piece) continue;
      const eq = piece.indexOf('=');
      if (eq <= 0) return { ok: false, reason: 'format' };
      pairs.push({ name: piece.slice(0, eq).trim(), value: unquote(piece.slice(eq + 1).trim()) });
    }
  }

  if (pairs.length === 0) return { ok: false, reason: 'format' };
  // Trùng tên thì giữ giá trị xuất hiện sau cùng, như trình duyệt.
  const byName = new Map<string, string>();
  for (const { name, value } of pairs) {
    if (!NAME_RE.test(name) || !VALUE_RE.test(value)) return { ok: false, reason: 'format' };
    byName.set(name, value);
  }
  if (byName.size > COOKIE_LIMITS.maxCount) return { ok: false, reason: 'too-many' };
  return { ok: true, cookies: [...byName].map(([name, value]) => ({ name, value })) };
}

/** Chuỗi dùng cho header `Cookie`. */
export function serializeCookies(cookies: CookiePair[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}
