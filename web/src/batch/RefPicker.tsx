import { useEffect, useMemo, useState } from 'react';
import type { RefImage } from '@muse/shared';
import { Button, Dialog, cx } from '../components/ui';
import { vi } from '../i18n/vi';

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Điểm giống nhau giữa tag đang thiếu và tag trong kho: tiền tố chung dài hơn thì giống hơn. */
function similarity(missing: string, tag: string): number {
  const prefix = commonPrefix(missing, tag);
  return tag.startsWith(missing) || missing.startsWith(tag) ? prefix + 100 : prefix;
}

interface Props {
  /** Tag đang thiếu ảnh; null thì đóng. */
  tag: string | null;
  refs: RefImage[];
  onPick: (ref: RefImage) => void;
  onClose: () => void;
}

/** Chọn một ảnh có sẵn trong kho cho tag đang thiếu (không upload). */
export function RefPicker({ tag, refs, onPick, onClose }: Props) {
  const [filter, setFilter] = useState('');
  useEffect(() => setFilter(''), [tag]);

  const items = useMemo(() => {
    if (!tag) return [];
    const q = filter.trim().toLowerCase();
    return refs
      .filter((r) => !q || r.tag.includes(q))
      .map((r) => ({ r, score: similarity(tag, r.tag) }))
      .sort((a, b) => b.score - a.score || a.r.tag.localeCompare(b.r.tag));
  }, [tag, refs, filter]);

  return (
    <Dialog open={tag !== null} onClose={onClose} wide title={tag ? vi.picker.title(tag) : ''} footer={<Button onClick={onClose}>{vi.common.cancel}</Button>}>
      {refs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">{vi.picker.empty}</p>
      ) : (
        <>
          <p className="text-sm text-muted">{vi.picker.intro(tag ?? '')}</p>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={vi.picker.filter}
            aria-label={vi.picker.filter}
            autoFocus
            className="mt-3 h-9 w-full rounded-lg border border-line bg-surface px-3"
          />
          {items.length === 0 ? (
            <p className="mt-4 text-sm text-muted">{vi.picker.noMatch}</p>
          ) : (
            <ul className="mt-3 grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
              {items.map(({ r, score }, i) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onPick(r)}
                    className={cx('flex w-full items-center gap-2.5 rounded-xl border bg-surface p-2 text-left transition-colors hover:border-accent hover:bg-accent-soft', i === 0 && score >= 104 ? 'border-accent' : 'border-line')}
                  >
                    <img src={r.thumbnailUrl} alt="" loading="lazy" className="size-14 shrink-0 rounded-lg bg-surface-2 object-cover" />
                    <span className="min-w-0">
                      {i === 0 && score >= 104 && <span className="mb-0.5 block text-[11px] font-bold text-accent-text">{vi.picker.suggested}</span>}
                      <span className="block text-[13px] font-semibold break-all">@{r.tag}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Dialog>
  );
}
