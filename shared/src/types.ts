import type { DURATIONS, JOB_STATUSES, RATIOS, SPLIT_MODES } from './constants.js';

export type Duration = (typeof DURATIONS)[number];
export type Ratio = (typeof RATIOS)[number];
export type SplitMode = (typeof SPLIT_MODES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobSource = 'batch' | 'studio';

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'REF_TAG_NOT_FOUND'
  | 'REF_MISSING'
  | 'REGEN_PENDING'
  | 'IMAGE_INVALID_FORMAT'
  | 'IMAGE_TOO_LARGE'
  | 'TAG_DUPLICATE'
  | 'TAG_INVALID'
  | 'ACCOUNT_OFFLINE'
  | 'ACCOUNT_DUPLICATE'
  | 'NO_ONLINE_ACCOUNT'
  | 'CONFIRM_REQUIRED'
  | 'JOB_FAILED'
  | 'JOB_TIMEOUT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

/** Ảnh trong kho tham chiếu. */
export interface RefImage {
  id: string;
  tag: string;
  fileName: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  createdAt: string;
  thumbnailUrl: string;
  imageUrl: string;
}

/** Ảnh đã upload nhưng chưa lưu vào kho (bước chờ lưu ở Mục 3.2). */
export interface StagedImage {
  stagedId: string;
  fileName: string;
  size: number;
  suggestedTag: string;
  thumbnailUrl: string;
}

export interface UploadRejection {
  fileName: string;
  code: 'IMAGE_INVALID_FORMAT' | 'IMAGE_TOO_LARGE';
  message: string;
}

export interface UploadResult {
  staged: StagedImage[];
  rejected: UploadRejection[];
}

export interface CommitRefItem {
  stagedId: string;
  tag: string;
}

export interface CommitRefResult {
  stagedId: string;
  tag: string;
  ok: boolean;
  code?: 'TAG_DUPLICATE' | 'TAG_INVALID' | 'NOT_FOUND';
  message?: string;
  image?: RefImage;
}

/** Ảnh đã được resolve và ghi vào job tại thời điểm tạo job (Mục 8.6). */
export interface JobRef {
  /** Tag trong kho; rỗng với ảnh đầu vào tải từ máy của thẻ Studio. */
  tag: string;
  fileId: string;
  fileName: string;
  thumbnailUrl: string;
}

export interface JobError {
  code: ErrorCode | string;
  message: string;
  /** Mã lỗi gốc do nền tảng / worker trả về, để đối chiếu. */
  originalCode?: string;
}

export interface Job {
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
  accountLabel: string | null;
  attempts: number;
  timedOut: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedSec: number;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  quality: string | null;
  error: JobError | null;
  /** Job này được tạo lại từ job nào (null nếu không phải job tạo lại). */
  regenOf: string | null;
  /** Đang có job tạo lại từ job này chạy hoặc chờ; khi đó không tạo lại / chạy lại tiếp được. */
  regenerating: boolean;
}

export type JobCounts = Record<JobStatus, number> & { total: number };

export interface JobListResult {
  items: Job[];
  counts: JobCounts;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Số job khớp bộ lọc hiện tại. */
  filteredTotal: number;
}

export type SessionStatus = 'healthy' | 'expired' | 'unreachable' | 'unknown';

export type AuthMethod = 'password' | 'cookie';

export interface Account {
  id: string;
  authMethod: AuthMethod;
  /** Định danh đã che một phần; không bao giờ là plaintext đầy đủ. */
  maskedId: string;
  enabled: boolean;
  online: boolean;
  sessionStatus: SessionStatus;
  sessionReason: string | null;
  slots: number;
  runningJobs: number;
  lastHealthAt: string | null;
  createdAt: string;
}

export interface Settings {
  concurrency: number;
  maxRetries: number;
  timeoutMinutes: number;
  slotsPerAccount: number;
}

export interface ConcurrencyInfo {
  configured: number;
  effective: number;
  freeSlots: number;
  onlineAccounts: number;
}

export type DispatcherBlock = 'no-online-account' | 'cooldown' | null;

export interface AppState {
  serverTime: string;
  /** Có ít nhất một tài khoản Online. */
  online: boolean;
  adapter: string;
  simulated: boolean;
  /** false: nền tảng không báo phần trăm thật, UI hiện thanh không xác định. */
  reportsProgress: boolean;
  dispatcherRunning: boolean;
  dispatcherBlocked: DispatcherBlock;
  counts: JobCounts;
  refCount: number;
  accounts: { total: number; enabled: number; online: number };
  concurrency: ConcurrencyInfo;
  settings: Settings;
  runningJobs: Job[];
}

export interface EnqueueOptions {
  duration: Duration;
  ratio: Ratio;
  /** Tag ảnh dùng chung cho cả batch (tùy chọn). */
  sharedTag?: string | null;
}

export interface EnqueueResult {
  taskIds: string[];
  jobs: Job[];
}

export type StudioCardStatus = 'idle' | 'running' | 'done' | 'error';

export interface StudioCard {
  id: string;
  x: number;
  y: number;
  prompt: string;
  inputTag: string | null;
  inputImageUrl: string;
  inputFileName: string;
  jobId: string | null;
  jobStatus: JobStatus | null;
  status: StudioCardStatus;
  progress: number;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  quality: string | null;
  error: JobError | null;
  createdAt: string;
}
