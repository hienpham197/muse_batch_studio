import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { DEFAULTS, DURATIONS, RATIOS, SPLIT_MODES, extractMentions, replaceMention, splitPrompts, type RefImage, type SplitMode } from '@muse/shared';
import { api, ApiError } from '../api/client';
import { MentionTextarea } from '../components/MentionTextarea';
import { RefPicker } from './RefPicker';
import { Button, Segmented, Switch, cx } from '../components/ui';
import { vi } from '../i18n/vi';
import { useDebounced } from '../lib/hooks';
import { useStore } from '../state/store';

export function BatchPanel() {
  const { state, refs, prefs, setPrefs, toast, reportError, invalidateJobs, refreshState } = useStore();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [threads, setThreads] = useState<string>(String(DEFAULTS.concurrency));
  const [threadsDirty, setThreadsDirty] = useState(false);
  const armed = useRef(false);
  const [picking, setPicking] = useState<string | null>(null);

  // Badge đếm trực tiếp với độ trễ ~200 ms; đổi chế độ tách thì đếm lại ngay (mode không qua debounce).
  const debounced = useDebounced(text, DEFAULTS.countDebounceMs);
  const count = useMemo(() => splitPrompts(debounced, prefs.splitMode).length, [debounced, prefs.splitMode]);

  const known = useMemo(() => new Set(refs.map((r) => r.tag)), [refs]);
  const mentions = useMemo(() => extractMentions(debounced), [debounced]);
  const missing = useMemo(() => mentions.filter((t) => !known.has(t)), [mentions, known]);
  const refByTag = useMemo(() => new Map(refs.map((r) => [r.tag, r])), [refs]);

  const configured = state?.settings.concurrency;
  useEffect(() => {
    if (configured !== undefined && !threadsDirty) setThreads(String(configured));
  }, [configured, threadsDirty]);

  // Giá trị mới nhất cho callback chạy trong timer.
  const latest = useRef({ text, refs, prefs });
  latest.current = { text, refs, prefs };

  const addToQueue = useCallback(
    async (auto: boolean) => {
      const { text: current, refs: currentRefs, prefs: p } = latest.current;
      const list = splitPrompts(current, p.splitMode);
      if (list.length === 0) return;
      const knownNow = new Set(currentRefs.map((r) => r.tag));
      const gone = extractMentions(current).filter((t) => !knownNow.has(t));
      if (gone.length > 0) {
        if (auto) toast('warn', vi.batch.missingBlocked(gone));
        return;
      }
      setBusy(true);
      try {
        const res = await api.enqueue(list, { duration: p.duration, ratio: p.ratio, sharedTag: p.sharedTag });
        setText('');
        const ids = res.taskIds;
        toast('ok', vi.batch.added(ids.length), {
          action: {
            label: vi.batch.undo,
            run: () => {
              api
                .deleteMany(ids)
                .then((r) => {
                  toast(r.deleted === ids.length ? 'info' : 'warn', r.deleted === ids.length ? vi.batch.undone(r.deleted) : vi.batch.undoPartial);
                  setText((cur) => cur || current);
                  invalidateJobs();
                })
                .catch(reportError);
            },
          },
          durationMs: DEFAULTS.undoWindowMs,
        });
        invalidateJobs();
      } catch (e) {
        reportError(e);
      } finally {
        setBusy(false);
      }
    },
    [invalidateJobs, reportError, toast],
  );

  // "Dán là chạy luôn": chỉ sự kiện paste mới bật; sau ~2 giây không có thay đổi thêm thì tự thêm vào hàng đợi.
  useEffect(() => {
    if (!armed.current) return;
    if (!text.trim()) {
      armed.current = false;
      return;
    }
    const t = setTimeout(() => {
      armed.current = false;
      void addToQueue(true);
    }, DEFAULTS.pasteDelayMs);
    return () => clearTimeout(t);
  }, [text, addToQueue]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.defaultPrevented) {
      e.preventDefault();
      armed.current = false;
      void addToQueue(false);
    }
  };

  // Gắn một ảnh có sẵn trong kho cho tag đang thiếu: đổi @tag trong prompt sang tag của ảnh đó.
  const pickRefFor = (from: string, ref: RefImage) => {
    setText((t) => replaceMention(t, from, ref.tag));
    setPicking(null);
    toast('ok', vi.batch.attached(from, ref.tag));
  };

  const applyThreads = async () => {
    const n = Math.trunc(Number(threads));
    if (!Number.isFinite(n) || n < 1) return;
    try {
      await api.setConcurrency(n);
      setThreadsDirty(false);
      toast('ok', vi.batch.applied(n));
      void refreshState();
    } catch (e) {
      reportError(e);
    }
  };

  const run = async () => {
    try {
      await api.process();
      toast('ok', vi.batch.started);
      invalidateJobs();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NO_ONLINE_ACCOUNT') toast('error', e.message);
      else reportError(e);
    }
  };

  const stop = async () => {
    try {
      const r = await api.stopAll();
      toast('info', vi.batch.stopped(r.stopped));
      invalidateJobs();
    } catch (e) {
      reportError(e);
    }
  };

  const conc = state?.concurrency;
  const canAdd = count > 0 && missing.length === 0 && !busy;
  const running = state?.dispatcherRunning ?? false;
  const canRun = (state?.counts.waiting ?? 0) > 0 && !running;
  const canStop = running || (state?.counts.running ?? 0) > 0;

  return (
    <section aria-labelledby="composer-title" className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <h2 id="composer-title" className="sr-only">
        {vi.batch.composer}
      </h2>

      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span id="prompt-label" className="text-sm font-semibold">
          {vi.batch.promptLabel}
        </span>
        <span aria-live="polite" className={cx('rounded-full px-2.5 py-0.5 text-xs font-bold tabular-nums', count > 0 ? 'bg-accent-soft text-accent-text' : 'bg-surface-2 text-muted')}>
          {vi.batch.promptCount(count)}
        </span>
      </div>

      <div onKeyDown={onKeyDown}>
        <MentionTextarea
          value={text}
          onChange={setText}
          onPaste={() => {
            armed.current = prefs.pasteAutoRun;
          }}
          placeholder={vi.batch.promptPlaceholder}
          label={vi.batch.promptLabel}
          describedBy="mention-status"
          rows={9}
        />
      </div>

      <div id="mention-status" aria-live="polite" className="mt-2 min-h-5 space-y-2">
        {mentions.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label={vi.batch.recognized}>
            {mentions.map((tag) => {
              const ref = refByTag.get(tag);
              return ref ? (
                <li key={tag} className="inline-flex items-center gap-1.5 rounded-full border border-ok/30 bg-ok-soft py-0.5 pr-2.5 pl-0.5 text-xs font-medium text-ok">
                  <img src={ref.thumbnailUrl} alt="" className="size-5 rounded-full object-cover" />
                  <span>
                    @{tag} · {vi.batch.autoAttached}
                  </span>
                </li>
              ) : (
                <li key={tag}>
                  <button
                    type="button"
                    aria-label={vi.batch.attachPick(tag)}
                    title={vi.batch.attachPick(tag)}
                    onClick={() => setPicking(tag)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-danger bg-danger-soft py-0.5 pr-1 pl-2.5 text-xs font-semibold text-danger transition-colors hover:border-solid hover:bg-danger hover:text-accent-fg"
                  >
                    <span>{vi.batch.missingTag(tag)}</span>
                    <span className="rounded-full bg-surface px-2 py-0.5 text-accent-text">{`＋ ${vi.batch.attachCta}`}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {missing.length > 0 && (
          <p role="alert" className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {vi.batch.missingWarning(missing)}
          </p>
        )}
      </div>

      <div className="mt-4 grid gap-4">
        <label className="block text-[13px] font-semibold">
          {vi.batch.split}
          <select
            value={prefs.splitMode}
            onChange={(e) => setPrefs({ splitMode: e.target.value as SplitMode })}
            className="mt-1 block h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm font-normal"
          >
            {SPLIT_MODES.map((m) => (
              <option key={m} value={m}>
                {vi.batch.splitOptions[m]}
              </option>
            ))}
          </select>
        </label>

        <div>
          <span className="mb-1 block text-[13px] font-semibold">{vi.batch.duration}</span>
          <Segmented label={vi.batch.duration} value={prefs.duration} onChange={(v) => setPrefs({ duration: v })} options={DURATIONS.map((d) => ({ value: d, label: vi.batch.seconds(d) }))} />
        </div>

        <div>
          <span className="mb-1 block text-[13px] font-semibold">{vi.batch.ratio}</span>
          <Segmented label={vi.batch.ratio} value={prefs.ratio} onChange={(v) => setPrefs({ ratio: v })} options={RATIOS.map((r) => ({ value: r, label: vi.batch.ratioOptions[r] }))} />
        </div>

        <div>
          <label htmlFor="threads" className="mb-1 block text-[13px] font-semibold">
            {vi.batch.threads}
          </label>
          <div className="flex gap-2">
            <input
              id="threads"
              type="number"
              min={1}
              max={100}
              inputMode="numeric"
              value={threads}
              onChange={(e) => {
                setThreads(e.target.value);
                setThreadsDirty(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void applyThreads();
              }}
              aria-describedby="threads-info"
              className="h-9 w-24 rounded-lg border border-line bg-surface px-3 tabular-nums"
            />
            <Button onClick={applyThreads} disabled={!threadsDirty}>
              {vi.batch.apply}
            </Button>
          </div>
          {conc && (
            <p id="threads-info" className={cx('mt-1.5 text-xs', conc.effective < conc.configured ? 'text-warn' : 'text-muted')}>
              {vi.batch.threadsInfo(conc.effective, conc.configured, conc.onlineAccounts)}
            </p>
          )}
        </div>

        <label className="block text-[13px] font-semibold">
          {vi.batch.shared}
          <select
            value={prefs.sharedTag && known.has(prefs.sharedTag) ? prefs.sharedTag : ''}
            onChange={(e) => setPrefs({ sharedTag: e.target.value || null })}
            className="mt-1 block h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm font-normal"
          >
            <option value="">{vi.batch.sharedNone}</option>
            {refs.map((r) => (
              <option key={r.id} value={r.tag}>
                @{r.tag}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-start gap-3 rounded-xl bg-surface-2 p-3">
          <Switch checked={prefs.pasteAutoRun} onChange={(v) => setPrefs({ pasteAutoRun: v })} label={vi.batch.pasteRun} describedBy="paste-hint" />
          <div>
            <p className="text-[13px] font-semibold">{vi.batch.pasteRun}</p>
            <p id="paste-hint" className="text-xs text-muted">
              {vi.batch.pasteRunHint}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-2">
        <Button variant="primary" size="lg" disabled={!canAdd} onClick={() => void addToQueue(false)}>
          {vi.batch.add}
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button size="lg" disabled={!canRun} onClick={run} className="text-ok">
            {vi.batch.run}
          </Button>
          <Button size="lg" disabled={!canStop} onClick={stop} className="text-danger">
            {vi.batch.stop}
          </Button>
        </div>
      </div>
      <RefPicker tag={picking} refs={refs} onPick={(r) => picking && pickRefFor(picking, r)} onClose={() => setPicking(null)} />
    </section>
  );
}
