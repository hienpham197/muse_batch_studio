import { memo, useState, type MouseEvent } from 'react';
import type { Job } from '@muse/shared';
import { downloadUrl } from '../api/client';
import { Button, ProgressBar, StatusBadge, cx } from '../components/ui';
import { vi } from '../i18n/vi';
import { formatTime } from '../lib/hooks';

interface Props {
  job: Job;
  onRetry: (id: string) => void;
  onRegenerate: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
  /** Nền tảng có báo phần trăm thật không. */
  progressKnown: boolean;
  /** Video do adapter mô phỏng tạo, không phải kết quả AI thật. */
  simulated: boolean;
}

export const JobRow = memo(function JobRow({ job, onRetry, onRegenerate, onDelete, progressKnown, simulated }: Props) {
  const [open, setOpen] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const done = job.status === 'completed';
  const detailId = `detail-${job.id}`;
  const firstRef = job.refs[0]?.thumbnailUrl;

  const toggle = () => setOpen((o) => !o);
  // Bấm vào vùng trống của dòng cũng mở rộng; phím bàn phím dùng nút prompt.
  const onRowClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, video, summary')) return;
    toggle();
  };

  return (
    <li className="rounded-xl border border-line bg-surface shadow-sm">
      <div onClick={onRowClick} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-2.5 sm:flex-nowrap">
        <button
          type="button"
          disabled={!done}
          aria-label={done ? vi.jobs.play : undefined}
          aria-pressed={done ? playing : undefined}
          aria-hidden={done ? undefined : true}
          tabIndex={done ? 0 : -1}
          onClick={() => setPlaying((p) => !p)}
          className={cx('group relative size-14 shrink-0 overflow-hidden rounded-lg bg-surface-2', done && 'ring-1 ring-line hover:ring-2 hover:ring-accent')}
        >
          {done && job.thumbnailUrl ? (
            <img src={job.thumbnailUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
          ) : firstRef ? (
            <img src={firstRef} alt="" loading="lazy" decoding="async" className="size-full object-cover opacity-50" />
          ) : (
            <span aria-hidden="true" className="grid size-full place-items-center text-muted">
              ▶
            </span>
          )}
          {done && (
            <span aria-hidden="true" className="absolute inset-0 grid place-items-center bg-black/25 text-xl text-white opacity-90 transition-opacity group-hover:bg-black/40">
              {playing ? '❙❙' : '▶'}
            </span>
          )}
        </button>

        <div className="min-w-0 flex-1 basis-40">
          <button type="button" onClick={toggle} aria-expanded={open} aria-controls={detailId} className="block w-full min-w-0 text-left" title={vi.jobs.expand}>
            <span className="block truncate text-sm font-medium">{job.prompt.replace(/\s+/g, ' ')}</span>
          </button>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted">
            <span className="font-mono">{job.id}</span>
            <span>
              {vi.batch.seconds(job.duration)} · {job.ratio}
            </span>
            {job.regenOf && <span className="rounded bg-accent-soft px-1 font-semibold text-accent-text">{vi.jobs.regenOf(job.regenOf)}</span>}
            {job.refTags.length > 0 && <span>{job.refTags.map((t) => `@${t}`).join(' ')}</span>}
          </p>
        </div>

        <div className="flex w-36 shrink-0 flex-col items-start gap-1">
          <StatusBadge status={job.status} />
          {job.status === 'running' && (
            <div className="flex w-full items-center gap-1.5">
              <ProgressBar value={progressKnown ? job.progress : null} live label={progressKnown ? `${job.id} ${job.progress}%` : `${job.id} ${vi.live.generating}`} />
              {progressKnown && <span className="w-8 shrink-0 text-right text-[11px] font-bold tabular-nums">{vi.common.ofPercent(job.progress)}</span>}
            </div>
          )}
          {job.status === 'waiting' && (job.timedOut || job.attempts > 0) && (
            <span className="text-[11px] text-warn">{job.timedOut ? vi.jobs.timedOut : vi.jobs.retrying(job.attempts)}</span>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {done ? (
            <a
              href={downloadUrl(job.id)}
              download
              className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[13px] font-medium whitespace-nowrap text-accent-fg hover:bg-accent-hover"
            >
              {vi.jobs.download}
            </a>
          ) : (
            <Button size="sm" variant="primary" disabled title={vi.jobs.downloadHint}>
              {vi.jobs.download}
            </Button>
          )}
          {done && (
            <Button
              size="sm"
              disabled={job.regenerating || regenBusy}
              title={job.regenerating ? vi.jobs.regeneratingHint : vi.jobs.regenerateHint}
              onClick={async () => {
                setRegenBusy(true);
                try {
                  await onRegenerate(job.id);
                } finally {
                  setRegenBusy(false);
                }
              }}
            >
              {job.regenerating ? vi.jobs.regenerating : vi.jobs.regenerate}
            </Button>
          )}
          {(job.status === 'failed' || job.status === 'stopped') && (
            <Button size="sm" disabled={job.regenerating} title={job.regenerating ? vi.jobs.regeneratingHint : undefined} onClick={() => onRetry(job.id)}>
              {vi.jobs.retry}
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-label={`${vi.jobs.remove} ${job.id}`} title={vi.jobs.remove} onClick={() => onDelete(job.id)}>
            ✕
          </Button>
        </div>
      </div>

      {done && playing && job.videoUrl && (
        <div className="border-t border-line p-3">
          {simulated && <p className="mb-2 rounded-md bg-warn-soft px-2 py-1 text-center text-xs font-semibold text-warn">{vi.header.simulatedClip}</p>}
          <video src={job.videoUrl} poster={job.thumbnailUrl ?? undefined} controls autoPlay playsInline preload="metadata" className="mx-auto max-h-[460px] max-w-full rounded-lg bg-black" />
          <div className="mt-2 text-center">
            <Button size="sm" onClick={() => setPlaying(false)}>
              {vi.jobs.minimize}
            </Button>
          </div>
        </div>
      )}

      {open && (
        <div id={detailId} className="space-y-3 border-t border-line px-3.5 py-3 text-[13px]">
          <div>
            <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{vi.jobs.detail.fullPrompt}</h4>
            <p className="rounded-lg bg-surface-2 px-3 py-2 break-words whitespace-pre-wrap select-text">{job.prompt}</p>
          </div>

          <div>
            <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{vi.jobs.detail.refs}</h4>
            {job.refs.length === 0 ? (
              <p className="text-muted">{vi.jobs.detail.noRefs}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {job.refs.map((r, i) => (
                  <li key={`${r.fileId}-${i}`} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 py-1 pr-2.5 pl-1">
                    <img src={r.thumbnailUrl} alt="" loading="lazy" className="size-9 rounded-md object-cover" />
                    <span className="font-medium">{r.tag ? `@${r.tag}` : vi.jobs.detail.inputImage}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {job.error && (
            <div className={cx('rounded-lg border px-3 py-2', job.status === 'failed' ? 'border-danger/40 bg-danger-soft text-danger' : 'border-warn/40 bg-warn-soft text-warn')}>
              <h4 className="text-xs font-semibold tracking-wide uppercase">{job.status === 'failed' ? vi.jobs.detail.error : vi.jobs.detail.lastError}</h4>
              <p className="mt-0.5">{job.error.message}</p>
              {(job.error.originalCode ?? job.error.code) && (
                <p className="mt-0.5 font-mono text-xs opacity-90">
                  {vi.jobs.detail.originalCode}: {job.error.originalCode ?? job.error.code}
                </p>
              )}
            </div>
          )}

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
            <dt className="text-muted">{vi.jobs.detail.account}</dt>
            <dd className="font-mono">{job.accountLabel ?? '—'}</dd>
            <dt className="text-muted">{vi.jobs.detail.attempts}</dt>
            <dd>{job.attempts}</dd>
            <dt className="text-muted">{vi.jobs.detail.created}</dt>
            <dd>{formatTime(job.createdAt)}</dd>
            <dt className="text-muted">{vi.jobs.detail.started}</dt>
            <dd>{formatTime(job.startedAt)}</dd>
            <dt className="text-muted">{vi.jobs.detail.finished}</dt>
            <dd>{formatTime(job.finishedAt)}</dd>
          </dl>
        </div>
      )}
    </li>
  );
});
