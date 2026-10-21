import { EventEmitter } from 'node:events';
import { parseCookies, serializeCookies, type Account, type AuthMethod, type SessionStatus } from '@muse/shared';
import { AuthError, type Credentials, type PlatformAdapter, type SessionHandle } from './adapters/types.js';
import { maskIdentifier, type Vault } from './crypto.js';
import { all, get, run, update, type Db, type Row } from './db.js';
import { AppError, notFound } from './errors.js';
import type { SettingsService } from './settings.js';
import { iso, newId, type Clock } from './util.js';

export interface AccountRow {
  id: string;
  authKind: AuthMethod;
  maskedId: string;
  enabled: boolean;
  slots: number;
  status: SessionStatus;
  reason: string | null;
  lastHealthAt: number | null;
  createdAt: number;
}

function toRow(r: Row): AccountRow {
  return {
    id: r.id as string,
    authKind: (r.auth_kind as AuthMethod | undefined) ?? 'password',
    maskedId: r.masked_id as string,
    enabled: r.enabled === 1,
    slots: r.slots as number,
    status: r.session_status as SessionStatus,
    reason: (r.session_reason as string | null) ?? null,
    lastHealthAt: (r.last_health_at as number | null) ?? null,
    createdAt: r.created_at as number,
  };
}

const REFRESH_RETRY_MS = 5 * 60_000;

export type NewAccount =
  | { method: 'password'; identifier: string; secret: string }
  | { method: 'cookie'; cookie: string; label?: string };

export const accountMsg = {
  offlineLoginRejected: 'Nền tảng từ chối thông tin đăng nhập. Hãy xóa tài khoản và thêm lại với thông tin đúng.',
  offlineUnreachable: 'Không kết nối được tới nền tảng. Hệ thống sẽ tự thử lại; có thể bấm “Kiểm tra” để thử ngay.',
  offlineExpired: 'Phiên đăng nhập đã hết hạn. Bấm “Kiểm tra” để đăng nhập lại.',
  offlineCookieExpired: 'Cookie đã hết hạn hoặc bị nền tảng từ chối. Hãy xóa tài khoản rồi thêm lại bằng cookie mới.',
  cookieInvalid: 'Cookie chưa đúng định dạng. Hãy dán chuỗi dạng tên=giá_trị;tên=giá_trị (header Cookie) hoặc JSON xuất từ tiện ích trình duyệt.',
  cookieTooLarge: 'Cookie quá dài (tối đa 32 KB). Hãy kiểm tra lại nội dung đã dán.',
  cookieTooMany: 'Cookie có quá nhiều mục (tối đa 100). Hãy kiểm tra lại nội dung đã dán.',
  cookieEmpty: 'Chưa dán cookie.',
  disabled: 'Tài khoản đã bị tắt.',
  removed: 'Tài khoản đã bị xóa khỏi pool.',
};

/** Events: 'lost' (accountId, reason) khi tài khoản không còn nhận được job (offline / tắt / xóa). */
export class AccountService extends EventEmitter {
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly inflight = new Map<string, Promise<AccountRow>>();
  private readonly refreshFailedAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  /** Số job đang chạy trên một tài khoản; gắn từ JobRepo. */
  runningCount: (accountId: string) => number = () => 0;

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly adapter: PlatformAdapter,
    private readonly settings: SettingsService,
    private readonly now: Clock = Date.now,
  ) {
    super();
  }

  // ---- đọc ----

  private rows(): AccountRow[] {
    return all(this.db, 'SELECT * FROM accounts ORDER BY created_at ASC').map(toRow);
  }

  private row(id: string): AccountRow {
    const r = get(this.db, 'SELECT * FROM accounts WHERE id = ?', id);
    if (!r) throw notFound('tài khoản');
    return toRow(r);
  }

  private toPublic(r: AccountRow): Account {
    return {
      id: r.id,
      authMethod: r.authKind,
      maskedId: r.maskedId,
      enabled: r.enabled,
      online: r.status === 'healthy',
      sessionStatus: r.status,
      sessionReason: r.reason,
      slots: r.slots,
      runningJobs: this.runningCount(r.id),
      lastHealthAt: iso(r.lastHealthAt),
      createdAt: new Date(r.createdAt).toISOString(),
    };
  }

  list(): Account[] {
    return this.rows().map((r) => this.toPublic(r));
  }

  getPublic(id: string): Account {
    return this.toPublic(this.row(id));
  }

  label(id: string): string | null {
    const r = get(this.db, 'SELECT masked_id FROM accounts WHERE id = ?', id);
    return r ? (r.masked_id as string) : null;
  }

  /** Tài khoản có thể nhận job: enabled + Online + còn session. */
  assignable(): AccountRow[] {
    return this.rows().filter((r) => r.enabled && r.status === 'healthy' && this.sessions.has(r.id));
  }

  session(id: string): SessionHandle | undefined {
    return this.sessions.get(id);
  }

  // ---- ghi ----

  async add(input: NewAccount): Promise<Account> {
    let creds: Credentials;
    let hash: string;
    let masked: string;
    if (input.method === 'cookie') {
      const parsed = parseCookies(input.cookie);
      if (!parsed.ok) {
        const msg = { empty: accountMsg.cookieEmpty, format: accountMsg.cookieInvalid, 'too-large': accountMsg.cookieTooLarge, 'too-many': accountMsg.cookieTooMany }[parsed.reason];
        throw new AppError(400, 'VALIDATION', msg);
      }
      const cookie = serializeCookies(parsed.cookies);
      // Dấu vân tay có khóa: phân biệt các tài khoản cookie mà không để lộ nội dung.
      // Sắp theo tên để cùng một cookie dán theo thứ tự khác vẫn bị nhận là trùng.
      const canonical = serializeCookies([...parsed.cookies].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
      hash = this.vault.identifierHash(`cookie:${canonical}`);
      const label = (input.label ?? '').trim().slice(0, 40);
      masked = `${label || 'Cookie'} · ${hash.slice(0, 6)}`;
      creds = { kind: 'cookie', label, cookie };
    } else {
      hash = this.vault.identifierHash(input.identifier);
      masked = maskIdentifier(input.identifier);
      creds = { kind: 'password', identifier: input.identifier.trim(), secret: input.secret };
    }
    if (get(this.db, 'SELECT 1 AS x FROM accounts WHERE identifier_hash = ?', hash)) {
      throw new AppError(409, 'ACCOUNT_DUPLICATE', 'Tài khoản này đã có trong pool.');
    }
    const id = newId('acc');
    run(
      this.db,
      'INSERT INTO accounts(id, masked_id, identifier_hash, credentials_enc, enabled, slots, auth_kind, session_status, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id, masked, hash, this.vault.encrypt(JSON.stringify(creds)), 1, this.settings.get().slotsPerAccount, input.method, 'unknown', this.now(),
    );
    await this.connect(id);
    return this.toPublic(this.row(id));
  }

  async remove(id: string): Promise<void> {
    this.row(id);
    this.emit('lost', id, accountMsg.removed);
    await this.dropSession(id);
    run(this.db, 'DELETE FROM accounts WHERE id = ?', id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<Account> {
    this.row(id);
    update(this.db, 'accounts', id, 'id', { enabled: enabled ? 1 : 0 });
    if (!enabled) this.emit('lost', id, accountMsg.disabled);
    else if (!this.sessions.has(id) || this.row(id).status !== 'healthy') await this.check(id, true);
    return this.toPublic(this.row(id));
  }

  setSlots(id: string, slots: number): Account {
    this.row(id);
    update(this.db, 'accounts', id, 'id', { slots });
    return this.toPublic(this.row(id));
  }

  // ---- phiên ----

  private credentials(id: string): Credentials {
    const r = get(this.db, 'SELECT credentials_enc FROM accounts WHERE id = ?', id);
    if (!r) throw notFound('tài khoản');
    const raw = JSON.parse(this.vault.decrypt(r.credentials_enc as string)) as Partial<Credentials> & { identifier?: string; secret?: string };
    // Dữ liệu lưu từ bản cũ chưa có `kind`: coi là tài khoản + mật khẩu.
    return raw.kind ? (raw as Credentials) : { kind: 'password', identifier: raw.identifier ?? '', secret: raw.secret ?? '' };
  }

  private async dropSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (s) await this.adapter.close(s).catch(() => undefined);
  }

  private setStatus(id: string, status: SessionStatus, reason: string | null): void {
    const before = this.row(id);
    update(this.db, 'accounts', id, 'id', { session_status: status, session_reason: reason, last_health_at: this.now() });
    if (before.status === 'healthy' && status !== 'healthy') this.emit('lost', id, reason ?? accountMsg.offlineUnreachable);
  }

  /** Đăng nhập (hoặc đăng nhập lại) bằng credential đã lưu. */
  private async connect(id: string): Promise<void> {
    await this.dropSession(id);
    try {
      const session = await this.adapter.login(this.credentials(id));
      this.sessions.set(id, session);
      this.setStatus(id, 'healthy', null);
    } catch (e) {
      const rejected = e instanceof AuthError;
      const cookieAccount = this.row(id).authKind === 'cookie';
      this.setStatus(
        id,
        rejected ? 'expired' : 'unreachable',
        rejected ? (cookieAccount ? accountMsg.offlineCookieExpired : accountMsg.offlineLoginRejected) : accountMsg.offlineUnreachable,
      );
    }
  }

  /**
   * accountHealth(id): kiểm tra phiên, tự phục hồi khi có thể.
   * `userInitiated` cho phép đăng nhập lại ngay cả khi phiên hết hạn.
   */
  check(id: string, userInitiated = false): Promise<AccountRow> {
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const p = this.doCheck(id, userInitiated).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async doCheck(id: string, userInitiated: boolean): Promise<AccountRow> {
    const row = this.row(id);
    const session = this.sessions.get(id);
    if (!session) {
      // 'expired' do bị từ chối đăng nhập chỉ thử lại khi người dùng yêu cầu, tránh khóa tài khoản.
      if (userInitiated || row.status !== 'expired') await this.connect(id);
      return this.row(id);
    }
    const health = await this.adapter.health(session).catch(() => ({ status: 'unreachable', reason: accountMsg.offlineUnreachable }) as const);
    if (health.status === 'healthy') {
      this.setStatus(id, 'healthy', null);
      return this.row(id);
    }
    if (health.status === 'expired') {
      const lastFail = this.refreshFailedAt.get(id) ?? 0;
      if (userInitiated || this.now() - lastFail > REFRESH_RETRY_MS) {
        try {
          await this.adapter.refresh(session);
          this.setStatus(id, 'healthy', null);
          return this.row(id);
        } catch {
          this.refreshFailedAt.set(id, this.now());
          if (userInitiated) {
            await this.connect(id);
            return this.row(id);
          }
        }
      }
      this.setStatus(id, 'expired', row.authKind === 'cookie' ? accountMsg.offlineCookieExpired : accountMsg.offlineExpired);
      return this.row(id);
    }
    this.setStatus(id, 'unreachable', health.reason || accountMsg.offlineUnreachable);
    return this.row(id);
  }

  /** Kiểm tra ngay trước khi gán job; bỏ qua nếu vừa khỏe trong `ttlMs`. */
  async ensureHealthy(id: string, ttlMs: number): Promise<boolean> {
    const r = this.row(id);
    if (r.status === 'healthy' && r.lastHealthAt !== null && this.now() - r.lastHealthAt < ttlMs && this.sessions.has(id)) return true;
    return (await this.check(id)).status === 'healthy';
  }

  /** Khôi phục session cho các tài khoản đã lưu khi khởi động. */
  async restoreSessions(): Promise<void> {
    await Promise.all(this.rows().filter((r) => r.enabled).map((r) => this.connect(r.id)));
  }

  startHealthLoop(intervalMs: number): void {
    this.stopHealthLoop();
    this.timer = setInterval(() => {
      for (const r of this.rows()) if (r.enabled) void this.check(r.id).catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  stopHealthLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async shutdown(): Promise<void> {
    this.stopHealthLoop();
    await Promise.all([...this.sessions.keys()].map((id) => this.dropSession(id)));
  }

  /** Dev / mock: điều khiển trạng thái session mô phỏng. */
  sessionForDev(id: string): SessionHandle | undefined {
    return this.sessions.get(id);
  }
}
