import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULTS, type AppState, type Duration, type Ratio, type RefImage, type SplitMode } from '@muse/shared';
import { api, ApiError } from '../api/client';
import { vi } from '../i18n/vi';

export interface Prefs {
  splitMode: SplitMode;
  duration: Duration;
  ratio: Ratio;
  pasteAutoRun: boolean;
  sharedTag: string | null;
}

const PREFS_KEY = 'muse.prefs.v1';
const DEFAULT_PREFS: Prefs = {
  splitMode: DEFAULTS.splitMode,
  duration: DEFAULTS.duration,
  ratio: DEFAULTS.ratio,
  pasteAutoRun: DEFAULTS.pasteAutoRun,
  sharedTag: null,
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';
export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  action?: { label: string; run: () => void };
  durationMs: number;
}

export type Tab = 'queue' | 'studio';

interface Store {
  state: AppState | null;
  connected: boolean;
  /** serverTime - clientTime (ms), để đồng hồ đếm giây không lệch khi máy khách sai giờ. */
  clockOffset: number;
  refreshState: () => Promise<void>;
  refs: RefImage[];
  refreshRefs: () => Promise<void>;
  prefs: Prefs;
  setPrefs: (patch: Partial<Prefs>) => void;
  toasts: Toast[];
  toast: (kind: ToastKind, text: string, opts?: { action?: Toast['action']; durationMs?: number }) => void;
  dismissToast: (id: number) => void;
  reportError: (e: unknown) => void;
  jobsVersion: number;
  invalidateJobs: () => void;
  tab: Tab;
  setTab: (t: Tab) => void;
  accountsOpen: boolean;
  setAccountsOpen: (open: boolean) => void;
  uploadOpen: boolean;
  setUploadOpen: (open: boolean) => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore phải nằm trong StoreProvider');
  return s;
}

let toastSeq = 1;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(true);
  const [clockOffset, setClockOffset] = useState(0);
  const [refs, setRefs] = useState<RefImage[]>([]);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [jobsVersion, setJobsVersion] = useState(0);
  const [tab, setTab] = useState<Tab>('queue');
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const lastJson = useRef('');

  const refreshState = useCallback(async () => {
    try {
      const next = await api.state();
      setConnected(true);
      setClockOffset(Date.parse(next.serverTime) - Date.now());
      // Không render lại khi dữ liệu không đổi để dải trực tiếp / player không bị giật.
      const json = JSON.stringify({ ...next, serverTime: '' });
      if (json !== lastJson.current) {
        lastJson.current = json;
        setState(next);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) setConnected(false);
    }
  }, []);

  const refreshRefs = useCallback(async () => {
    try {
      setRefs(await api.refs());
    } catch {
      /* lần poll sau sẽ thử lại */
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await refreshState();
      if (!stopped) timer = setTimeout(loop, document.visibilityState === 'visible' ? DEFAULTS.progressRefreshMs : 10_000);
    };
    void loop();
    void refreshRefs();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshState();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshState, refreshRefs]);

  // Số ảnh trong kho đổi (ví dụ thêm từ nơi khác) thì tải lại danh sách.
  const refCount = state?.refCount;
  useEffect(() => {
    if (refCount !== undefined && refCount !== refs.length) void refreshRefs();
  }, [refCount, refs.length, refreshRefs]);

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* chế độ riêng tư có thể chặn localStorage */
      }
      return next;
    });
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback<Store['toast']>(
    (kind, text, opts) => {
      const id = toastSeq++;
      const durationMs = opts?.durationMs ?? (opts?.action ? 8000 : kind === 'error' ? 8000 : 4500);
      setToasts((t) => [...t.slice(-3), { id, kind, text, action: opts?.action, durationMs }]);
      setTimeout(() => dismissToast(id), durationMs);
    },
    [dismissToast],
  );

  const reportError = useCallback(
    (e: unknown) => toast('error', e instanceof ApiError ? e.message : e instanceof Error ? vi.common.unexpected : vi.common.unexpected),
    [toast],
  );

  const invalidateJobs = useCallback(() => {
    setJobsVersion((v) => v + 1);
    void refreshState();
  }, [refreshState]);

  const value = useMemo<Store>(
    () => ({
      state, connected, clockOffset, refreshState, refs, refreshRefs, prefs, setPrefs, toasts, toast, dismissToast, reportError,
      jobsVersion, invalidateJobs, tab, setTab, accountsOpen, setAccountsOpen, uploadOpen, setUploadOpen,
    }),
    [state, connected, clockOffset, refreshState, refs, refreshRefs, prefs, setPrefs, toasts, toast, dismissToast, reportError, jobsVersion, invalidateJobs, tab, accountsOpen, uploadOpen],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
