import { vi } from '../i18n/vi';
import { useStore, type Tab } from '../state/store';
import { Button, cx } from './ui';

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1">
      <span className="text-xs text-muted">{label}</span>
      <span className={cx('text-base leading-none font-bold tabular-nums', tone)}>{value}</span>
    </div>
  );
}

export function Header() {
  const { state, connected, tab, setTab, setAccountsOpen } = useStore();
  const tabs: { id: Tab; label: string }[] = [
    { id: 'queue', label: vi.nav.queue },
    { id: 'studio', label: vi.nav.studio },
  ];
  const online = connected && !!state?.online;

  return (
    <div className="bg-surface">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-accent text-sm font-black text-accent-fg">
            M
          </span>
          <h1 className="text-[15px] font-bold tracking-tight">{vi.app.name}</h1>
        </div>

        <nav aria-label={vi.nav.main} className="flex gap-1 rounded-xl bg-surface-2 p-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
              className={cx('rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors', tab === t.id ? 'bg-surface text-accent-text shadow-sm ring-1 ring-accent/40' : 'text-muted hover:text-fg')}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-2" aria-label={vi.header.connection}>
          <Counter label={vi.header.running} value={state?.counts.running ?? 0} tone="text-info" />
          <Counter label={vi.header.waiting} value={state?.counts.waiting ?? 0} tone="text-fg" />
          <Counter label={vi.header.done} value={state?.counts.completed ?? 0} tone="text-ok" />
          <span className={cx('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold', online ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger')}>
            <span aria-hidden="true">●</span>
            {online ? vi.header.online : vi.header.offline}
          </span>
          <Button size="sm" onClick={() => setAccountsOpen(true)}>
            {vi.header.accounts(state?.accounts.online ?? 0, state?.accounts.total ?? 0)}
          </Button>
        </div>
      </div>

      {!connected && (
        <p role="alert" className="border-t border-danger/30 bg-danger-soft px-4 py-2 text-[13px] text-danger">
          {vi.header.serverDown}
        </p>
      )}
      {state?.simulated && (
        <p className="border-t border-warn/30 bg-warn-soft px-4 py-1.5 text-xs text-warn">
          <strong className="font-semibold">⚠ </strong>
          {vi.header.simulated}
        </p>
      )}
      {state?.dispatcherBlocked && (
        <p role="status" className="border-t border-warn/30 bg-warn-soft px-4 py-2 text-[13px] text-warn">
          {state.dispatcherBlocked === 'no-online-account' ? vi.header.blockedNoAccount : vi.header.blockedCooldown}
        </p>
      )}
    </div>
  );
}
