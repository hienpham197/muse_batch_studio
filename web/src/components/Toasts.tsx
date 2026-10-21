import { useStore, type ToastKind } from '../state/store';
import { vi } from '../i18n/vi';
import { cx } from './ui';

const KIND: Record<ToastKind, { cls: string; icon: string }> = {
  info: { cls: 'border-info/40', icon: 'ℹ' },
  ok: { cls: 'border-ok/50', icon: '✓' },
  warn: { cls: 'border-warn/50', icon: '!' },
  error: { cls: 'border-danger/50', icon: '✕' },
};
const ICON_CLS: Record<ToastKind, string> = { info: 'text-info', ok: 'text-ok', warn: 'text-warn', error: 'text-danger' };

export function Toasts() {
  const { toasts, dismissToast } = useStore();
  return (
    <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast-in pointer-events-auto flex max-w-xl items-start gap-3 rounded-xl border bg-surface px-4 py-3 text-sm shadow-xl', KIND[t.kind].cls)}>
          <span aria-hidden="true" className={cx('mt-px font-bold', ICON_CLS[t.kind])}>
            {KIND[t.kind].icon}
          </span>
          <p className="min-w-0 flex-1 leading-snug">{t.text}</p>
          {t.action && (
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-0.5 font-semibold text-accent-text underline underline-offset-2 hover:bg-accent-soft"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" aria-label={vi.common.close} className="shrink-0 text-muted hover:text-fg" onClick={() => dismissToast(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
