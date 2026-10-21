import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Ratio } from '@muse/shared';
import { newId, sleep } from '../util.js';
import {
  AuthError,
  WorkerError,
  type Credentials,
  type GenerateHooks,
  type GenerateSpec,
  type GeneratedVideo,
  type HealthResult,
  type PlatformAdapter,
  type SessionHandle,
} from './types.js';

export type MockSessionState = 'ok' | 'dropped' | 'expired';
export type MockControl = MockSessionState;

export interface MockOptions {
  assetsDir: string;
  tmpDir: string;
  /** Thời gian trung bình để "tạo" một video. */
  jobSeconds: number;
  failRate: number;
  /** Hệ số tăng tốc cho test. */
  speed?: number;
  random?: () => number;
}

const ASSET_BY_RATIO: Record<Ratio, string> = { '9:16': '9x16', '16:9': '16x9', '1:1': '1x1' };

/**
 * Adapter mô phỏng để phát triển và nghiệm thu mà không cần nền tảng thật.
 * Video là mẫu test pattern, KHÔNG phải kết quả AI. Có thể điều khiển bằng marker trong prompt:
 *   [lỗi] luôn lỗi · [lỗi-lần-đầu] lỗi lần chạy đầu · [treo] không báo tiến độ · [giới-hạn] báo rate limit một lần.
 */
export class MockAdapter implements PlatformAdapter {
  readonly name = 'mock';
  readonly simulated = true;
  readonly reportsProgress = true;
  private readonly sessions = new Map<string, MockSessionState>();
  private readonly rateLimited = new Set<string>();
  private readonly rnd: () => number;
  private readonly speed: number;

  constructor(private readonly opts: MockOptions) {
    this.rnd = opts.random ?? Math.random;
    this.speed = opts.speed ?? 1;
  }

  async login(credentials: Credentials): Promise<SessionHandle> {
    // Mô phỏng nền tảng từ chối: mật khẩu hoặc giá trị cookie bắt đầu bằng "invalid".
    const rejected =
      credentials.kind === 'password'
        ? credentials.secret.toLowerCase().startsWith('invalid')
        : credentials.cookie.split(';').some((p) => p.slice(p.indexOf('=') + 1).trim().toLowerCase().startsWith('invalid'));
    if (rejected) {
      throw new AuthError('Nền tảng từ chối thông tin đăng nhập.');
    }
    await sleep(150 / this.speed);
    const id = newId('sess');
    this.sessions.set(id, 'ok');
    return { id };
  }

  async health(session: SessionHandle): Promise<HealthResult> {
    const state = this.sessions.get(session.id);
    if (state === 'dropped') return { status: 'unreachable', reason: 'Mất kết nối tới nền tảng (mô phỏng).' };
    if (state === 'expired') return { status: 'expired', reason: 'Phiên đã hết hạn (mô phỏng).' };
    if (!state) return { status: 'expired', reason: 'Phiên không còn tồn tại.' };
    return { status: 'healthy' };
  }

  async refresh(session: SessionHandle): Promise<void> {
    const state = this.sessions.get(session.id);
    if (state === 'expired') this.sessions.set(session.id, 'ok');
    else if (state !== 'ok') throw new Error('Không làm mới được phiên.');
  }

  async close(session: SessionHandle): Promise<void> {
    this.sessions.delete(session.id);
  }

  /** Chỉ dùng cho môi trường dev / nghiệm thu AC-08. */
  control(session: SessionHandle, state: MockControl): void {
    if (this.sessions.has(session.id)) this.sessions.set(session.id, state);
  }

  private assertSession(session: SessionHandle): void {
    if (this.sessions.get(session.id) !== 'ok') {
      throw new WorkerError('session-lost', 'SESSION_LOST', 'Phiên của tài khoản không còn dùng được.');
    }
  }

  async generate(session: SessionHandle, spec: GenerateSpec, hooks: GenerateHooks): Promise<GeneratedVideo> {
    const { signal, onProgress } = hooks;
    this.assertSession(session);

    const p = spec.prompt;
    if (p.includes('[giới-hạn]') && !this.rateLimited.has(spec.jobId)) {
      this.rateLimited.add(spec.jobId);
      throw new WorkerError('rate-limit', 'RATE_LIMIT_429', 'Nền tảng báo vượt giới hạn số lần tạo.');
    }

    const hang = p.includes('[treo]');
    const failFixed = p.includes('[lỗi]') || (p.includes('[lỗi-lần-đầu]') && spec.attempt === 0);
    const failAt = failFixed ? 40 : this.rnd() < this.opts.failRate ? 20 + Math.floor(this.rnd() * 60) : null;

    const totalMs = (this.opts.jobSeconds * 1000 * (0.7 + this.rnd() * 0.6)) / this.speed;
    const stepMs = Math.max(20, 700 / this.speed);
    const started = Date.now();
    let reported = -1;

    for (;;) {
      await sleep(stepMs, signal);
      this.assertSession(session);
      const pct = Math.min(99, Math.floor(((Date.now() - started) / totalMs) * 100));
      if (hang && pct >= 30) {
        await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      if (failAt !== null && pct >= failAt) {
        throw new WorkerError('transient', 'MOCK_GENERATION_FAILED', 'Nền tảng báo lỗi khi tạo video (mô phỏng).');
      }
      if (pct !== reported) {
        reported = pct;
        onProgress(pct);
      }
      if (Date.now() - started >= totalMs) break;
    }

    return this.produce(spec);
  }

  private async produce(spec: GenerateSpec): Promise<GeneratedVideo> {
    const key = ASSET_BY_RATIO[spec.ratio];
    await fsp.mkdir(this.opts.tmpDir, { recursive: true });
    const videoPath = path.join(this.opts.tmpDir, `${spec.jobId}.mp4`);
    const thumbnailPath = path.join(this.opts.tmpDir, `${spec.jobId}.jpg`);
    await fsp.copyFile(path.join(this.opts.assetsDir, `${key}.mp4`), videoPath);
    // Mỗi job một tông màu khác nhau để phân biệt thumbnail trên danh sách.
    let hash = 0;
    for (const ch of spec.jobId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    await sharp(path.join(this.opts.assetsDir, `${key}.jpg`)).modulate({ hue: hash % 360 }).jpeg({ quality: 82 }).toFile(thumbnailPath);
    return { videoPath, thumbnailPath, quality: 'HD' };
  }
}
