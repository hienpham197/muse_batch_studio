import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DURATIONS, RATIOS, STUDIO_CARD, type StudioCard } from '@muse/shared';
import { api, ApiError } from '../api/client';
import { Button, ConfirmDialog, Segmented } from '../components/ui';
import { vi } from '../i18n/vi';
import { useStableList } from '../lib/hooks';
import { useStore } from '../state/store';
import { StudioCardView } from './StudioCardView';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

export function StudioTab({ active }: { active: boolean }) {
  const { state, refs, prefs, setPrefs, toast, reportError, refreshState, invalidateJobs } = useStore();
  const [cards, setCards] = useState<StudioCard[]>([]);
  const [local, setLocal] = useState<Record<string, { x: number; y: number }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState(1);
  const [menu, setMenu] = useState<'add' | 'settings' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const savedScroll = useRef({ left: 0, top: 0 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const stable = useStableList(cards);

  const load = useCallback(async () => {
    try {
      setCards(await api.studioCards());
    } catch {
      /* mất kết nối được báo ở header */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (!stopped) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, load]);

  // Ẩn tab bằng display:none làm mất vị trí cuộn, nên lưu và khôi phục khi quay lại.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!active) savedScroll.current = { left: el.scrollLeft, top: el.scrollTop };
  }, [active]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (active && el) {
      el.scrollLeft = savedScroll.current.left;
      el.scrollTop = savedScroll.current.top;
    }
  }, [active]);

  const commitMove = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const onMove = useCallback(
    (id: string, x: number, y: number, commit: boolean) => {
      setLocal((l) => ({ ...l, [id]: { x, y } }));
      if (!commit) return;
      clearTimeout(commitMove.current[id]);
      commitMove.current[id] = setTimeout(() => {
        api
          .updateStudioCard(id, { x: Math.round(x), y: Math.round(y) })
          .then((card) => {
            setCards((cs) => cs.map((c) => (c.id === id ? card : c)));
            setLocal((l) => {
              const { [id]: _drop, ...rest } = l;
              return rest;
            });
          })
          .catch(reportError);
      }, 250);
    },
    [reportError],
  );

  const onPrompt = useCallback(
    (id: string, prompt: string) => {
      setErrors((e) => {
        const { [id]: _drop, ...rest } = e;
        return rest;
      });
      api
        .updateStudioCard(id, { prompt })
        .then((card) => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, prompt: card.prompt } : c))))
        .catch(reportError);
    },
    [reportError],
  );

  const generate = async (cardId?: string) => {
    try {
      const res = await api.generateStudio({ duration: prefs.duration, ratio: prefs.ratio }, cardId);
      if (res.skipped.length) {
        setErrors((e) => ({ ...e, ...Object.fromEntries(res.skipped.map((s) => [s.cardId, s.reason])) }));
        toast('warn', vi.studio.skipped(res.skipped.length));
      }
      if (res.queued.length) {
        setErrors((e) => {
          const next = { ...e };
          for (const id of res.queued) delete next[id];
          return next;
        });
        toast('ok', vi.studio.generated(res.queued.length));
      } else if (res.skipped.length === 0) toast('info', vi.studio.nothingToGenerate);
      await load();
      invalidateJobs();
      void refreshState();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'NO_ONLINE_ACCOUNT' || e.code === 'VALIDATION')) toast('error', e.message);
      else reportError(e);
    }
  };

  const generateOne = useCallback((id: string) => void generate(id), [prefs.duration, prefs.ratio]); // eslint-disable-line react-hooks/exhaustive-deps

  const afterAdd = (added: StudioCard[]) => {
    setCards((cs) => [...cs, ...added]);
    const last = added[added.length - 1];
    const el = scroller.current;
    if (last && el) {
      const z = zoomRef.current;
      const inView = last.x * z >= el.scrollLeft && (last.x + STUDIO_CARD.width) * z <= el.scrollLeft + el.clientWidth && last.y * z >= el.scrollTop && (last.y + STUDIO_CARD.height) * z <= el.scrollTop + el.clientHeight;
      if (!inView) el.scrollTo({ left: Math.max(0, last.x * z - 40), top: Math.max(0, last.y * z - 40), behavior: 'smooth' });
    }
  };

  const addFiles = async (files: File[]) => {
    const added: StudioCard[] = [];
    for (const f of files) {
      try {
        added.push(await api.addStudioCardFromFile(f));
      } catch (e) {
        reportError(e);
      }
    }
    if (added.length) afterAdd(added);
  };

  const addFromTag = async (tag: string) => {
    setMenu(null);
    try {
      afterAdd([await api.addStudioCardFromTag(tag)]);
    } catch (e) {
      reportError(e);
    }
  };

  const confirmRemove = async () => {
    const id = removing;
    setRemoving(null);
    if (!id) return;
    try {
      await api.deleteStudioCard(id);
      setCards((cs) => cs.filter((c) => c.id !== id));
      invalidateJobs();
    } catch (e) {
      reportError(e);
    }
  };

  const posOf = (c: StudioCard) => local[c.id] ?? { x: c.x, y: c.y };
  const maxX = Math.max(0, ...stable.map((c) => posOf(c).x + STUDIO_CARD.width));
  const maxY = Math.max(0, ...stable.map((c) => posOf(c).y + STUDIO_CARD.height));
  const worldW = Math.max(1800, maxX + 600);
  const worldH = Math.max(1100, maxY + 500);

  const setZoomAt = useCallback((next: number, cx?: number, cy?: number) => {
    const el = scroller.current;
    const old = zoomRef.current;
    const z = clampZoom(next);
    if (!el || z === old) return;
    const px = cx ?? el.clientWidth / 2;
    const py = cy ?? el.clientHeight / 2;
    const wx = (el.scrollLeft + px) / old;
    const wy = (el.scrollTop + py) / old;
    setZoom(z);
    requestAnimationFrame(() => {
      el.scrollLeft = wx * z - px;
      el.scrollTop = wy * z - py;
    });
  }, []);

  // Ctrl + lăn chuột để thu phóng. Cần listener non-passive để chặn zoom của trình duyệt.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      setZoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoomAt]);

  const fit = () => {
    const el = scroller.current;
    if (!el || stable.length === 0) return;
    const xs = stable.map((c) => posOf(c).x);
    const ys = stable.map((c) => posOf(c).y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const w = Math.max(...xs) + STUDIO_CARD.width - minX;
    const h = Math.max(...ys) + STUDIO_CARD.height - minY;
    const z = clampZoom(Math.min((el.clientWidth - 80) / w, (el.clientHeight - 80) / h, 1));
    setZoom(z);
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, minX * z - 40);
      el.scrollTop = Math.max(0, minY * z - 40);
    });
  };

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-popover]')) setMenu(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [menu]);

  return (
    <section hidden={!active} aria-label={vi.studio.title} className="flex h-[calc(100dvh-13rem)] min-h-[520px] flex-col p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-base font-bold">{vi.studio.title}</h2>

        <div className="relative" data-popover>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              setMenu(null);
              if (files.length) void addFiles(files);
            }}
          />
          <Button onClick={() => setMenu(menu === 'add' ? null : 'add')} aria-haspopup="menu" aria-expanded={menu === 'add'}>
            {vi.studio.addImage}
          </Button>
          {menu === 'add' && (
            <div role="menu" className="absolute right-0 z-30 mt-1.5 w-72 rounded-xl border border-line bg-surface p-1.5 shadow-2xl">
              <button type="button" role="menuitem" className="w-full rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-surface-2" onClick={() => fileInput.current?.click()}>
                {vi.studio.fromDevice}
              </button>
              <p className="px-3 pt-2 pb-1 text-xs font-semibold text-muted">{vi.studio.fromRefs}</p>
              {refs.length === 0 ? (
                <p className="px-3 pb-2 text-xs text-muted">{vi.studio.refsEmpty}</p>
              ) : (
                <ul className="max-h-60 overflow-y-auto">
                  {refs.map((r) => (
                    <li key={r.id}>
                      <button type="button" role="menuitem" onClick={() => void addFromTag(r.tag)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2">
                        <img src={r.thumbnailUrl} alt="" className="size-9 rounded-md object-cover" />
                        <span className="truncate text-sm font-medium">@{r.tag}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <Button variant="primary" onClick={() => void generate()} disabled={stable.length === 0}>
          {vi.studio.generateAll}
        </Button>

        <div className="relative" data-popover>
          <Button variant="ghost" aria-label={vi.studio.settings} title={vi.studio.settings} aria-haspopup="dialog" aria-expanded={menu === 'settings'} onClick={() => setMenu(menu === 'settings' ? null : 'settings')}>
            ⚙
          </Button>
          {menu === 'settings' && (
            <div role="dialog" aria-label={vi.studio.settings} className="absolute right-0 z-30 mt-1.5 w-80 space-y-3 rounded-xl border border-line bg-surface p-3.5 shadow-2xl">
              <p className="text-xs text-muted">{vi.studio.settingsHint}</p>
              <div>
                <span className="mb-1 block text-[13px] font-semibold">{vi.batch.duration}</span>
                <Segmented label={vi.batch.duration} value={prefs.duration} onChange={(v) => setPrefs({ duration: v })} options={DURATIONS.map((d) => ({ value: d, label: vi.batch.seconds(d) }))} />
              </div>
              <div>
                <span className="mb-1 block text-[13px] font-semibold">{vi.batch.ratio}</span>
                <Segmented label={vi.batch.ratio} value={prefs.ratio} onChange={(v) => setPrefs({ ratio: v })} options={RATIOS.map((r) => ({ value: r, label: vi.batch.ratioOptions[r] }))} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-line">
        <div ref={scroller} role="region" aria-label={vi.studio.canvas} tabIndex={0} className="dot-grid absolute inset-0 overflow-auto">
          <div style={{ width: worldW * zoom, height: worldH * zoom, position: 'relative', backgroundImage: 'radial-gradient(var(--dot) 1.2px, transparent 1.2px)', backgroundSize: `${22 * zoom}px ${22 * zoom}px` }}>
            <div style={{ width: worldW, height: worldH, transform: `scale(${zoom})`, transformOrigin: '0 0', position: 'absolute', left: 0, top: 0 }}>
              {stable.map((c, i) => {
                const p = posOf(c);
                return <StudioCardView key={c.id} card={c} progressKnown={state?.reportsProgress !== false} simulated={state?.simulated === true} index={i} x={p.x} y={p.y} zoom={zoom} localError={errors[c.id]} onMove={onMove} onPrompt={onPrompt} onRemove={setRemoving} onGenerate={generateOne} />;
              })}
            </div>
          </div>
          {stable.length === 0 && (
            <p className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted">
              <span className="max-w-sm rounded-xl bg-surface/90 px-4 py-3">{vi.studio.empty}</span>
            </p>
          )}
        </div>

        <div className="absolute bottom-3 left-3 z-20 flex items-center gap-1 rounded-xl border border-line bg-surface p-1 shadow-lg">
          <Button size="sm" variant="ghost" aria-label={vi.studio.zoomOut} onClick={() => setZoomAt(zoom - 0.1)} disabled={zoom <= MIN_ZOOM}>
            −
          </Button>
          <span aria-live="polite" className="w-12 text-center text-xs font-semibold tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <Button size="sm" variant="ghost" aria-label={vi.studio.zoomIn} onClick={() => setZoomAt(zoom + 0.1)} disabled={zoom >= MAX_ZOOM}>
            +
          </Button>
          <Button size="sm" onClick={fit} disabled={stable.length === 0}>
            {vi.studio.fit}
          </Button>
        </div>
      </div>

      <ConfirmDialog open={removing !== null} title={vi.studio.removeTitle} body={vi.studio.removeBody} confirmLabel={vi.studio.removeConfirm} onConfirm={confirmRemove} onCancel={() => setRemoving(null)} />
    </section>
  );
}
