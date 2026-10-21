import { useCallback, useEffect, useId, useState } from 'react';
import { DEFAULTS, JOB_STATUSES, LIMITS, type JobListResult, type JobStatus } from '@muse/shared';
import { api, type JobQuery } from '../api/client';
import { Button, ConfirmDialog, cx } from '../components/ui';
import { vi } from '../i18n/vi';
import { useDebounced, useStableList } from '../lib/hooks';
import { useStore } from '../state/store';
import { JobRow } from './JobRow';

type TabKey = JobStatus | 'all';
const TABS: TabKey[] = ['all', ...JOB_STATUSES];

export function JobList() {
  const { jobsVersion, invalidateJobs, toast, reportError, state } = useStore();
  const [status, setStatus] = useState<TabKey>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULTS.pageSize);
  const [data, setData] = useState<JobListResult | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const debouncedSearch = useDebounced(search, 250);
  const panelId = useId();

  // Làm mới mỗi 2 giây; dữ liệu cũ vẫn hiển thị trong lúc tải để không nhấp nháy.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const q: JobQuery = { status, search: debouncedSearch, page, pageSize };
    const tick = async () => {
      try {
        const res = await api.jobs(q);
        if (stopped) return;
        setData(res);
        if (res.page > res.totalPages) setPage(res.totalPages);
      } catch {
        /* mất kết nối được báo ở header */
      }
      if (!stopped) timer = setTimeout(tick, DEFAULTS.progressRefreshMs);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [status, debouncedSearch, page, pageSize, jobsVersion]);

  const items = useStableList(data?.items);

  const onRetry = useCallback(
    async (id: string) => {
      try {
        await api.retryJob(id);
        toast('ok', vi.jobs.retried);
        invalidateJobs();
      } catch (e) {
        reportError(e);
      }
    },
    [invalidateJobs, reportError, toast],
  );
  const onRegenerate = useCallback(
    async (id: string) => {
      try {
        const r = await api.regenerateJob(id);
        toast('ok', vi.jobs.regenerated(r.taskIds[0] ?? ''));
        invalidateJobs();
      } catch (e) {
        reportError(e);
      }
    },
    [invalidateJobs, reportError, toast],
  );
  const onDelete = useCallback((id: string) => setRemoveId(id), []);

  const confirmRemove = async () => {
    const id = removeId;
    setRemoveId(null);
    if (!id) return;
    try {
      await api.deleteJob(id);
      toast('info', vi.jobs.removed);
      invalidateJobs();
    } catch (e) {
      reportError(e);
    }
  };

  const doClear = async () => {
    setConfirmClear(false);
    try {
      const r = await api.clearFinished();
      toast('ok', vi.jobs.cleared(r.cleared));
      invalidateJobs();
    } catch (e) {
      reportError(e);
    }
  };

  const counts = data?.counts;
  const countOf = (t: TabKey) => (t === 'all' ? counts?.total : counts?.[t]) ?? 0;
  const totalPages = data?.totalPages ?? 1;

  return (
    <section aria-labelledby="jobs-title" className="rounded-2xl border border-line bg-surface-2/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="jobs-title" className="mr-auto text-base font-bold">
          {vi.jobs.title}
        </h2>
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder={vi.jobs.searchPlaceholder}
          aria-label={vi.jobs.search}
          className="h-9 w-full rounded-lg border border-line bg-surface px-3 sm:w-64"
        />
        <Button onClick={() => (countOf('completed') > 0 ? setConfirmClear(true) : toast('info', vi.jobs.clearNone))}>{vi.jobs.clear}</Button>
      </div>

      <div role="tablist" aria-label={vi.jobs.title} className="mt-3 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`${panelId}-tab-${t}`}
            aria-selected={status === t}
            aria-controls={panelId}
            onClick={() => {
              setStatus(t);
              setPage(1);
            }}
            className={cx('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-semibold transition-colors', status === t ? 'border-accent bg-accent-soft text-accent-text' : 'border-line bg-surface text-muted hover:text-fg')}
          >
            {t === 'all' ? vi.jobs.tabs.all : vi.jobs.tabs[t]}
            <span className={cx('rounded-full px-1.5 text-[11px] tabular-nums', status === t ? 'bg-accent text-accent-fg' : 'bg-surface-2')}>{countOf(t)}</span>
          </button>
        ))}
      </div>

      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-tab-${status}`} className="mt-3">
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-muted">{counts?.total ? vi.jobs.emptyFiltered : vi.jobs.empty}</p>
        ) : (
          <ul className="space-y-2">
            {items.map((job) => (
              <JobRow key={job.id} job={job} onRetry={onRetry} onRegenerate={onRegenerate} onDelete={onDelete} progressKnown={state?.reportsProgress !== false} simulated={state?.simulated === true} />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <span className="text-muted">{vi.jobs.total(counts?.total ?? 0)}</span>
        <label className="flex items-center gap-2">
          <span className="sr-only">{vi.jobs.pageSize}</span>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            className="h-8 rounded-lg border border-line bg-surface px-2"
          >
            {LIMITS.pageSizes.map((n) => (
              <option key={n} value={n}>
                {vi.jobs.perPage(n)}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            ‹ {vi.jobs.prev}
          </Button>
          <span aria-live="polite" className="min-w-20 text-center font-semibold tabular-nums">
            {vi.jobs.page(Math.min(page, totalPages), totalPages)}
          </span>
          <Button size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            {vi.jobs.next} ›
          </Button>
        </div>
      </div>

      <ConfirmDialog open={confirmClear} title={vi.jobs.clearTitle} body={vi.jobs.clearBody} confirmLabel={vi.jobs.clear} danger={false} onConfirm={doClear} onCancel={() => setConfirmClear(false)} />
      <ConfirmDialog open={removeId !== null} title={vi.jobs.removeTitle} body={vi.jobs.removeBody} confirmLabel={vi.jobs.removeConfirm} onConfirm={confirmRemove} onCancel={() => setRemoveId(null)} />
    </section>
  );
}
