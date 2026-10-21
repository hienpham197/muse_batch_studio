import {
  LIMITS,
  analyzePrompts,
  collectMissingTags,
  type EnqueueOptions,
  type EnqueueResult,
  type JobListResult,
  type JobRef,
  type JobSource,
  type JobStatus,
} from '@muse/shared';
import { AppError } from './errors.js';
import type { Dispatcher } from './dispatcher.js';
import type { ImageStore } from './images.js';
import type { JobRepo } from './jobs.js';

export const queueMsg = {
  empty: 'Chưa có prompt nào để thêm vào hàng đợi.',
  tooMany: (n: number) => `Mỗi lần chỉ thêm tối đa ${n} prompt. Hãy chia nhỏ danh sách.`,
  tooLong: (n: number) => `Mỗi prompt tối đa ${n} ký tự. Hãy rút gọn prompt quá dài.`,
  missingTags: (tags: string[]) => `Tag chưa có ảnh trong kho: ${tags.map((t) => `@${t}`).join(', ')}. Hãy thêm ảnh hoặc sửa tag trước khi chạy.`,
  notBatch: 'Chỉ tạo lại được job của tab Batch. Job Flow Studio hãy tạo lại từ thẻ của nó.',
  stillPending: 'Job này đang chờ hoặc đang chạy, chưa cần tạo lại.',
  regenPending: 'Đang có job tạo lại từ job này chạy hoặc chờ. Hãy đợi job đó xong rồi mới tạo lại tiếp.',
  missingShared: (tag: string) => `Ảnh dùng chung @${tag} chưa có trong kho.`,
};

export class QueueService {
  constructor(
    private readonly jobs: JobRepo,
    private readonly images: ImageStore,
    private readonly dispatcher: Dispatcher,
  ) {}

  /**
   * enqueueBatch: resolve mọi @tag thành file ảnh cụ thể ngay lúc tạo job (Mục 8.6);
   * worker chỉ dùng danh sách đã ghi này.
   */
  enqueueBatch(rawPrompts: string[], opts: EnqueueOptions): EnqueueResult {
    const prompts = rawPrompts.map((p) => p.trim()).filter(Boolean);
    if (prompts.length === 0) throw new AppError(400, 'VALIDATION', queueMsg.empty);
    if (prompts.length > LIMITS.maxPromptsPerBatch) throw new AppError(400, 'VALIDATION', queueMsg.tooMany(LIMITS.maxPromptsPerBatch));
    if (prompts.some((p) => p.length > LIMITS.maxPromptLength)) throw new AppError(400, 'VALIDATION', queueMsg.tooLong(LIMITS.maxPromptLength));

    const known = this.images.knownTags();
    const analysis = analyzePrompts(prompts, known);
    const missing = collectMissingTags(analysis);
    if (missing.length > 0) {
      throw new AppError(422, 'REF_TAG_NOT_FOUND', queueMsg.missingTags(missing), {
        missingTags: missing,
        prompts: analysis.map((a, index) => ({ index, missing: a.missing })).filter((a) => a.missing.length > 0),
      });
    }

    const shared = opts.sharedTag ? this.images.getRef(opts.sharedTag) : undefined;
    if (opts.sharedTag && !shared) {
      throw new AppError(422, 'REF_TAG_NOT_FOUND', queueMsg.missingShared(opts.sharedTag), { missingTags: [opts.sharedTag] });
    }

    const toRef = (tag: string): JobRef => {
      const ref = this.images.getRef(tag)!;
      return { tag, fileId: ref.id, fileName: ref.fileName, thumbnailUrl: ref.thumbnailUrl };
    };

    const created = this.jobs.insertMany(
      analysis.map((a) => {
        const tags = [...a.tags];
        // Ảnh dùng chung bổ sung sau các ảnh gắn bằng @tag.
        const refs = tags.map(toRef);
        if (shared && !tags.includes(shared.tag)) refs.push(toRef(shared.tag));
        return { source: 'batch' as const, prompt: a.prompt, refTags: tags, refs, duration: opts.duration, ratio: opts.ratio };
      }),
    );
    this.dispatcher.wake();
    const jobs = created.map((j) => this.jobs.toJob(j));
    return { taskIds: jobs.map((j) => j.id), jobs };
  }

  /**
   * Tạo lại: job mới cùng prompt, ảnh, độ dài, tỉ lệ; job cũ giữ nguyên để so sánh.
   * Ảnh được resolve lại theo tag, nên ảnh đã đổi trong kho sẽ được dùng bản mới.
   */
  regenerate(id: string): EnqueueResult {
    const src = this.jobs.find(id);
    if (!src) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy job.');
    if (src.source !== 'batch') throw new AppError(409, 'VALIDATION', queueMsg.notBatch);
    if (src.status === 'waiting' || src.status === 'running') throw new AppError(409, 'VALIDATION', queueMsg.stillPending);
    if (this.jobs.hasPendingRegen(id)) throw new AppError(409, 'REGEN_PENDING', queueMsg.regenPending);
    const refs: JobRef[] = [];
    const missing: string[] = [];
    for (const old of src.refs) {
      const ref = this.images.getRef(old.tag);
      if (ref) refs.push({ tag: old.tag, fileId: ref.id, fileName: ref.fileName, thumbnailUrl: ref.thumbnailUrl });
      else missing.push(old.tag);
    }
    if (missing.length > 0) throw new AppError(422, 'REF_TAG_NOT_FOUND', queueMsg.missingTags(missing), { missingTags: missing });
    const [created] = this.jobs.insertMany([{ source: 'batch', prompt: src.prompt, refTags: src.refTags, refs, duration: src.duration, ratio: src.ratio, regenOf: src.id }]);
    // Giống "Chạy lại": người dùng bấm là muốn chạy ngay, nên bật dispatcher nếu đang tắt.
    this.dispatcher.tryStart();
    const job = this.jobs.toJob(created!);
    return { taskIds: [job.id], jobs: [job] };
  }

  /** Dùng cho "Hoàn tác": chỉ xóa được job còn chờ, chưa chạy. */
  async deleteWaiting(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const j = this.jobs.find(id);
      if (j && j.status === 'waiting') {
        await this.dispatcher.deleteJob(id);
        n++;
      }
    }
    return n;
  }

  list(f: { status?: JobStatus | 'all'; search?: string; source?: JobSource | 'all'; page: number; pageSize: number }): JobListResult {
    const { rows, counts, filteredTotal } = this.jobs.list(f);
    const now = Date.now();
    return {
      items: rows.map((r) => this.jobs.toJob(r, now)),
      counts,
      page: f.page,
      pageSize: f.pageSize,
      totalPages: Math.max(1, Math.ceil(filteredTotal / f.pageSize)),
      filteredTotal,
    };
  }

  clearFinished(): number {
    return this.jobs.hideCompleted('batch');
  }
}
