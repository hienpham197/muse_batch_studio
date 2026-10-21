import { DEFAULTS, LIMITS, type Settings } from '@muse/shared';
import { all, run, type Db } from './db.js';

const KEYS = ['concurrency', 'maxRetries', 'timeoutMinutes', 'slotsPerAccount'] as const;

const BOUNDS: Record<(typeof KEYS)[number], [number, number]> = {
  concurrency: [1, LIMITS.maxConcurrency],
  maxRetries: [0, LIMITS.maxRetries],
  timeoutMinutes: [1, LIMITS.maxTimeoutMinutes],
  slotsPerAccount: [1, LIMITS.maxSlotsPerAccount],
};

export class SettingsService {
  private cache: Settings;

  constructor(private readonly db: Db) {
    this.cache = {
      concurrency: DEFAULTS.concurrency,
      maxRetries: DEFAULTS.maxRetries,
      timeoutMinutes: DEFAULTS.timeoutMinutes,
      slotsPerAccount: DEFAULTS.slotsPerAccount,
    };
    for (const row of all(db, 'SELECT key, value FROM settings')) {
      const key = row.key as (typeof KEYS)[number];
      const n = Number(row.value);
      if (KEYS.includes(key) && Number.isInteger(n)) this.cache[key] = this.clamp(key, n);
    }
  }

  private clamp(key: (typeof KEYS)[number], n: number): number {
    const [min, max] = BOUNDS[key];
    return Math.min(max, Math.max(min, n));
  }

  get(): Settings {
    return { ...this.cache };
  }

  set(patch: Partial<Settings>): Settings {
    for (const key of KEYS) {
      const v = patch[key];
      if (v === undefined) continue;
      const n = this.clamp(key, Math.trunc(v));
      this.cache[key] = n;
      run(this.db, 'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(n));
    }
    return this.get();
  }
}
