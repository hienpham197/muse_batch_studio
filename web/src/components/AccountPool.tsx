import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { COOKIE_LIMITS, LIMITS, parseCookies, type Account, type AuthMethod, type Settings } from '@muse/shared';
import { api } from '../api/client';
import { vi } from '../i18n/vi';
import { useNow } from '../lib/hooks';
import { useStore } from '../state/store';
import { Button, ConfirmDialog, Dialog, Segmented, Switch, cx } from './ui';

export function AccountPool() {
  const { accountsOpen, setAccountsOpen, toast, reportError, refreshState, clockOffset, state } = useStore();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  const [method, setMethod] = useState<AuthMethod>('password');
  const [cookie, setCookie] = useState('');
  const [cookieLabel, setCookieLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const idRef = useRef<HTMLInputElement>(null);
  const now = useNow(1000, accountsOpen);
  const [cfg, setCfg] = useState<{ maxRetries: string; timeoutMinutes: string; slotsPerAccount: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await api.accounts());
    } catch {
      /* lần poll sau sẽ thử lại */
    }
  }, []);

  useEffect(() => {
    if (!accountsOpen) return;
    api
      .settings()
      .then((st) => setCfg({ maxRetries: String(st.maxRetries), timeoutMinutes: String(st.timeoutMinutes), slotsPerAccount: String(st.slotsPerAccount) }))
      .catch(() => undefined);
  }, [accountsOpen]);

  useEffect(() => {
    if (!accountsOpen) return;
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [accountsOpen, load]);

  // Chỉ lấy số lượng cookie để báo cho người dùng; không hiển thị giá trị.
  const cookieCount = useMemo(() => {
    if (!cookie.trim()) return null;
    const r = parseCookies(cookie);
    return r.ok ? r.cookies.length : 0;
  }, [cookie]);

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (adding) return;
    const input =
      method === 'cookie' ? ({ method: 'cookie', cookie, label: cookieLabel } as const) : ({ method: 'password', identifier, secret } as const);
    // Xóa khỏi bộ nhớ giao diện ngay khi gửi để credential không nằm lại trên màn hình.
    setIdentifier('');
    setSecret('');
    setCookie('');
    setAdding(true);
    try {
      const acc = await api.addAccount(input);
      toast(acc.online ? 'ok' : 'warn', acc.online ? vi.accounts.added(acc.maskedId) : vi.accounts.addedOffline(acc.maskedId));
      await load();
      void refreshState();
      idRef.current?.focus();
    } catch (err) {
      reportError(err);
    } finally {
      setAdding(false);
    }
  };

  const toggle = async (a: Account, enabled: boolean) => {
    setAccounts((list) => list.map((x) => (x.id === a.id ? { ...x, enabled } : x)));
    try {
      await api.setAccountEnabled(a.id, enabled);
      void refreshState();
    } catch (err) {
      reportError(err);
    }
    void load();
  };

  const check = async (a: Account) => {
    setChecking(a.id);
    try {
      const res = await api.checkAccount(a.id);
      toast(res.online ? 'ok' : 'warn', vi.accounts.checked(res.maskedId, res.online));
      void refreshState();
    } catch (err) {
      reportError(err);
    } finally {
      setChecking(null);
      void load();
    }
  };

  const saveSlots = async (a: Account, value: string) => {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n < 1 || n > LIMITS.maxSlotsPerAccount || n === a.slots) return;
    try {
      await api.setAccountSlots(a.id, n);
      toast('ok', vi.accounts.slotsSaved);
      void refreshState();
    } catch (err) {
      reportError(err);
    }
    void load();
  };

  const saveCfg = async () => {
    if (!cfg) return;
    const patch: Partial<Settings> = { maxRetries: Number(cfg.maxRetries), timeoutMinutes: Number(cfg.timeoutMinutes), slotsPerAccount: Number(cfg.slotsPerAccount) };
    try {
      await api.updateSettings(patch);
      toast('ok', vi.accounts.settingsSaved);
      void refreshState();
    } catch (err) {
      reportError(err);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    const target = removing;
    setRemoving(null);
    try {
      await api.removeAccount(target.id);
      toast('ok', vi.accounts.removed);
      void refreshState();
    } catch (err) {
      reportError(err);
    }
    void load();
  };

  const canAdd = !adding && (method === 'cookie' ? (cookieCount ?? 0) > 0 : identifier.trim().length >= 3 && secret.length >= 4);

  return (
    <>
      <Dialog open={accountsOpen} onClose={() => setAccountsOpen(false)} wide title={vi.accounts.title} footer={<Button onClick={() => setAccountsOpen(false)}>{vi.accounts.close}</Button>}>
        <p className="text-sm text-muted">{vi.accounts.intro}</p>

        <form onSubmit={onAdd} autoComplete="off" className="mt-4 rounded-xl border border-line bg-surface-2 p-3">
          <div className="mb-3">
            <span className="mb-1 block text-[13px] font-medium">{vi.accounts.method}</span>
            <Segmented
              label={vi.accounts.method}
              value={method}
              onChange={setMethod}
              options={[
                { value: 'password', label: vi.accounts.methodPassword },
                { value: 'cookie', label: vi.accounts.methodCookie },
              ]}
            />
          </div>
          {method === 'password' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-[13px] font-medium">
                {vi.accounts.identifier}
                <input
                  ref={idRef}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  maxLength={200}
                  className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 font-normal"
                />
              </label>
              <label className="block text-[13px] font-medium">
                {vi.accounts.secret}
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="new-password"
                  maxLength={4096}
                  className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 font-normal"
                />
              </label>
            </div>
          ) : (
            <div className="grid gap-3">
              <label className="block text-[13px] font-medium sm:max-w-xs">
                {vi.accounts.cookieLabel}
                <input
                  value={cookieLabel}
                  onChange={(e) => setCookieLabel(e.target.value)}
                  placeholder={vi.accounts.cookieLabelPlaceholder}
                  autoComplete="off"
                  maxLength={40}
                  className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 font-normal"
                />
              </label>
              <label className="block text-[13px] font-medium">
                {vi.accounts.cookie}
                <input
                  type="password"
                  value={cookie}
                  onChange={(e) => setCookie(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={COOKIE_LIMITS.maxBytes}
                  aria-describedby="cookie-help"
                  aria-invalid={cookieCount === 0}
                  className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 font-normal"
                />
              </label>
              <p id="cookie-help" className="text-xs text-muted">
                {vi.accounts.cookieHelp}
              </p>
              {cookieCount !== null && (
                <p role="status" className={cx('text-xs font-semibold', cookieCount > 0 ? 'text-ok' : 'text-danger')}>
                  {cookieCount > 0 ? vi.accounts.cookieDetected(cookieCount) : vi.accounts.cookieBad}
                </p>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={!canAdd}>
              {adding ? vi.accounts.adding : vi.accounts.add}
            </Button>
            <p className="min-w-0 flex-1 text-xs text-muted">🔒 {vi.accounts.security}</p>
          </div>
        </form>

        {accounts.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">{vi.accounts.empty}</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {accounts.map((a) => {
              const ageSec = a.lastHealthAt ? Math.max(0, Math.round((now + clockOffset - Date.parse(a.lastHealthAt)) / 1000)) : null;
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface p-3">
                  <div className="min-w-40 flex-1">
                    <p className="flex items-center gap-2 font-mono text-sm font-semibold">
                      {a.maskedId}
                      {a.authMethod === 'cookie' && <span className="rounded bg-accent-soft px-1.5 py-px font-sans text-[11px] font-semibold text-accent-text">{vi.accounts.cookieBadge}</span>}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {vi.accounts.cols.health}: {ageSec === null ? vi.accounts.never : vi.common.secondsAgo(ageSec)}
                    </p>
                  </div>
                  <div className="min-w-36">
                    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold', a.online ? 'border-ok/30 bg-ok-soft text-ok' : 'border-danger/30 bg-danger-soft text-danger')}>
                      <span aria-hidden="true">{a.online ? '●' : '○'}</span>
                      {a.online ? vi.accounts.online : vi.accounts.offline}
                    </span>
                    {!a.online && a.sessionReason && <p className="mt-1 max-w-72 text-xs text-muted">{a.sessionReason}</p>}
                  </div>
                  <div className="flex items-center gap-1.5 text-[13px] text-muted">
                    <span>
                      {vi.accounts.cols.jobs}: <span className="font-semibold text-fg">{a.runningJobs}</span>/
                    </span>
                    <input
                      key={`${a.id}-${a.slots}`}
                      type="number"
                      min={1}
                      max={LIMITS.maxSlotsPerAccount}
                      defaultValue={a.slots}
                      aria-label={vi.accounts.slotsLabel(a.maskedId)}
                      onBlur={(e) => void saveSlots(a, e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                      className="h-8 w-14 rounded-md border border-line bg-surface px-2 text-fg tabular-nums"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={a.enabled} onChange={(v) => toggle(a, v)} label={vi.accounts.toggle(a.maskedId)} />
                    <span className="w-14 text-xs text-muted">{a.enabled ? vi.accounts.enabled : vi.accounts.disabled}</span>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => check(a)} disabled={checking === a.id}>
                      {checking === a.id ? vi.accounts.checking : vi.accounts.check}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setRemoving(a)}>
                      {vi.accounts.remove}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {cfg && (
          <section aria-labelledby="run-settings" className="mt-5 rounded-xl border border-line bg-surface-2 p-3">
            <h3 id="run-settings" className="text-sm font-semibold">
              {vi.accounts.settingsTitle}
            </h3>
            <p className="text-xs text-muted">{vi.accounts.settingsIntro}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {(
                [
                  ['maxRetries', vi.accounts.retries, vi.accounts.retriesHint, 0, LIMITS.maxRetries],
                  ['timeoutMinutes', vi.accounts.timeout, vi.accounts.timeoutHint, 1, LIMITS.maxTimeoutMinutes],
                  ['slotsPerAccount', vi.accounts.defaultSlots, '', 1, LIMITS.maxSlotsPerAccount],
                ] as const
              ).map(([key, label, hint, min, max]) => (
                <label key={key} className="block text-[13px] font-medium">
                  {label}
                  <input
                    type="number"
                    min={min}
                    max={max}
                    value={cfg[key]}
                    onChange={(e) => setCfg({ ...cfg, [key]: e.target.value })}
                    className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 font-normal tabular-nums"
                  />
                  {hint && <span className="mt-1 block text-xs font-normal text-muted">{hint}</span>}
                </label>
              ))}
            </div>
            <Button className="mt-3" onClick={saveCfg}>
              {vi.accounts.saveSettings}
            </Button>
          </section>
        )}
        {state?.simulated && <p className="mt-4 text-xs text-warn">{vi.header.simulated}</p>}
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        title={removing ? vi.accounts.removeTitle(removing.maskedId) : ''}
        body={vi.accounts.removeBody}
        confirmLabel={vi.accounts.removeConfirm}
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
