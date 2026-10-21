// Giá trị mặc định theo Phụ lục B của spec v1.0.

export const DURATIONS = [5, 10, 15] as const;
export const RATIOS = ['9:16', '16:9', '1:1'] as const;
export const SPLIT_MODES = ['line', 'paragraph', 'all'] as const;
export const JOB_STATUSES = ['waiting', 'running', 'completed', 'failed', 'stopped'] as const;

export const DEFAULTS = {
  splitMode: 'line',
  duration: 10,
  ratio: '9:16',
  pasteAutoRun: true,
  pasteDelayMs: 2000,
  undoWindowMs: 8000,
  countDebounceMs: 200,
  progressRefreshMs: 2000,
  maxRetries: 2,
  timeoutMinutes: 15,
  concurrency: 3,
  slotsPerAccount: 1,
  maxImageBytes: 8 * 1024 * 1024,
  pageSize: 10,
} as const;

export const LIMITS = {
  maxPromptsPerBatch: 500,
  maxPromptLength: 4000,
  maxUploadFiles: 50,
  maxTagLength: 40,
  maxSlotsPerAccount: 10,
  maxConcurrency: 100,
  maxRetries: 10,
  maxTimeoutMinutes: 240,
  pageSizes: [10, 20, 50],
} as const;

export const ACCEPTED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Kích thước thẻ Studio ở zoom 100%, dùng chung để server đặt vị trí mặc định không chồng thẻ. */
export const STUDIO_CARD = { width: 320, height: 470, gap: 28, origin: 40, columns: 4 } as const;
