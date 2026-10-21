import {
  STUDIO_CARD,
  analyzePrompts,
  type Duration,
  type JobError,
  type JobRef,
  type Ratio,
  type StudioCard,
  type StudioCardStatus,
} from '@muse/shared';
import { all, get, run, update, type Db, type Row } from './db.js';
import type { Dispatcher } from './dispatcher.js';
import { AppError, notFound } from './errors.js';
import { imageUrl, thumbUrl, type ImageStore } from './images.js';
import type { JobRepo } from './jobs.js';
import { newId, type Clock } from './util.js';

export interface SkippedCard {
  cardId: string;
  reason: string;
}

export const studioMsg = {
  emptyPrompt: 'Thẻ chưa có prompt. Hãy nhập prompt rồi tạo lại.',
  missingTags: (tags: string[]) => `Prompt có tag chưa có ảnh trong kho: ${tags.map((t) => `@${t}`).join(', ')}.`,
  stopped: 'Đã dừng.',
};

export class StudioService {
  constructor(
    private readonly db: Db,
    private readonly images: ImageStore,
    private readonly jobs: JobRepo,
    private readonly dispatcher: Dispatcher,
    private readonly now: Clock = Date.now,
  ) {}

  private rows(): Row[] {
    return all(this.db, 'SELECT * FROM studio_cards ORDER BY created_at ASC');
  }

  private rowById(id: string): Row {
    const r = get(this.db, 'SELECT * FROM studio_cards WHERE id = ?', id);
    if (!r) throw notFound('thẻ Studio');
    return r;
  }

  private toCard(r: Row): StudioCard {
    const img = this.images.getRow(r.input_image_id as string);
    const job = r.job_id ? this.jobs.find(r.job_id as string) : undefined;
    let status: StudioCardStatus = 'idle';
    let error: JobError | null = null;
    if (job) {
      if (job.status === 'waiting' || job.status === 'running') status = 'running';
      else if (job.status === 'completed') status = 'done';
      else {
        status = 'error';
        error = job.error ?? { code: 'JOB_STOPPED', message: studioMsg.stopped };
      }
    }
    return {
      id: r.id as string,
      x: r.x as number,
      y: r.y as number,
      prompt: r.prompt as string,
      inputTag: (r.input_tag as string | null) ?? null,
      inputImageUrl: img ? imageUrl(img.id) : '',
      inputFileName: img?.originalName ?? '',
      jobId: job?.id ?? null,
      jobStatus: job?.status ?? null,
      status,
      progress: job ? (job.status === 'completed' ? 100 : job.progress) : 0,
      videoUrl: job?.videoFile ? `/api/jobs/${job.id}/video` : null,
      thumbnailUrl: job?.thumbFile ? `/api/jobs/${job.id}/thumbnail` : null,
      quality: job?.quality ?? null,
      error,
      createdAt: new Date(r.created_at as number).toISOString(),
    };
  }

  list(): StudioCard[] {
    return this.rows().map((r) => this.toCard(r));
  }

  get(id: string): StudioCard {
    return this.toCard(this.rowById(id));
  }

  /** Vị trí mặc định không chồng thẻ cũ (Mục 8.4). */
  private freePosition(): { x: number; y: number } {
    const rects = this.rows().map((r) => ({ x: r.x as number, y: r.y as number }));
    const { width, height, gap, origin, columns } = STUDIO_CARD;
    for (let i = 0; i < 1000; i++) {
      const x = origin + (i % columns) * (width + gap);
      const y = origin + Math.floor(i / columns) * (height + gap);
      const overlaps = rects.some((r) => Math.abs(r.x - x) < width && Math.abs(r.y - y) < height);
      if (!overlaps) return { x, y };
    }
    return { x: origin, y: origin };
  }

  private insert(imageId: string, tag: string | null, pos?: { x: number; y: number }): StudioCard {
    const p = pos ?? this.freePosition();
    const id = newId('card');
    run(this.db, 'INSERT INTO studio_cards(id, x, y, prompt, input_image_id, input_tag, created_at) VALUES(?,?,?,?,?,?,?)', id, p.x, p.y, '', imageId, tag, this.now());
    return this.get(id);
  }

  async addFromUpload(buffer: Buffer, fileName: string, pos?: { x: number; y: number }): Promise<StudioCard> {
    const img = await this.images.addStudioInput(buffer, fileName);
    return this.insert(img.id, null, pos);
  }

  async addFromTag(tag: string, pos?: { x: number; y: number }): Promise<StudioCard> {
    const img = await this.images.cloneRefForStudio(tag);
    return this.insert(img.id, tag.toLowerCase(), pos);
  }

  update(id: string, patch: { prompt?: string; x?: number; y?: number }): StudioCard {
    this.rowById(id);
    const set: Record<string, string | number> = {};
    if (patch.prompt !== undefined) set.prompt = patch.prompt;
    if (patch.x !== undefined) set.x = patch.x;
    if (patch.y !== undefined) set.y = patch.y;
    update(this.db, 'studio_cards', id, 'id', set);
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const r = this.rowById(id);
    if (r.job_id) await this.dispatcher.deleteJob(r.job_id as string);
    run(this.db, 'DELETE FROM studio_cards WHERE id = ?', id);
    await this.images.deleteStudioInput(r.input_image_id as string);
  }

  /** Đưa thẻ chưa tạo / bị lỗi vào dispatcher dùng chung (Mục 7.3). */
  async generate(ids: string[] | null, opts: { duration: Duration; ratio: Ratio }): Promise<{ queued: string[]; skipped: SkippedCard[] }> {
    // Chặn sớm khi không có tài khoản Online để không tạo job treo ở hàng chờ.
    this.dispatcher.processQueue();

    const known = this.images.knownTags();
    const queued: string[] = [];
    const skipped: SkippedCard[] = [];
    const cards = this.rows().filter((r) => ids === null || ids.includes(r.id as string));
    for (const r of cards) {
      const card = this.toCard(r);
      if (card.status === 'running' || card.status === 'done') continue;
      const prompt = card.prompt.trim();
      if (!prompt) {
        skipped.push({ cardId: card.id, reason: studioMsg.emptyPrompt });
        continue;
      }
      const [analysis] = analyzePrompts([prompt], known);
      if (analysis!.missing.length > 0) {
        skipped.push({ cardId: card.id, reason: studioMsg.missingTags(analysis!.missing) });
        continue;
      }
      const input = this.images.getRow(r.input_image_id as string);
      if (!input) {
        skipped.push({ cardId: card.id, reason: 'Ảnh đầu vào của thẻ không còn tồn tại. Hãy xóa thẻ và thêm lại ảnh.' });
        continue;
      }
      const refs: JobRef[] = [
        { tag: '', fileId: input.id, fileName: input.originalName, thumbnailUrl: thumbUrl(input.id) },
        ...analysis!.tags.map((tag) => {
          const ref = this.images.getRef(tag)!;
          return { tag, fileId: ref.id, fileName: ref.fileName, thumbnailUrl: ref.thumbnailUrl };
        }),
      ];
      if (card.jobId) await this.dispatcher.deleteJob(card.jobId);
      const [job] = this.jobs.insertMany([{ source: 'studio', studioCardId: card.id, prompt, refTags: analysis!.tags, refs, duration: opts.duration, ratio: opts.ratio }]);
      update(this.db, 'studio_cards', card.id, 'id', { job_id: job!.id });
      queued.push(card.id);
    }
    if (queued.length === 0 && skipped.length === 0 && cards.length === 0) {
      throw new AppError(409, 'VALIDATION', 'Chưa có thẻ nào để tạo. Hãy thêm ảnh vào Studio trước.');
    }
    this.dispatcher.wake();
    return { queued, skipped };
  }
}
