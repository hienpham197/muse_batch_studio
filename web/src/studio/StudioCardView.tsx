import { memo, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { STUDIO_CARD, type StudioCard } from '@muse/shared';
import { downloadUrl } from '../api/client';
import { MentionTextarea } from '../components/MentionTextarea';
import { Button, ProgressBar, cx } from '../components/ui';
import { vi } from '../i18n/vi';

interface Props {
  card: StudioCard;
  progressKnown: boolean;
  simulated: boolean;
  index: number;
  x: number;
  y: number;
  zoom: number;
  localError?: string;
  onMove: (id: string, x: number, y: number, commit: boolean) => void;
  onPrompt: (id: string, prompt: string) => void;
  onRemove: (id: string) => void;
  onGenerate: (id: string) => void;
}

const STATUS_STYLE = {
  idle: 'bg-surface-2 text-muted border-line',
  running: 'bg-info-soft text-info border-info/30',
  done: 'bg-ok-soft text-ok border-ok/30',
  error: 'bg-danger-soft text-danger border-danger/30',
} as const;

export const StudioCardView = memo(function StudioCardView({ card, progressKnown, simulated, index, x, y, zoom, localError, onMove, onPrompt, onRemove, onGenerate }: Props) {
  const [prompt, setPrompt] = useState(card.prompt);
  const focused = useRef(false);
  const dirty = useRef(false);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  // Nhận prompt từ server chỉ khi người dùng không đang sửa, để tránh ghi đè chữ đang gõ.
  useEffect(() => {
    if (!focused.current && !dirty.current) setPrompt(card.prompt);
  }, [card.prompt]);

  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => {
      dirty.current = false;
      onPrompt(card.id, prompt);
    }, 600);
    return () => clearTimeout(t);
  }, [prompt, card.id, onPrompt]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ox: x, oy: y };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    onMove(card.id, Math.max(0, d.ox + (e.clientX - d.px) / zoom), Math.max(0, d.oy + (e.clientY - d.py) / zoom), false);
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    onMove(card.id, Math.max(0, d.ox + (e.clientX - d.px) / zoom), Math.max(0, d.oy + (e.clientY - d.py) / zoom), true);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 50 : 10;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    onMove(card.id, Math.max(0, x + d[0]), Math.max(0, y + d[1]), true);
  };

  const running = card.status === 'running';
  const error = card.status === 'error' ? card.error?.message : localError;
  const canGenerate = card.status === 'idle' || card.status === 'error';

  return (
    <article
      aria-label={vi.studio.card(index + 1)}
      style={{ left: x, top: y, width: STUDIO_CARD.width, height: STUDIO_CARD.height }}
      className={cx('absolute flex flex-col overflow-visible rounded-2xl border bg-surface shadow-lg', drag.current ? 'z-20 cursor-grabbing shadow-2xl' : 'z-10', card.status === 'error' || localError ? 'border-danger/60' : 'border-line')}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`${vi.studio.card(index + 1)}. ${vi.studio.drag}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKey}
        className="flex cursor-grab touch-none items-center gap-2 rounded-t-2xl border-b border-line bg-surface-2 px-3 py-2 select-none active:cursor-grabbing"
      >
        <span aria-hidden="true" className="text-muted">
          ⠿
        </span>
        <span className="text-[13px] font-semibold">{vi.studio.card(index + 1)}</span>
        <span className={cx('ml-1 rounded-full border px-2 py-px text-[11px] font-semibold', STATUS_STYLE[card.status])}>{vi.studio.status[card.status]}</span>
        <button type="button" aria-label={`${vi.studio.close} ${index + 1}`} title={vi.studio.close} onClick={() => onRemove(card.id)} className="ml-auto grid size-6 place-items-center rounded-md text-muted hover:bg-danger-soft hover:text-danger">
          ✕
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-black/90">
        {card.status === 'done' && card.videoUrl ? (
          <>
            <video src={card.videoUrl} poster={card.thumbnailUrl ?? undefined} controls playsInline preload="metadata" className="size-full object-contain" />
            <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5">
              <span className="rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-semibold text-white">{vi.studio.result}</span>
              {card.quality && <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold text-accent-fg">{card.quality}</span>}
              {simulated && <span className="rounded-md bg-warn px-1.5 py-0.5 text-[11px] font-bold text-black">{vi.header.simulatedBadge}</span>}
            </div>
            {card.jobId && (
              <a
                href={downloadUrl(card.jobId)}
                download
                aria-label={vi.studio.download}
                title={vi.studio.download}
                className="absolute top-2 right-2 grid size-8 place-items-center rounded-md bg-black/65 text-white hover:bg-black/85"
              >
                ⭳
              </a>
            )}
          </>
        ) : (
          <img src={card.inputImageUrl} alt="" loading="lazy" decoding="async" draggable={false} className={cx('size-full object-contain', running && 'opacity-60')} />
        )}
        {running && (
          <div className="absolute inset-x-0 bottom-0 bg-black/70 px-3 py-2 text-white">
            <div className="mb-1 flex justify-between text-[11px] font-semibold">
              <span>{card.jobStatus === 'waiting' ? vi.studio.queued : vi.studio.status.running}</span>
              {progressKnown && <span className="tabular-nums">{vi.common.ofPercent(card.progress)}</span>}
            </div>
            <ProgressBar value={progressKnown ? card.progress : null} live label={`${vi.studio.card(index + 1)} ${progressKnown ? `${card.progress}%` : vi.live.generating}`} />
          </div>
        )}
      </div>

      <div className="space-y-2 p-2.5">
        <MentionTextarea
          value={prompt}
          onChange={(v) => {
            dirty.current = true;
            setPrompt(v);
          }}
          onBlur={() => {
            focused.current = false;
          }}
          textareaRef={(el) => {
            if (el) el.onfocus = () => (focused.current = true);
          }}
          label={vi.studio.promptLabel}
          placeholder={vi.studio.promptPlaceholder}
          rows={3}
          className="resize-none text-[13px]"
        />
        <div className="flex items-center gap-2">
          <p role={error ? 'alert' : undefined} className={cx('min-w-0 flex-1 text-xs', error ? 'text-danger' : 'text-muted')}>
            {error ? <span className="line-clamp-2">{error}</span> : null}
          </p>
          {canGenerate && (
            <Button size="sm" variant="primary" onClick={() => onGenerate(card.id)}>
              {card.status === 'error' ? vi.studio.regenerate : vi.studio.generate}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
});
