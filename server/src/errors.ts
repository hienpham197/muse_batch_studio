import type { ErrorCode } from '@muse/shared';

/** Lỗi nghiệp vụ trả về cho client; message luôn là tiếng Việt, không chứa dữ liệu nhạy cảm. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `Không tìm thấy ${what}.`);
