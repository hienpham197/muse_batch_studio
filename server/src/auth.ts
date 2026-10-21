import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_FAILED = 5;
const FAIL_WINDOW_MS = 60_000;

const sha = (s: string) => createHash('sha256').update(s).digest();

/**
 * Xác thực chủ sở hữu workspace (Mục 9.2). Chỉ bật khi đặt MUSE_ACCESS_TOKEN;
 * mặc định server chỉ lắng nghe 127.0.0.1.
 */
export class OwnerAuth {
  private readonly sessions = new Map<string, number>();
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly token: string | null) {}

  get enabled(): boolean {
    return this.token !== null;
  }

  /** Trả về session id nếu token đúng; null nếu sai. Giới hạn số lần thử sai theo IP. */
  login(candidate: string, ip: string, now = Date.now()): { sessionId: string } | { locked: true } | null {
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (recent.length >= MAX_FAILED) return { locked: true };
    if (this.token && timingSafeEqual(sha(candidate), sha(this.token))) {
      const sessionId = randomBytes(32).toString('base64url');
      this.sessions.set(sessionId, now + SESSION_TTL_MS);
      this.failures.delete(ip);
      return { sessionId };
    }
    recent.push(now);
    this.failures.set(ip, recent);
    return null;
  }

  isValid(sessionId: string | undefined, now = Date.now()): boolean {
    if (!this.enabled) return true;
    if (!sessionId) return false;
    const exp = this.sessions.get(sessionId);
    if (!exp) return false;
    if (exp < now) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  logout(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(sessionId);
  }
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
