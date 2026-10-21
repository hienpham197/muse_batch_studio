import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { JobStatus } from '@muse/shared';
import { vi } from '../i18n/vi';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover disabled:opacity-45',
  secondary: 'bg-surface text-fg border border-line-strong hover:border-fg disabled:opacity-45',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-45',
  danger: 'bg-danger-soft text-danger border border-danger/40 hover:bg-danger hover:text-accent-fg disabled:opacity-45',
};
const SIZE: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-[13px] gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-[15px] gap-2 font-semibold',
};

export function Button({ variant = 'secondary', size = 'md', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx('inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed', VARIANT[variant], SIZE[size], className)}
    />
  );
}

export function Switch({ checked, onChange, label, describedBy }: { checked: boolean; onChange: (v: boolean) => void; label: string; describedBy?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors', checked ? 'border-accent bg-accent' : 'border-line bg-surface-2')}
    >
      <span className={cx('inline-block size-4.5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5.5' : 'translate-x-0.5')} />
    </button>
  );
}

export function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-lg border border-line bg-surface-2 p-1">
      {options.map((o) => (
        <label key={String(o.value)} className={cx('relative cursor-pointer rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent', value === o.value ? 'bg-surface text-accent-text shadow-sm ring-1 ring-accent/50' : 'text-muted hover:text-fg')}>
          <input type="radio" name={name} value={String(o.value)} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
          {o.label}
        </label>
      ))}
    </div>
  );
}

const STATUS_STYLE: Record<JobStatus, { cls: string; icon: string }> = {
  waiting: { cls: 'bg-surface-2 text-muted border-line', icon: '◔' },
  running: { cls: 'bg-info-soft text-info border-info/30', icon: '●' },
  completed: { cls: 'bg-ok-soft text-ok border-ok/30', icon: '✓' },
  failed: { cls: 'bg-danger-soft text-danger border-danger/30', icon: '✕' },
  stopped: { cls: 'bg-warn-soft text-warn border-warn/30', icon: '■' },
};

/** Trạng thái luôn có chữ đi kèm, không chỉ phân biệt bằng màu (Mục 9.4). */
export function StatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap', s.cls, className)}>
      <span aria-hidden="true" className={status === 'running' ? 'animate-pulse' : ''}>
        {s.icon}
      </span>
      {vi.jobs.status[status]}
    </span>
  );
}

/** `value = null`: nền tảng không báo phần trăm thật, hiện thanh chạy không xác định thay vì số bịa. */
export function ProgressBar({ value, live = false, label }: { value: number | null; live?: boolean; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
      <div className={cx('h-full rounded-full bg-accent transition-[width] duration-700 ease-out', live && 'progress-live', value === null && 'animate-pulse')} style={{ width: value === null ? '100%' : `${Math.max(2, value)}%` }} />
    </div>
  );
}

export function Dialog({ open, onClose, title, children, wide = false, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx('m-auto max-h-[90vh] w-[calc(100%-2rem)] rounded-2xl border border-line bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/55', wide ? 'max-w-4xl' : 'max-w-md')}
    >
      {open && (
        <div className="flex max-h-[90vh] flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label={vi.common.close}>
              ✕
            </Button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel, danger = true }: { open: boolean; title: string; body: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void; danger?: boolean }) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button onClick={onCancel}>{vi.common.cancel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-muted">{body}</div>
    </Dialog>
  );
}
