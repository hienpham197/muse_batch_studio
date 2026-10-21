import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ConcurrencyInfo, DispatcherBlock, JobError } from '@muse/shared';
import { WorkerError, type GeneratedVideo, type PlatformAdapter } from './adapters/types.js';
import type { AccountService } from './accounts.js';
import { AppError } from './errors.js';
import type { ImageStore } from './images.js';
import type { JobRepo, JobWithLabel } from './jobs.js';
import type { SettingsService } from './settings.js';
import { newId, type Clock } from './util.js';

export const dispatchMsg = {
  noOnlineAccount: 'Chưa có tài khoản Online nào. Hãy thêm hoặc bật một tài khoản trong Account Pool rồi chạy lại.',
  transient: 'Nền tảng báo lỗi khi tạo video.',
  permanent: 'Nền tảng từ chối yêu cầu này nên không thử lại.',
  rateLimit: 'Nền tảng báo vượt giới hạn; hệ thống tạm giảm nhịp rồi tự thử lại.',
  sessionLost: 'Phiên của tài khoản bị gián đoạn; job được chuyển sang tài khoản khác.',
  refMissing: (tags: string[]) => `Ảnh tham chiếu ${tags.map((t) => (t ? `@${t}` : 'đầu vào')).join(', ')} không còn trong kho. Hãy thêm lại ảnh rồi chạy lại job.`,
  timeout: (min: number) => `Job không có tiến độ trong ${min} phút nên bị đánh dấu timeout.`,
  unexpected: 'Có lỗi ngoài dự kiến khi tạo video. Hãy thử lại sau.',
};

interface Execution {
  runId: string;
  accountId: string;
  controller: AbortController;
}

export interface DispatcherOptions {
  dataDir: string;
  tickIntervalMs: number;
  healthTtlMs: number;
}

export class Dispatcher extends EventEmitter {
  private running = false;
  private readonly executions = new Map<string, Execution>();
  private cooldownUntil = 0;
  private rateStreak = 0;
  private ticking = false;
  private pending = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly videosDir: string;
  private readonly thumbsDir: string;

  constructor(
    private readonly jobs: JobRepo,
    private readonly accounts: AccountService,
    private readonly images: ImageStore,
    private readonly settings: SettingsService,
    private readonly adapter: PlatformAdapter,
    private readonly opts: DispatcherOptions,
    private readonly now: Clock = Date.now,
  ) {
    super();
    this.videosDir = path.join(opts.dataDir, 'videos');
    this.thumbsDir = path.join(opts.dataDir, 'job-thumbs');
    accounts.on('lost', (accountId: string) => this.handleAccountLost(accountId));
  }

  // ---- vòng đời ----

  async init(): Promise<void> {
    await fsp.mkdir(this.videosDir, { recursive: true });
    await fsp.mkdir(this.thumbsDir, { recursive: true });
    // Sau khi khởi động lại không còn execution nào: trả job đang chạy về hàng chờ, không mất job.
    for (const j of this.jobs.running()) this.jobs.requeue(j.id);
  }

  start(): void {
    this.timer = setInterval(() => this.wake(), this.opts.tickIntervalMs);
    this.timer.unref();
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    for (const [id, ex] of this.executions) {
      ex.controller.abort(new Error('shutdown'));
      this.jobs.requeue(id);
    }
    this.executions.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  blocked(): DispatcherBlock {
    if (!this.running) return null;
    if (this.now() < this.cooldownUntil) return 'cooldown';
    if (this.jobs.waitingCount() > 0 && this.accounts.assignable().length === 0) return 'no-online-account';
    return null;
  }

  concurrency(): ConcurrencyInfo {
    const configured = this.settings.get().concurrency;
    const online = this.accounts.assignable();
    const totalSlots = online.reduce((n, a) => n + a.slots, 0);
    const freeSlots = online.reduce((n, a) => n + Math.max(0, a.slots - this.jobs.runningCountByAccount(a.id)), 0);
    return {
      configured,
      effective: Math.min(configured, totalSlots),
      freeSlots: Math.max(0, Math.min(freeSlots, configured - this.executions.size)),
      onlineAccounts: online.length,
    };
  }

  // ---- lệnh từ người dùng ----

  /** processQueue(): chặn nếu không có tài khoản Online (Phụ lục A). */
  processQueue(): void {
    if (this.accounts.assignable().length === 0) {
      throw new AppError(409, 'NO_ONLINE_ACCOUNT', dispatchMsg.noOnlineAccount);
    }
    this.running = true;
    this.wake();
  }

  /** Bật dispatcher nếu có thể, không ném lỗi. Trả về true nếu đang chạy. */
  tryStart(): boolean {
    if (this.accounts.assignable().length === 0) return this.running;
    this.running = true;
    this.wake();
    return true;
  }

  stopAll(): number {
    this.running = false;
    let stopped = 0;
    for (const [id, ex] of this.executions) {
      ex.controller.abort(new Error('stopped'));
      this.jobs.patch(id, { status: 'stopped', run_id: null, finished_at: this.now() });
      stopped++;
    }
    this.executions.clear();
    this.emit('change');
    return stopped;
  }

  retryJob(jobId: string): void {
    const job = this.jobs.find(jobId);
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy job.');
    if (job.status !== 'failed' && job.status !== 'stopped') {
      throw new AppError(409, 'VALIDATION', 'Chỉ chạy lại được job thất bại hoặc đã dừng.');
    }
    if (this.jobs.hasPendingRegen(jobId)) {
      throw new AppError(409, 'REGEN_PENDING', 'Đang có job tạo lại từ job này chạy hoặc chờ. Hãy đợi job đó xong rồi mới chạy lại.');
    }
    this.jobs.requeue(jobId, { attempts: 0, timed_out: 0, error: null, not_before: 0 }, true);
    this.tryStart();
    this.emit('change');
  }

  async deleteJob(jobId: string): Promise<void> {
    const job = this.jobs.find(jobId);
    if (!job) return;
    const ex = this.executions.get(jobId);
    if (ex) {
      ex.controller.abort(new Error('deleted'));
      this.executions.delete(jobId);
    }
    this.jobs.delete(jobId);
    await this.removeMedia(job);
    this.wake();
  }

  private async removeMedia(job: JobWithLabel): Promise<void> {
    if (job.videoFile) await fsp.rm(path.join(this.videosDir, path.basename(job.videoFile)), { force: true });
    if (job.thumbFile) await fsp.rm(path.join(this.thumbsDir, path.basename(job.thumbFile)), { force: true });
  }

  videoFilePath(job: { videoFile: string | null }): string | null {
    return job.videoFile ? path.join(this.videosDir, path.basename(job.videoFile)) : null;
  }

  thumbFilePath(job: { thumbFile: string | null }): string | null {
    return job.thumbFile ? path.join(this.thumbsDir, path.basename(job.thumbFile)) : null;
  }

  // ---- vòng lặp gán job ----

  wake(): void {
    void this.tick().catch((e) => this.emit('error-log', e));
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      this.pending = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.pending = false;
        this.checkTimeouts();
        if (this.running) await this.assign();
        this.maybeFinish();
      } while (this.pending);
    } finally {
      this.ticking = false;
    }
  }

  private maybeFinish(): void {
    if (this.running && this.executions.size === 0 && this.jobs.waitingCount() === 0) this.running = false;
  }

  private pickAccount() {
    let best: { id: string; free: number; running: number } | null = null;
    for (const a of this.accounts.assignable()) {
      const running = this.jobs.runningCountByAccount(a.id);
      const free = a.slots - running;
      if (free > 0 && (!best || running < best.running)) best = { id: a.id, free, running };
    }
    return best;
  }

  private async assign(): Promise<void> {
    if (this.now() < this.cooldownUntil) return;
    for (;;) {
      if (!this.running || this.executions.size >= this.settings.get().concurrency) return;
      const next = this.jobs.nextWaiting();
      if (!next) return;
      const acc = this.pickAccount();
      if (!acc) return;

      let healthy = false;
      try {
        healthy = await this.accounts.ensureHealthy(acc.id, this.opts.healthTtlMs);
      } catch {
        healthy = false;
      }
      if (!healthy) continue; // tài khoản đã bị loại khỏi assignable(); chọn lại
      // Trong lúc chờ health check, người dùng có thể đã dừng / xóa job.
      const job = this.jobs.find(next.id);
      if (!this.running || !job || job.status !== 'waiting') continue;
      // Tài khoản có thể đã bị tắt / mất kết nối trong lúc chờ health check.
      if (!this.accounts.assignable().some((a) => a.id === acc.id)) continue;

      const missing = job.refs.filter((r) => !this.images.fileExists(r.fileId));
      if (missing.length > 0) {
        this.jobs.patch(job.id, {
          status: 'failed',
          finished_at: this.now(),
          error: JSON.stringify({ code: 'REF_MISSING', message: dispatchMsg.refMissing(missing.map((m) => m.tag)) } satisfies JobError),
        });
        continue;
      }
      this.launch(job, acc.id);
    }
  }

  private launch(job: JobWithLabel, accountId: string): void {
    const runId = newId('run');
    const at = this.now();
    this.jobs.patch(job.id, { status: 'running', account_id: accountId, run_id: runId, started_at: at, finished_at: null, last_progress_at: at, progress: 0, not_before: 0 });
    const controller = new AbortController();
    this.executions.set(job.id, { runId, accountId, controller });
    const session = this.accounts.session(accountId)!;
    const spec = {
      jobId: job.id,
      prompt: job.prompt,
      duration: job.duration,
      ratio: job.ratio,
      attempt: job.attempts,
      refImages: job.refs.map((r) => ({ tag: r.tag, path: this.images.filePath(this.images.getRow(r.fileId)!) })),
    };
    void (async () => {
      try {
        const video = await this.adapter.generate(session, spec, {
          signal: controller.signal,
          onProgress: (p) => this.reportProgress(job.id, runId, p),
        });
        await this.completeJob(job.id, runId, video);
      } catch (e) {
        if (controller.signal.aborted) return;
        await this.failJob(job.id, runId, e);
      }
    })();
    this.emit('change');
  }

  // ---- callback của worker ----

  reportProgress(jobId: string, runId: string, percent: number): void {
    const ex = this.executions.get(jobId);
    if (!ex || ex.runId !== runId) return;
    const pct = Math.max(0, Math.min(99, Math.round(percent)));
    this.jobs.patchIfRun(jobId, runId, { progress: pct, last_progress_at: this.now() });
  }

  /** completeJob(jobId, video). Trả false nếu lượt chạy đã cũ (job đã được gán lại / dừng). */
  async completeJob(jobId: string, runId: string, video: GeneratedVideo): Promise<boolean> {
    const ex = this.executions.get(jobId);
    if (!ex || ex.runId !== runId) {
      await Promise.all([fsp.rm(video.videoPath, { force: true }), fsp.rm(video.thumbnailPath, { force: true })]);
      return false;
    }
    const videoFile = `${jobId}.mp4`;
    const thumbFile = `${jobId}.jpg`;
    await fsp.copyFile(video.videoPath, path.join(this.videosDir, videoFile));
    await fsp.copyFile(video.thumbnailPath, path.join(this.thumbsDir, thumbFile));
    await Promise.all([fsp.rm(video.videoPath, { force: true }), fsp.rm(video.thumbnailPath, { force: true })]);
    // Kiểm tra lại sau các await: job có thể đã bị dừng / gán lại trong lúc sao chép file.
    const still = this.executions.get(jobId);
    if (!still || still.runId !== runId) return false;
    const ok = this.jobs.patchIfRun(jobId, runId, {
      status: 'completed',
      progress: 100,
      finished_at: this.now(),
      video_file: videoFile,
      thumb_file: thumbFile,
      quality: video.quality ?? null,
      timed_out: 0,
      error: null,
    });
    this.executions.delete(jobId);
    this.rateStreak = 0;
    this.emit('change');
    this.wake();
    return ok;
  }

  /** failJob(jobId, error): áp dụng retry / cooldown / gán lại theo Mục 2.4 và 9.1. */
  async failJob(jobId: string, runId: string, error: unknown): Promise<void> {
    const ex = this.executions.get(jobId);
    if (!ex || ex.runId !== runId) return;
    this.executions.delete(jobId);
    const werr =
      error instanceof WorkerError ? error : new WorkerError('transient', 'UNEXPECTED', dispatchMsg.unexpected);
    const job = this.jobs.find(jobId);
    if (!job) return;
    const maxRetries = this.settings.get().maxRetries;

    if (werr.kind === 'session-lost') {
      // Không tính vào số lần retry: lỗi do tài khoản, không phải do job.
      this.jobs.requeue(jobId, { error: JSON.stringify({ code: 'ACCOUNT_OFFLINE', message: dispatchMsg.sessionLost, originalCode: werr.originalCode } satisfies JobError) });
      void this.accounts.check(ex.accountId).catch(() => undefined);
    } else if (werr.kind === 'rate-limit') {
      this.rateStreak++;
      const wait = Math.min(120_000, 5_000 * 2 ** (this.rateStreak - 1));
      this.cooldownUntil = this.now() + wait;
      this.jobs.requeue(jobId, {
        not_before: this.cooldownUntil,
        error: JSON.stringify({ code: 'RATE_LIMITED', message: dispatchMsg.rateLimit, originalCode: werr.originalCode } satisfies JobError),
      });
    } else if (werr.kind === 'transient' && job.attempts < maxRetries) {
      const attempts = job.attempts + 1;
      this.jobs.requeue(jobId, {
        attempts,
        not_before: this.now() + Math.min(30_000, 2_000 * 2 ** job.attempts),
        error: JSON.stringify({ code: 'JOB_FAILED', message: `${dispatchMsg.transient} Đang thử lại lần ${attempts}/${maxRetries}.`, originalCode: werr.originalCode } satisfies JobError),
      });
    } else {
      this.jobs.patch(jobId, {
        status: 'failed',
        finished_at: this.now(),
        run_id: null,
        error: JSON.stringify({
          code: 'JOB_FAILED',
          message: werr.kind === 'permanent' ? dispatchMsg.permanent : `${dispatchMsg.transient} Đã thử lại ${job.attempts}/${maxRetries} lần.`,
          originalCode: werr.originalCode,
        } satisfies JobError),
      });
    }
    this.emit('change');
    this.wake();
  }

  // ---- sự kiện hệ thống ----

  /** Tài khoản mất kết nối / bị tắt / bị xóa: job đang chạy quay về hàng chờ, không mất job (Mục 2.4). */
  handleAccountLost(accountId: string): void {
    for (const [jobId, ex] of this.executions) {
      if (ex.accountId !== accountId) continue;
      ex.controller.abort(new Error('account-lost'));
      this.executions.delete(jobId);
      this.jobs.requeue(jobId, { error: JSON.stringify({ code: 'ACCOUNT_OFFLINE', message: dispatchMsg.sessionLost } satisfies JobError) });
    }
    this.emit('change');
    this.wake();
  }

  private checkTimeouts(): void {
    const limitMs = this.settings.get().timeoutMinutes * 60_000;
    const maxRetries = this.settings.get().maxRetries;
    const now = this.now();
    for (const [jobId, ex] of this.executions) {
      const job = this.jobs.find(jobId);
      if (!job) continue;
      if (now - (job.lastProgressAt ?? job.startedAt ?? now) <= limitMs) continue;
      ex.controller.abort(new Error('timeout'));
      this.executions.delete(jobId);
      const err: JobError = { code: 'JOB_TIMEOUT', message: dispatchMsg.timeout(this.settings.get().timeoutMinutes) };
      if (job.attempts < maxRetries) {
        this.jobs.requeue(jobId, { attempts: job.attempts + 1, timed_out: 1, error: JSON.stringify(err) });
      } else {
        this.jobs.patch(jobId, { status: 'failed', finished_at: now, run_id: null, timed_out: 1, error: JSON.stringify(err) });
      }
      this.emit('change');
    }
  }
}
