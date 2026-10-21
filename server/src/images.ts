import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  DEFAULTS,
  checkTag,
  suggestTag,
  uniqueTag,
  type CommitRefItem,
  type CommitRefResult,
  type RefImage,
  type StagedImage,
  type TagProblem,
} from '@muse/shared';
import { all, get, run, tx, type Db, type Row } from './db.js';
import { AppError, notFound } from './errors.js';
import { newId, type Clock } from './util.js';

const FORMATS: Record<string, { mime: string; ext: string }> = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
};

const MB = 1024 * 1024;

export const msg = {
  invalidFormat: (name: string) => `Tệp “${name}” không phải ảnh PNG, JPG hoặc WebP hợp lệ. Hãy chọn ảnh đúng định dạng.`,
  tooLarge: (name: string, max: number) => `Tệp “${name}” vượt giới hạn ${Math.round(max / MB)} MB. Hãy chọn ảnh nhỏ hơn.`,
  tagDuplicate: (tag: string) => `Tag @${tag} đã có trong kho. Hãy đổi sang tag khác.`,
  tag: (problem: TagProblem) =>
    problem === 'empty'
      ? 'Tag không được để trống.'
      : problem === 'too-long'
        ? 'Tag tối đa 40 ký tự.'
        : 'Tag chỉ gồm chữ thường a–z, số, dấu gạch ngang (-) và gạch dưới (_).',
};

interface ImageRow {
  id: string;
  kind: 'staged' | 'ref' | 'studio';
  tag: string | null;
  originalName: string;
  mime: string;
  ext: string;
  size: number;
  width: number;
  height: number;
  createdAt: number;
}

function toRow(r: Row): ImageRow {
  return {
    id: r.id as string,
    kind: r.kind as ImageRow['kind'],
    tag: (r.tag as string | null) ?? null,
    originalName: r.original_name as string,
    mime: r.mime as string,
    ext: r.ext as string,
    size: r.size as number,
    width: r.width as number,
    height: r.height as number,
    createdAt: r.created_at as number,
  };
}

export const imageUrl = (id: string) => `/api/images/${id}/file`;
export const thumbUrl = (id: string) => `/api/images/${id}/thumb`;

export class ImageStore {
  private readonly imagesDir: string;
  private readonly thumbsDir: string;
  /** Đếm job chờ / đang chạy đang tham chiếu một file ảnh (gắn từ JobRepo). */
  affectedJobs: (fileId: string) => number = () => 0;

  constructor(
    private readonly db: Db,
    dataDir: string,
    private readonly now: Clock = Date.now,
    private readonly maxBytes: number = DEFAULTS.maxImageBytes,
  ) {
    this.imagesDir = path.join(dataDir, 'images');
    this.thumbsDir = path.join(dataDir, 'thumbs');
    fs.mkdirSync(this.imagesDir, { recursive: true });
    fs.mkdirSync(this.thumbsDir, { recursive: true });
  }

  get maxImageBytes(): number {
    return this.maxBytes;
  }

  filePath(row: Pick<ImageRow, 'id' | 'ext'>): string {
    return path.join(this.imagesDir, `${row.id}.${row.ext}`);
  }

  thumbPath(id: string): string {
    return path.join(this.thumbsDir, `${id}.webp`);
  }

  getRow(id: string): ImageRow | undefined {
    const r = get(this.db, 'SELECT * FROM images WHERE id = ?', id);
    return r ? toRow(r) : undefined;
  }

  private toRef(r: ImageRow): RefImage {
    return {
      id: r.id,
      tag: r.tag ?? '',
      fileName: r.originalName,
      mime: r.mime,
      size: r.size,
      width: r.width,
      height: r.height,
      createdAt: new Date(r.createdAt).toISOString(),
      thumbnailUrl: thumbUrl(r.id),
      imageUrl: imageUrl(r.id),
    };
  }

  /** Kiểm tra byte thật của file bằng bộ giải mã ảnh; không tin tên file hay Content-Type. */
  private async inspect(buffer: Buffer, fileName: string) {
    if (buffer.length > this.maxBytes) {
      throw new AppError(413, 'IMAGE_TOO_LARGE', msg.tooLarge(fileName, this.maxBytes));
    }
    try {
      const meta = await sharp(buffer, { failOn: 'error' }).metadata();
      const fmt = meta.format ? FORMATS[meta.format] : undefined;
      if (!fmt || !meta.width || !meta.height) throw new Error('unsupported');
      return { fmt, width: meta.width, height: meta.height };
    } catch {
      throw new AppError(415, 'IMAGE_INVALID_FORMAT', msg.invalidFormat(fileName));
    }
  }

  private async persist(buffer: Buffer, fileName: string, kind: ImageRow['kind'], tag: string | null): Promise<ImageRow> {
    const { fmt, width, height } = await this.inspect(buffer, fileName);
    const id = newId('img');
    const row: ImageRow = {
      id,
      kind,
      tag,
      originalName: fileName.slice(-200),
      mime: fmt.mime,
      ext: fmt.ext,
      size: buffer.length,
      width,
      height,
      createdAt: this.now(),
    };
    const thumb = await sharp(buffer).rotate().resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    await fsp.writeFile(this.filePath(row), buffer);
    await fsp.writeFile(this.thumbPath(id), thumb);
    run(
      this.db,
      'INSERT INTO images(id, kind, tag, original_name, mime, ext, size, width, height, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      row.id, row.kind, row.tag, row.originalName, row.mime, row.ext, row.size, row.width, row.height, row.createdAt,
    );
    return row;
  }

  private async removeFiles(row: Pick<ImageRow, 'id' | 'ext'>): Promise<void> {
    await Promise.all([fsp.rm(this.filePath(row), { force: true }), fsp.rm(this.thumbPath(row.id), { force: true })]);
  }

  /** Bước 1 của upload (Mục 3.2): lưu tạm, trả về tag đề xuất. */
  async stage(buffer: Buffer, fileName: string, takenTags: Set<string>): Promise<StagedImage> {
    const row = await this.persist(buffer, fileName, 'staged', null);
    const suggestedTag = uniqueTag(suggestTag(fileName), takenTags);
    takenTags.add(suggestedTag);
    return { stagedId: row.id, fileName: row.originalName, size: row.size, suggestedTag, thumbnailUrl: thumbUrl(row.id) };
  }

  /** Bước 2: lưu từng ảnh vào kho. Lỗi ở một ảnh không chặn các ảnh còn lại. */
  commit(items: CommitRefItem[]): CommitRefResult[] {
    const results: CommitRefResult[] = [];
    for (const item of items) {
      const tag = item.tag.trim();
      const staged = get(this.db, "SELECT * FROM images WHERE id = ? AND kind = 'staged'", item.stagedId);
      if (!staged) {
        results.push({ stagedId: item.stagedId, tag, ok: false, code: 'NOT_FOUND', message: 'Ảnh tạm không còn tồn tại. Hãy chọn lại ảnh.' });
        continue;
      }
      const problem = checkTag(tag);
      if (problem) {
        results.push({ stagedId: item.stagedId, tag, ok: false, code: 'TAG_INVALID', message: msg.tag(problem) });
        continue;
      }
      try {
        tx(this.db, () => {
          if (get(this.db, "SELECT 1 AS x FROM images WHERE kind = 'ref' AND tag = ?", tag)) throw new AppError(409, 'TAG_DUPLICATE', msg.tagDuplicate(tag));
          run(this.db, "UPDATE images SET kind = 'ref', tag = ? WHERE id = ?", tag, item.stagedId);
        });
        results.push({ stagedId: item.stagedId, tag, ok: true, image: this.toRef(toRow({ ...staged, kind: 'ref', tag })) });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        results.push({ stagedId: item.stagedId, tag, ok: false, code: 'TAG_DUPLICATE', message: e.message });
      }
    }
    return results;
  }

  async discardStaged(stagedId: string): Promise<void> {
    const r = get(this.db, "SELECT * FROM images WHERE id = ? AND kind = 'staged'", stagedId);
    if (!r) return;
    run(this.db, 'DELETE FROM images WHERE id = ?', stagedId);
    await this.removeFiles(toRow(r));
  }

  async cleanupStaged(maxAgeMs: number): Promise<void> {
    const rows = all(this.db, "SELECT * FROM images WHERE kind = 'staged' AND created_at < ?", this.now() - maxAgeMs);
    for (const r of rows) await this.discardStaged(r.id as string);
  }

  listRefs(): RefImage[] {
    return all(this.db, "SELECT * FROM images WHERE kind = 'ref' ORDER BY created_at ASC, tag ASC").map((r) => this.toRef(toRow(r)));
  }

  refCount(): number {
    return get(this.db, "SELECT COUNT(*) AS n FROM images WHERE kind = 'ref'")!.n as number;
  }

  knownTags(): Set<string> {
    return new Set(all(this.db, "SELECT tag FROM images WHERE kind = 'ref'").map((r) => r.tag as string));
  }

  /** getRefImage(tag): thao tác worker dùng để resolve @tag. */
  getRef(tag: string): RefImage | undefined {
    const r = get(this.db, "SELECT * FROM images WHERE kind = 'ref' AND tag = ?", tag.toLowerCase());
    return r ? this.toRef(toRow(r)) : undefined;
  }

  /** Xóa ảnh khỏi kho. Nếu còn job đang chờ / chạy dùng ảnh này, phải có `force`. */
  async deleteRef(tag: string, force: boolean): Promise<{ affectedJobs: number }> {
    const r = get(this.db, "SELECT * FROM images WHERE kind = 'ref' AND tag = ?", tag);
    if (!r) throw notFound(`ảnh có tag @${tag}`);
    const row = toRow(r);
    const affected = this.affectedJobs(row.id);
    if (affected > 0 && !force) {
      throw new AppError(409, 'CONFIRM_REQUIRED', `Có ${affected} job trong hàng đợi đang dùng @${tag}. Xóa ảnh sẽ làm các job đó mất ảnh tham chiếu.`, { affectedJobs: affected });
    }
    run(this.db, 'DELETE FROM images WHERE id = ?', row.id);
    await this.removeFiles(row);
    return { affectedJobs: affected };
  }

  /** Ảnh đầu vào của thẻ Studio, tách biệt với kho tham chiếu. */
  async addStudioInput(buffer: Buffer, fileName: string): Promise<ImageRow> {
    return this.persist(buffer, fileName, 'studio', null);
  }

  async cloneRefForStudio(tag: string): Promise<ImageRow> {
    const r = get(this.db, "SELECT * FROM images WHERE kind = 'ref' AND tag = ?", tag.toLowerCase());
    if (!r) throw new AppError(404, 'REF_TAG_NOT_FOUND', `Tag @${tag} chưa có ảnh trong kho. Hãy thêm ảnh hoặc sửa tag.`);
    const src = toRow(r);
    return this.persist(await fsp.readFile(this.filePath(src)), src.originalName, 'studio', null);
  }

  async deleteStudioInput(id: string): Promise<void> {
    const r = get(this.db, "SELECT * FROM images WHERE id = ? AND kind = 'studio'", id);
    if (!r) return;
    run(this.db, 'DELETE FROM images WHERE id = ?', id);
    await this.removeFiles(toRow(r));
  }

  fileExists(id: string): boolean {
    const row = this.getRow(id);
    return !!row && fs.existsSync(this.filePath(row));
  }
}
