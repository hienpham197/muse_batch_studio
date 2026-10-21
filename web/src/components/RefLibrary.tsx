import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ACCEPTED_IMAGE_MIME, DEFAULTS, checkTag, type RefImage, type StagedImage, type UploadRejection } from '@muse/shared';
import { api, ApiError } from '../api/client';
import { vi } from '../i18n/vi';
import { formatBytes } from '../lib/hooks';
import { useStore } from '../state/store';
import { Button, ConfirmDialog, Dialog, cx } from './ui';

const MAX_MB = DEFAULTS.maxImageBytes / 1024 / 1024;

const Chip = memo(function Chip({ image, onRemove }: { image: RefImage; onRemove: (tag: string) => void }) {
  return (
    <li className="group flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-1 pl-1 shadow-sm">
      <img src={image.thumbnailUrl} alt="" loading="lazy" decoding="async" className="size-8 rounded-full bg-surface-2 object-cover" />
      <span className="max-w-32 truncate text-[13px] font-semibold" title={image.fileName}>
        @{image.tag}
      </span>
      <button
        type="button"
        aria-label={vi.refs.remove(image.tag)}
        onClick={() => onRemove(image.tag)}
        className="grid size-6 place-items-center rounded-full text-muted hover:bg-danger-soft hover:text-danger"
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
});

export function RefLibrary() {
  const { refs, refreshRefs, setUploadOpen, toast, reportError, invalidateJobs } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [incoming, setIncoming] = useState<{ id: number; files: File[] } | null>(null);
  const [del, setDel] = useState<{ tag: string; affected: number | null } | null>(null);
  const seq = useRef(0);

  const confirmDelete = async () => {
    if (!del) return;
    try {
      await api.deleteRef(del.tag, del.affected !== null);
      toast('ok', vi.refs.deleted(del.tag));
      setDel(null);
      await refreshRefs();
      invalidateJobs();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRM_REQUIRED') setDel({ tag: del.tag, affected: Number(e.details?.affectedJobs ?? 0) });
      else {
        setDel(null);
        reportError(e);
      }
    }
  };

  const onRemove = useCallback((tag: string) => setDel({ tag, affected: null }), []);

  return (
    <section aria-label={vi.refs.title} className="flex flex-col gap-3 border-b border-line bg-surface px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="text-sm font-semibold">{vi.refs.count(refs.length)}</h2>
          <p className="text-xs text-muted">{vi.refs.hint}</p>
        </div>
        {refs.length === 0 ? (
          <p className="mt-1.5 text-[13px] text-muted">{vi.refs.empty}</p>
        ) : (
          <ul className="mt-2 flex max-h-24 flex-wrap gap-2 overflow-y-auto pr-1">
            {refs.map((r) => (
              <Chip key={r.id} image={r} onRemove={onRemove} />
            ))}
          </ul>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_IMAGE_MIME.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) {
            setIncoming({ id: ++seq.current, files });
            setUploadOpen(true);
          }
        }}
      />
      <Button variant="primary" size="lg" className="shrink-0 shadow-md" onClick={() => inputRef.current?.click()}>
        {vi.refs.add}
      </Button>

      <UploadDialog incoming={incoming} onPickMore={() => inputRef.current?.click()} onDropFiles={(files) => setIncoming({ id: ++seq.current, files })} />

      <ConfirmDialog
        open={del !== null}
        title={del ? vi.refs.confirmDeleteTitle(del.tag) : ''}
        body={del && (del.affected !== null && del.affected > 0 ? vi.refs.confirmDeleteAffected(del.affected) : vi.refs.confirmDeleteBody)}
        confirmLabel={vi.refs.confirmDelete}
        onConfirm={confirmDelete}
        onCancel={() => setDel(null)}
      />
    </section>
  );
}

interface Row {
  key: string;
  staged: StagedImage;
  tag: string;
  error?: string;
}

function UploadDialog({ incoming, onPickMore, onDropFiles }: { incoming: { id: number; files: File[] } | null; onPickMore: () => void; onDropFiles: (f: File[]) => void }) {
  const { uploadOpen, setUploadOpen, refs, refreshRefs, toast, reportError } = useStore();
  const [rows, setRows] = useState<Row[]>([]);
  const [rejected, setRejected] = useState<UploadRejection[]>([]);
  const [busy, setBusy] = useState<'upload' | 'save' | null>(null);
  const [drag, setDrag] = useState(false);
  const handled = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    if (!incoming || incoming.id === handled.current) return;
    handled.current = incoming.id;
    const tooBig: UploadRejection[] = [];
    const ok: File[] = [];
    for (const f of incoming.files) {
      if (f.size > DEFAULTS.maxImageBytes) tooBig.push({ fileName: f.name, code: 'IMAGE_TOO_LARGE', message: vi.upload.tooLarge(f.name, MAX_MB) });
      else ok.push(f);
    }
    setRejected((r) => [...r, ...tooBig]);
    if (ok.length === 0) return;
    setBusy('upload');
    api
      .uploadRefs(ok)
      .then((res) => {
        setRows((prev) => [...prev, ...res.staged.map((s) => ({ key: s.stagedId, staged: s, tag: s.suggestedTag }))]);
        setRejected((r) => [...r, ...res.rejected]);
      })
      .catch(reportError)
      .finally(() => setBusy(null));
  }, [incoming, reportError]);

  const taken = useMemo(() => new Set(refs.map((r) => r.tag)), [refs]);

  const problems = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.tag, (counts.get(r.tag) ?? 0) + 1);
    return new Map(
      rows.map((r) => {
        const p = checkTag(r.tag);
        const msg = p === 'empty' ? vi.upload.tagEmpty : p === 'chars' ? vi.upload.tagChars : p === 'too-long' ? vi.upload.tagLong : taken.has(r.tag) ? vi.upload.tagTaken(r.tag) : (counts.get(r.tag) ?? 0) > 1 ? vi.upload.tagDupInBatch(r.tag) : (r.error ?? null);
        return [r.key, msg] as const;
      }),
    );
  }, [rows, taken]);

  const validRows = rows.filter((r) => !problems.get(r.key));

  const discardAll = useCallback(() => {
    for (const r of rowsRef.current) void api.discardStaged(r.staged.stagedId).catch(() => undefined);
    setRows([]);
    setRejected([]);
  }, []);

  const close = useCallback(() => {
    if (busy === 'save') return;
    discardAll();
    setUploadOpen(false);
  }, [busy, discardAll, setUploadOpen]);

  const save = async () => {
    if (validRows.length === 0) return;
    setBusy('save');
    try {
      const results = await api.commitRefs(validRows.map((r) => ({ stagedId: r.staged.stagedId, tag: r.tag })));
      const failed = new Map(results.filter((r) => !r.ok).map((r) => [r.stagedId, r.message ?? vi.common.unexpected]));
      const savedCount = results.length - failed.size;
      setRows((prev) => prev.filter((r) => !results.find((x) => x.stagedId === r.staged.stagedId && x.ok)).map((r) => (failed.has(r.staged.stagedId) ? { ...r, error: failed.get(r.staged.stagedId) } : r)));
      await refreshRefs();
      if (failed.size === 0 && rows.length === validRows.length) {
        toast('ok', vi.upload.saved(savedCount));
        setRejected([]);
        setUploadOpen(false);
      } else {
        toast(savedCount > 0 ? 'warn' : 'error', savedCount > 0 ? vi.upload.partial(savedCount, rows.length - savedCount) : failed.values().next().value!);
      }
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onDropFiles(files);
  };

  return (
    <Dialog
      open={uploadOpen}
      onClose={close}
      wide
      title={vi.upload.title}
      footer={
        <>
          <Button onClick={close} disabled={busy === 'save'}>
            {vi.upload.cancel}
          </Button>
          <Button variant="primary" onClick={save} disabled={validRows.length === 0 || busy !== null}>
            {vi.upload.save(validRows.length)}
          </Button>
        </>
      }
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={cx('rounded-xl border-2 border-dashed px-4 py-4 text-center transition-colors', drag ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2')}
      >
        <Button onClick={onPickMore}>{vi.upload.pick}</Button>
        <p className="mt-1.5 text-[13px] text-muted">{vi.upload.drop}</p>
        <p className="mt-0.5 text-xs text-muted">{vi.upload.rules(MAX_MB)}</p>
      </div>

      {busy === 'upload' && (
        <p role="status" className="mt-3 text-sm text-muted">
          {vi.upload.uploading}
        </p>
      )}

      {rejected.length > 0 && (
        <div role="alert" className="mt-3 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <p className="font-semibold">{vi.upload.rejected}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {rejected.map((r, i) => (
              <li key={`${r.fileName}-${i}`}>{r.message}</li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <h3 className="mt-4 mb-2 text-sm font-semibold">
            {vi.upload.pending} · {rows.length}
          </h3>
          <ul className="space-y-2">
            {rows.map((r) => {
              const problem = problems.get(r.key);
              const errId = `err-${r.key}`;
              return (
                <li key={r.key} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-2.5">
                  <img src={r.staged.thumbnailUrl} alt="" className="size-14 shrink-0 rounded-lg bg-surface-2 object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-muted" title={r.staged.fileName}>
                      {r.staged.fileName} · {formatBytes(r.staged.size)}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span aria-hidden="true" className="text-muted">
                        @
                      </span>
                      <input
                        value={r.tag}
                        aria-label={vi.upload.tagFor(r.staged.fileName)}
                        aria-invalid={!!problem}
                        aria-describedby={problem ? errId : undefined}
                        spellCheck={false}
                        autoCapitalize="off"
                        onChange={(e) => setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, tag: e.target.value.trim().toLowerCase(), error: undefined } : x)))}
                        className={cx('h-8 w-full max-w-64 rounded-md border bg-surface px-2 font-mono text-[13px]', problem ? 'border-danger' : 'border-line')}
                      />
                    </div>
                    {problem && (
                      <p id={errId} className="mt-1 text-xs text-danger">
                        {problem}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={vi.upload.removeRow(r.staged.fileName)}
                    onClick={() => {
                      void api.discardStaged(r.staged.stagedId).catch(() => undefined);
                      setRows((prev) => prev.filter((x) => x.key !== r.key));
                    }}
                  >
                    ✕
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Dialog>
  );
}
