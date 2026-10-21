import type { Job } from '@muse/shared';
import { ProgressBar } from '../components/ui';
import { vi } from '../i18n/vi';
import { formatClock, useNow } from '../lib/hooks';
import { useStore } from '../state/store';

function LiveItem({ job, now, offset, known }: { job: Job; now: number; offset: number; known: boolean }) {
  const startedAt = job.startedAt ? Date.parse(job.startedAt) : now + offset;
  const elapsed = Math.max(0, Math.floor((now + offset - startedAt) / 1000));
  const thumb = job.refs[0]?.thumbnailUrl;
  return (
    <li className="flex gap-3 rounded-xl border border-line bg-surface p-2.5 shadow-sm">
      {thumb ? (
        <img src={thumb} alt="" className="size-12 shrink-0 rounded-lg bg-surface-2 object-cover" />
      ) : (
        <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-lg bg-info-soft text-lg text-info">
          ▶
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium" title={job.prompt}>
          {job.prompt}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
          <span className="font-mono">{job.id}</span>
          {job.source === 'studio' && <span className="rounded bg-accent-soft px-1 font-semibold text-accent-text">{vi.jobs.sourceStudio}</span>}
          {job.accountLabel && <span>{vi.live.on(job.accountLabel)}</span>}
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <ProgressBar value={known ? job.progress : null} live label={known ? `${job.id} ${job.progress}%` : `${job.id} ${vi.live.generating}`} />
          {known ? <span className="w-9 shrink-0 text-right text-xs font-bold tabular-nums">{vi.common.ofPercent(job.progress)}</span> : <span className="shrink-0 text-[11px] font-semibold text-muted">{vi.live.generating}</span>}
        </div>
        <p className="mt-1 text-[11px] text-muted tabular-nums">
          {vi.live.elapsed}: <span className="font-semibold text-fg">{formatClock(elapsed)}</span>
        </p>
      </div>
    </li>
  );
}

/** Dải ghim phía trên danh sách: hiện mọi job đang chạy cùng lúc, không cuộn ẩn (Mục 6.4). */
export function LiveStrip() {
  const { state, clockOffset } = useStore();
  const running = state?.runningJobs ?? [];
  const now = useNow(1000, running.length > 0);
  if (running.length === 0) return null;
  return (
    <section aria-label={vi.live.title} className="rounded-2xl border border-info/40 bg-info-soft p-3 shadow-md md:sticky md:top-[calc(var(--header-h,0px)+8px)] md:z-10">
      <h3 className="mb-2 flex items-center gap-2 text-[13px] font-bold text-info">
        <span aria-hidden="true" className="inline-block size-2 animate-pulse rounded-full bg-info" />
        {vi.live.title} · {running.length}
      </h3>
      <ul className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
        {running.map((j) => (
          <LiveItem key={j.id} job={j} now={now} offset={clockOffset} known={state?.reportsProgress !== false} />
        ))}
      </ul>
    </section>
  );
}
