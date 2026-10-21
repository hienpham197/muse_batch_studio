import type { SQLInputValue } from 'node:sqlite';
import {
  JOB_STATUSES,
  type Duration,
  type Job,
  type JobCounts,
  type JobError,
  type JobRef,
  type JobSource,
  type JobStatus,
  type Ratio,
} from '@muse/shared';
import { all, get, run, tx, update, type Db, type Row } from './db.js';
import { foldText, iso, newTaskId, type Clock } from './util.js';
import { thumbUrl } from './images.js';

export interface NewJob {
  source: JobSource;
  studioCardId?: string | null;
  prompt: string;
  refTags: string[];
  refs: JobRef[];
  duration: Duration;
  ratio: Ratio;
  /** Job nguồn nếu đây là job tạo lại. */
  regenOf?: string | null;
}

/** Cột có thể cập nhật; khóa là tên cột SQL. */
export type JobPatch = Partial<{
  status: JobStatus;
  progress: number;
  account_id: string | null;
  attempts: number;
  timed_out: number;
  run_id: string | null;
  order_key: number;
  not_before: number;
  hidden: number;
  started_at: number | null;
  finished_at: number | null;
  last_progress_at: number | null;
  video_file: string | null;
  thumb_file: string | null;
  quality: string | null;
  error: string | null;
}>;

export interface RawJob {
  id: string;
  source: JobSource;
  studioCardId: string | null;
  prompt: string;
  refTags: string[];
  refs: JobRef[];
  status: JobStatus;
  progress: number;
  duration: Duration;
  ratio: Ratio;
  accountId: string | null;
  attempts: number;
  timedOut: boolean;
  runId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastProgressAt: number | null;
  videoFile: string | null;
  thumbFile: string | null;
  quality: string | null;
  error: JobError | null;
  regenOf: string | null;
}

const SELECT = 'SELECT j.*, a.masked_id AS account_label FROM jobs j LEFT JOIN accounts a ON a.id = j.account_id';

function parse<T>(s: unknown, fallback: T): T {
  try {
    return JSON.parse(String(s)) as T;
  } catch {
    return fallback;
  }
}

function toRaw(r: Row): RawJob & { accountLabel: string | null } {
  return {
    id: r.id as string,
    regenOf: (r.regen_of as string | null) ?? null,
    source: r.source as JobSource,
    studioCardId: (r.studio_card_id as string | null) ?? null,
    prompt: r.prompt as string,
    refTags: parse<string[]>(r.ref_tags, []),
    refs: parse<JobRef[]>(r.refs, []),
    status: r.status as JobStatus,
    progress: r.progress as number,
    duration: r.duration as Duration,
    ratio: r.ratio as Ratio,
    accountId: (r.account_id as string | null) ?? null,
    accountLabel: (r.account_label as string | null) ?? null,
    attempts: r.attempts as number,
    timedOut: r.timed_out === 1,
    runId: (r.run_id as string | null) ?? null,
    createdAt: r.created_at as number,
    startedAt: (r.started_at as number | null) ?? null,
    finishedAt: (r.finished_at as number | null) ?? null,
    lastProgressAt: (r.last_progress_at as number | null) ?? null,
    videoFile: (r.video_file as string | null) ?? null,
    thumbFile: (r.thumb_file as string | null) ?? null,
    quality: (r.quality as string | null) ?? null,
    error: parse<JobError | null>(r.error, null),
  };
}

export type JobWithLabel = ReturnType<typeof toRaw>;

export interface ListFilter {
  status?: JobStatus | 'all';
  search?: string;
  source?: JobSource | 'all';
  page: number;
  pageSize: number;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class JobRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock = Date.now,
  ) {}

  private nextOrderKey(): number {
    return (get(this.db, 'SELECT COALESCE(MAX(order_key), 0) + 1 AS n FROM jobs')!.n as number);
  }

  insertMany(items: NewJob[]): JobWithLabel[] {
    const ids: string[] = [];
    tx(this.db, () => {
      let key = this.nextOrderKey();
      const stmt = this.db.prepare(
        `INSERT INTO jobs(id, source, studio_card_id, prompt, search_text, ref_tags, refs, status, progress, duration, ratio, order_key, created_at, regen_of)
         VALUES(?,?,?,?,?,?,?, 'waiting', 0, ?, ?, ?, ?, ?)`,
      );
      for (const it of items) {
        const id = newTaskId();
        stmt.run(id, it.source, it.studioCardId ?? null, it.prompt, foldText(`${id} ${it.prompt}`), JSON.stringify(it.refTags), JSON.stringify(it.refs), it.duration, it.ratio, key++, this.now(), it.regenOf ?? null);
        ids.push(id);
      }
    });
    return ids.map((id) => this.find(id)!);
  }

  find(id: string): JobWithLabel | undefined {
    const r = get(this.db, `${SELECT} WHERE j.id = ?`, id);
    return r ? toRaw(r) : undefined;
  }

  patch(id: string, patch: JobPatch): void {
    update(this.db, 'jobs', id, 'id', patch as Record<string, SQLInputValue>);
  }

  /** Cập nhật chỉ khi job vẫn thuộc lượt chạy `runId` (chống callback muộn / trùng job). */
  patchIfRun(id: string, runId: string, patch: JobPatch): boolean {
    const keys = Object.keys(patch);
    const set = keys.map((k) => `${k} = ?`).join(', ');
    const res = this.db
      .prepare(`UPDATE jobs SET ${set} WHERE id = ? AND run_id = ? AND status = 'running'`)
      .run(...keys.map((k) => (patch as Record<string, SQLInputValue>)[k]!), id, runId);
    return Number(res.changes) > 0;
  }

  delete(id: string): void {
    run(this.db, 'DELETE FROM jobs WHERE id = ?', id);
  }

  running(): JobWithLabel[] {
    return all(this.db, `${SELECT} WHERE j.status = 'running' ORDER BY j.started_at ASC, j.seq ASC`).map(toRaw);
  }

  runningCountByAccount(accountId: string): number {
    return get(this.db, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND account_id = ?", accountId)!.n as number;
  }

  /** Job chờ cũ nhất đã tới hạn (FIFO). */
  nextWaiting(): JobWithLabel | undefined {
    const r = get(this.db, `${SELECT} WHERE j.status = 'waiting' AND j.not_before <= ? ORDER BY j.order_key ASC LIMIT 1`, this.now());
    return r ? toRaw(r) : undefined;
  }

  waitingCount(): number {
    return get(this.db, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'waiting'")!.n as number;
  }

  requeue(id: string, patch: JobPatch = {}, toBack = false): void {
    this.patch(id, {
      status: 'waiting',
      progress: 0,
      account_id: null,
      run_id: null,
      started_at: null,
      finished_at: null,
      last_progress_at: null,
      ...(toBack ? { order_key: this.nextOrderKey() } : {}),
      ...patch,
    });
  }

  affectedByFile(fileId: string): number {
    return get(
      this.db,
      `SELECT COUNT(*) AS n FROM jobs WHERE status IN ('waiting','running')
       AND EXISTS (SELECT 1 FROM json_each(jobs.refs) WHERE json_extract(value, '$.fileId') = ?)`,
      fileId,
    )!.n as number;
  }

  countsAll(): JobCounts {
    return this.countsWhere('hidden = 0', []);
  }

  private countsWhere(where: string, params: SQLInputValue[]): JobCounts {
    const out = { waiting: 0, running: 0, completed: 0, failed: 0, stopped: 0, total: 0 } as JobCounts;
    for (const r of all(this.db, `SELECT status, COUNT(*) AS n FROM jobs WHERE ${where} GROUP BY status`, ...params)) {
      const s = r.status as JobStatus;
      if ((JOB_STATUSES as readonly string[]).includes(s)) {
        out[s] = r.n as number;
        out.total += r.n as number;
      }
    }
    return out;
  }

  list(f: ListFilter): { rows: JobWithLabel[]; counts: JobCounts; filteredTotal: number } {
    const base: string[] = ['hidden = 0'];
    const params: SQLInputValue[] = [];
    if (f.source && f.source !== 'all') {
      base.push('source = ?');
      params.push(f.source);
    }
    const q = foldText((f.search ?? '').trim());
    if (q) {
      base.push("search_text LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(q)}%`);
    }
    const counts = this.countsWhere(base.join(' AND '), params);

    const where = [...base];
    const wp = [...params];
    if (f.status && f.status !== 'all') {
      where.push('status = ?');
      wp.push(f.status);
    }
    const filteredTotal = get(this.db, `SELECT COUNT(*) AS n FROM jobs WHERE ${where.join(' AND ')}`, ...wp)!.n as number;
    // Giữ thứ tự thêm vào để khớp thứ tự prompt người dùng đã dán và không làm dòng nhảy vị trí khi đổi trạng thái.
    const rows = all(
      this.db,
      `${SELECT} WHERE ${where.map((w) => `j.${w}`).join(' AND ')}
       ORDER BY j.seq ASC LIMIT ? OFFSET ?`,
      ...wp,
      f.pageSize,
      (f.page - 1) * f.pageSize,
    ).map(toRaw);
    return { rows, counts, filteredTotal };
  }

  /** "Dọn mục đã xong": chỉ ẩn khỏi danh sách, video vẫn được giữ lại. */
  hideCompleted(source: JobSource): number {
    const res = this.db.prepare("UPDATE jobs SET hidden = 1 WHERE status = 'completed' AND hidden = 0 AND source = ?").run(source);
    return Number(res.changes);
  }

  /** Có job tạo lại từ job này đang chờ hoặc chạy không. */
  hasPendingRegen(id: string): boolean {
    return get(this.db, "SELECT 1 AS x FROM jobs WHERE regen_of = ? AND status IN ('waiting', 'running') LIMIT 1", id) !== undefined;
  }

  toJob(r: JobWithLabel, nowMs: number = this.now()): Job {
    const elapsedMs = r.startedAt === null ? 0 : (r.finishedAt ?? nowMs) - r.startedAt;
    return {
      id: r.id,
      source: r.source,
      studioCardId: r.studioCardId,
      prompt: r.prompt,
      refTags: r.refTags,
      refs: r.refs.map((x) => ({ ...x, thumbnailUrl: thumbUrl(x.fileId) })),
      status: r.status,
      progress: r.status === 'completed' ? 100 : r.progress,
      duration: r.duration,
      ratio: r.ratio,
      accountId: r.accountId,
      accountLabel: r.accountLabel,
      attempts: r.attempts,
      timedOut: r.timedOut,
      createdAt: new Date(r.createdAt).toISOString(),
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      elapsedSec: Math.max(0, Math.floor(elapsedMs / 1000)),
      videoUrl: r.videoFile ? `/api/jobs/${r.id}/video` : null,
      thumbnailUrl: r.thumbFile ? `/api/jobs/${r.id}/thumbnail` : null,
      quality: r.quality,
      error: r.error,
      regenOf: r.regenOf,
      regenerating: r.status !== 'waiting' && r.status !== 'running' && this.hasPendingRegen(r.id),
    };
  }
}
