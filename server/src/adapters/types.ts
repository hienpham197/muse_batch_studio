import type { Duration, Ratio } from '@muse/shared';

/**
 * Hợp đồng giữa dispatcher và nền tảng tạo video. Pool / dispatcher / thread giữ nguyên
 * dù một "session" được thiết lập bằng phiên trình duyệt hay API key chính thức (Mục 2.5).
 */

/** Đăng nhập bằng tài khoản + mật khẩu / API key, hoặc bằng cookie của phiên đã đăng nhập sẵn. */
export type Credentials =
  | { kind: 'password'; identifier: string; secret: string }
  /** `cookie` đã chuẩn hóa, dùng nguyên làm giá trị header `Cookie`. */
  | { kind: 'cookie'; label: string; cookie: string };

export interface SessionHandle {
  readonly id: string;
}

export type HealthResult =
  | { status: 'healthy' }
  | { status: 'expired'; reason: string }
  | { status: 'unreachable'; reason: string };

export interface GenerateSpec {
  jobId: string;
  prompt: string;
  duration: Duration;
  ratio: Ratio;
  /** Đường dẫn file ảnh tham chiếu đã resolve, đúng thứ tự gắn vào job. */
  refImages: { tag: string; path: string }[];
  /** Số lần job đã retry trước lần chạy này. */
  attempt: number;
}

export interface GenerateHooks {
  signal: AbortSignal;
  /** Chỉ gọi với tiến độ thật do nền tảng báo về (Mục 9.1). */
  onProgress(percent: number): void;
}

export interface GeneratedVideo {
  /** File tạm đã tải về máy; dispatcher sẽ chuyển vào kho lưu trữ. */
  videoPath: string;
  thumbnailPath: string;
  quality?: string;
}

export type WorkerErrorKind =
  /** Lỗi thoáng qua, retry được. */
  | 'transient'
  /** Lỗi vĩnh viễn (ví dụ nội dung bị từ chối), retry vô ích. */
  | 'permanent'
  /** Nền tảng báo vượt giới hạn: dispatcher phải giảm nhịp. */
  | 'rate-limit'
  /** Phiên của tài khoản không còn dùng được. */
  | 'session-lost';

export class WorkerError extends Error {
  constructor(
    public readonly kind: WorkerErrorKind,
    /** Mã lỗi gốc của nền tảng, hiển thị để đối chiếu. */
    public readonly originalCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface PlatformAdapter {
  readonly name: string;
  /** true với adapter mô phỏng; UI hiển thị cảnh báo rõ ràng. */
  readonly simulated: boolean;
  /** false nếu nền tảng không báo tiến độ phần trăm thật; adapter không được bịa số. */
  readonly reportsProgress: boolean;
  /** Đăng nhập qua kênh an toàn chính thức. Ném AuthError nếu bị từ chối. */
  login(credentials: Credentials): Promise<SessionHandle>;
  health(session: SessionHandle): Promise<HealthResult>;
  /** Làm mới phiên khi có thể; ném lỗi nếu cần đăng nhập lại. */
  refresh(session: SessionHandle): Promise<void>;
  close(session: SessionHandle): Promise<void>;
  generate(session: SessionHandle, spec: GenerateSpec, hooks: GenerateHooks): Promise<GeneratedVideo>;
}
