import type {
  Account,
  ApiErrorBody,
  AppState,
  CommitRefItem,
  CommitRefResult,
  Duration,
  EnqueueOptions,
  EnqueueResult,
  JobListResult,
  JobStatus,
  Ratio,
  RefImage,
  Settings,
  StudioCard,
  UploadResult,
} from '@muse/shared';
import { vi } from '../i18n/vi';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: any,
  ) {
    super(message);
  }
}

type Listener = () => void;
let onUnauthenticated: Listener | null = null;
export function setUnauthenticatedHandler(fn: Listener | null) {
  onUnauthenticated = fn;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', vi.common.network);
  }
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
  let parsed: ApiErrorBody | undefined;
  try {
    parsed = (await res.json()) as ApiErrorBody;
  } catch {
    /* thân phản hồi không phải JSON */
  }
  const err = new ApiError(res.status, parsed?.error.code ?? 'UNKNOWN', parsed?.error.message ?? vi.common.unexpected, parsed?.error.details);
  if (err.code === 'UNAUTHENTICATED') onUnauthenticated?.();
  throw err;
}

const get = <T>(url: string) => request<T>('GET', url);
const post = <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {});

export interface JobQuery {
  status: JobStatus | 'all';
  search: string;
  page: number;
  pageSize: number;
}

export const api = {
  authStatus: () => get<{ required: boolean; authenticated: boolean }>('/api/auth/status'),
  login: (token: string) => post<{ ok: true }>('/api/auth/login', { token }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),

  state: () => get<AppState>('/api/state'),

  accounts: () => get<{ accounts: Account[] }>('/api/accounts').then((r) => r.accounts),
  addAccount: (input: { method: 'password'; identifier: string; secret: string } | { method: 'cookie'; cookie: string; label?: string }) =>
    post<{ account: Account }>('/api/accounts', input).then((r) => r.account),
  setAccountEnabled: (id: string, enabled: boolean) => request<{ account: Account }>('PATCH', `/api/accounts/${id}`, { enabled }).then((r) => r.account),
  checkAccount: (id: string) => post<{ account: Account }>(`/api/accounts/${id}/health`).then((r) => r.account),
  setAccountSlots: (id: string, slots: number) => request<{ account: Account }>('PATCH', `/api/accounts/${id}`, { slots }).then((r) => r.account),
  removeAccount: (id: string) => request<{ ok: true }>('DELETE', `/api/accounts/${id}?confirm=true`),

  refs: () => get<{ refs: RefImage[] }>('/api/refs').then((r) => r.refs),
  uploadRefs: (files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    return post<UploadResult>('/api/refs/upload', form);
  },
  commitRefs: (items: CommitRefItem[]) => post<{ results: CommitRefResult[] }>('/api/refs/commit', { items }).then((r) => r.results),
  discardStaged: (id: string) => request<{ ok: true }>('DELETE', `/api/refs/staged/${id}`),
  deleteRef: (tag: string, force = false) => request<{ affectedJobs: number }>('DELETE', `/api/refs/${encodeURIComponent(tag)}${force ? '?force=true' : ''}`),

  settings: () => get<{ settings: Settings }>('/api/settings').then((r) => r.settings),
  updateSettings: (patch: Partial<Settings>) => request<{ settings: Settings }>('PUT', '/api/settings', patch).then((r) => r.settings),
  setConcurrency: (n: number) => request<{ settings: Settings }>('PUT', '/api/settings/concurrency', { n }),

  enqueue: (prompts: string[], options: EnqueueOptions) => post<EnqueueResult>('/api/queue/enqueue', { prompts, options }),
  process: () => post<{ ok: true }>('/api/queue/process'),
  stopAll: () => post<{ stopped: number }>('/api/queue/stop'),
  clearFinished: () => post<{ cleared: number }>('/api/queue/clear-finished'),
  deleteMany: (ids: string[]) => post<{ deleted: number }>('/api/jobs/delete-many', { ids }),

  jobs: (q: JobQuery) => get<JobListResult>(`/api/jobs?${new URLSearchParams({ status: q.status, search: q.search, page: String(q.page), pageSize: String(q.pageSize), source: 'batch' })}`),
  retryJob: (id: string) => post<{ ok: true }>(`/api/jobs/${id}/retry`),
  regenerateJob: (id: string) => post<EnqueueResult>(`/api/jobs/${id}/regenerate`),
  deleteJob: (id: string) => request<{ ok: true }>('DELETE', `/api/jobs/${id}`),

  studioCards: () => get<{ cards: StudioCard[] }>('/api/studio/cards').then((r) => r.cards),
  addStudioCardFromFile: (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return post<{ card: StudioCard }>('/api/studio/cards', form).then((r) => r.card);
  },
  addStudioCardFromTag: (tag: string) => post<{ card: StudioCard }>('/api/studio/cards', { tag }).then((r) => r.card),
  updateStudioCard: (id: string, patch: { prompt?: string; x?: number; y?: number }) => request<{ card: StudioCard }>('PATCH', `/api/studio/cards/${id}`, patch).then((r) => r.card),
  deleteStudioCard: (id: string) => request<{ ok: true }>('DELETE', `/api/studio/cards/${id}`),
  generateStudio: (opts: { duration: Duration; ratio: Ratio }, cardId?: string) =>
    post<{ queued: string[]; skipped: { cardId: string; reason: string }[] }>(cardId ? `/api/studio/cards/${cardId}/generate` : '/api/studio/generate-all', opts),
};

export const downloadUrl = (jobId: string) => `/api/jobs/${jobId}/video?download=1`;
