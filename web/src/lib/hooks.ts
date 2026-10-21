import { useEffect, useRef, useState } from 'react';

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Đồng hồ chung nhảy theo giây; chỉ tạo một interval cho cả dải trực tiếp. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}

/** Giữ nguyên tham chiếu của phần tử không đổi để React.memo bỏ qua render lại. */
export function useStableList<T extends { id: string }>(items: T[] | undefined): T[] {
  const prev = useRef(new Map<string, { json: string; item: T }>());
  const next = new Map<string, { json: string; item: T }>();
  const out = (items ?? []).map((item) => {
    const json = JSON.stringify(item);
    const old = prev.current.get(item.id);
    const kept = old && old.json === json ? old.item : item;
    next.set(item.id, { json, item: kept });
    return kept;
  });
  prev.current = next;
  return out;
}

export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso));
}
