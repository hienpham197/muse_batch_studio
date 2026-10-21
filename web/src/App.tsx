import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, setUnauthenticatedHandler } from './api/client';
import { AccountPool } from './components/AccountPool';
import { Header } from './components/Header';
import { RefLibrary } from './components/RefLibrary';
import { Toasts } from './components/Toasts';
import { Button } from './components/ui';
import { BatchPanel } from './batch/BatchPanel';
import { JobList } from './batch/JobList';
import { LiveStrip } from './batch/LiveStrip';
import { StudioTab } from './studio/StudioTab';
import { vi } from './i18n/vi';
import { StoreProvider, useStore } from './state/store';

function LoginView({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(token);
      setToken('');
      onDone();
    } catch (err) {
      setToken('');
      setError(err instanceof ApiError ? err.message : vi.common.unexpected);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-xl">
        <h1 className="text-lg font-bold">{vi.auth.title}</h1>
        <p className="text-sm text-muted">{vi.auth.intro}</p>
        <label className="block text-[13px] font-semibold">
          {vi.auth.token}
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" autoFocus className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-3 font-normal" />
        </label>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={!token || busy}>
          {vi.auth.submit}
        </Button>
      </form>
    </main>
  );
}

function Shell() {
  const { tab } = useStore();
  const headRef = useRef<HTMLDivElement>(null);

  // Chiều cao header thay đổi theo banner; dải trực tiếp dùng biến này để ghim ngay bên dưới.
  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const apply = () => document.documentElement.style.setProperty('--header-h', `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <>
      <div ref={headRef} className="border-b border-line md:sticky md:top-0 md:z-20">
        <Header />
        <RefLibrary />
      </div>

      <main>
        <div hidden={tab !== 'queue'} className="grid gap-4 p-3 sm:p-4 lg:grid-cols-[minmax(340px,420px)_minmax(0,1fr)] lg:items-start">
          <BatchPanel />
          <div className="min-w-0 space-y-4">
            <LiveStrip />
            <JobList />
          </div>
        </div>
        <StudioTab active={tab === 'studio'} />
      </main>

      <AccountPool />
      <Toasts />
    </>
  );
}

export function App() {
  const [auth, setAuth] = useState<'checking' | 'login' | 'ok'>('checking');

  useEffect(() => {
    setUnauthenticatedHandler(() => setAuth('login'));
    api
      .authStatus()
      .then((s) => setAuth(s.required && !s.authenticated ? 'login' : 'ok'))
      .catch(() => setAuth('ok')); // server chưa lên: giao diện chính tự báo mất kết nối
    return () => setUnauthenticatedHandler(null);
  }, []);

  if (auth === 'checking') {
    return (
      <p role="status" className="p-6 text-muted">
        {vi.app.loading}
      </p>
    );
  }
  if (auth === 'login') return <LoginView onDone={() => setAuth('ok')} />;
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
