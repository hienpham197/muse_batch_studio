import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type Ref } from 'react';
import { useStore } from '../state/store';
import { vi } from '../i18n/vi';
import { cx } from './ui';

// Giống bộ nhận diện trong @muse/shared: @ không đứng sau chữ, số hoặc @.
const TRIGGER = /(?<![\p{L}\p{N}_@])@([\p{L}\p{N}_-]*)$/u;
const MIRROR_PROPS = [
  'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontFamily',
  'lineHeight', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize',
] as const;

/** Tọa độ con trỏ trong textarea bằng cách dựng một div phản chiếu cùng kiểu chữ. */
function caretCoords(el: HTMLTextAreaElement, pos: number): { top: number; left: number; height: number } {
  const style = getComputedStyle(el);
  const mirror = document.createElement('div');
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  for (const p of MIRROR_PROPS) (mirror.style as unknown as Record<string, string>)[p] = style[p];
  mirror.textContent = el.value.slice(0, pos);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const coords = { top: marker.offsetTop + parseFloat(style.borderTopWidth), left: marker.offsetLeft + parseFloat(style.borderLeftWidth), height: parseFloat(style.lineHeight) || 20 };
  document.body.removeChild(mirror);
  return coords;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
  placeholder?: string;
  rows?: number;
  label: string;
  describedBy?: string;
  className?: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

export function MentionTextarea({ value, onChange, onPaste, onBlur, placeholder, rows = 8, label, describedBy, className, textareaRef }: Props) {
  const { refs } = useStore();
  const localRef = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [ctx, setCtx] = useState<{ start: number; caret: number; query: string } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const pendingCaret = useRef<number | null>(null);

  const setRefs = (el: HTMLTextAreaElement | null) => {
    localRef.current = el;
    if (typeof textareaRef === 'function') textareaRef(el);
    else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = el;
  };

  const detect = () => {
    const el = localRef.current;
    if (!el || document.activeElement !== el || el.selectionStart !== el.selectionEnd) return setCtx(null);
    const caret = el.selectionStart;
    const m = TRIGGER.exec(el.value.slice(0, caret));
    if (!m) return setCtx(null);
    const start = caret - m[0].length;
    const key = `${start}:${m[1]}`;
    if (key === dismissed) return setCtx(null);
    setCtx({ start, caret, query: m[1]!.toLowerCase() });
  };

  const items = useMemo(() => {
    if (!ctx) return [];
    const q = ctx.query;
    const starts = refs.filter((r) => r.tag.startsWith(q));
    const rest = refs.filter((r) => !r.tag.startsWith(q) && r.tag.includes(q));
    return [...starts, ...rest];
  }, [ctx, refs]);

  useEffect(() => setActive(0), [ctx?.query, ctx?.start]);

  useLayoutEffect(() => {
    const el = localRef.current;
    if (ctx && el) {
      const c = caretCoords(el, ctx.start);
      const maxLeft = Math.max(0, el.clientWidth - 288);
      setPos({ top: c.top - el.scrollTop + c.height + 4, left: Math.min(Math.max(0, c.left), maxLeft) });
    }
  }, [ctx, value]);

  useLayoutEffect(() => {
    if (pendingCaret.current !== null && localRef.current) {
      localRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  const choose = (index: number) => {
    const item = items[index];
    if (!ctx || !item) return;
    const insert = `@${item.tag} `;
    const next = value.slice(0, ctx.start) + insert + value.slice(ctx.caret);
    pendingCaret.current = ctx.start + insert.length;
    setCtx(null);
    onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!ctx) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(`${ctx.start}:${ctx.query}`);
      setCtx(null);
    } else if (items.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (items.length > 0 && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      choose(active);
    }
  };

  const open = ctx !== null;
  const activeId = open && items[active] ? `${listId}-${active}` : undefined;

  return (
    <div className="relative">
      <textarea
        ref={setRefs}
        value={value}
        rows={rows}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={describedBy}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        aria-haspopup="listbox"
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value);
          requestAnimationFrame(detect);
        }}
        onSelect={detect}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => {
          setCtx(null);
          onBlur?.();
        }}
        className={cx('block w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5 leading-relaxed text-fg placeholder:text-muted/70', className)}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={vi.batch.mentionList}
          style={{ top: pos.top, left: pos.left }}
          className="absolute z-30 max-h-60 w-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-2xl"
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.length === 0 && <li className="px-3 py-2 text-[13px] text-muted">{refs.length === 0 ? vi.batch.mentionNoRefs : vi.batch.mentionNoMatch}</li>}
          {items.map((r, i) => (
            <li
              key={r.tag}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(i)}
              className={cx('flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5', i === active && 'bg-accent-soft')}
            >
              <img src={r.thumbnailUrl} alt="" className="size-9 shrink-0 rounded-md bg-surface-2 object-cover" />
              <span className="min-w-0 truncate font-medium">@{r.tag}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
