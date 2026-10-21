import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Thư mục chứa khóa mã hóa, phải nằm ngoài dataDir (Mục 2.5). */
  keyDir: string;
  /** Khóa mã hóa truyền qua biến môi trường (base64, 32 byte); ưu tiên hơn file khóa. */
  masterKeyB64: string | null;
  adapter: string;
  /** Nếu đặt, mọi request /api phải đăng nhập bằng token này. */
  accessToken: string | null;
  allowedOrigins: string[];
  webDist: string | null;
  healthIntervalMs: number;
  healthTtlMs: number;
  tickIntervalMs: number;
  mock: {
    jobSeconds: number;
    failRate: number;
  };
  /** Adapter `muse`: điều khiển Chrome thật đã đăng nhập Muse. */
  muse: {
    baseUrl: string;
    cdpUrl: string | null;
    profileDir: string | null;
    loginWaitMs: number;
    channel: string;
    headless: boolean;
    maxWaitMs: number;
    idleGraceMs: number;
    debug: boolean;
  };
}

const rootDir = path.resolve(import.meta.dirname, '..', '..');

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function defaultKeyDir(env: NodeJS.ProcessEnv): string {
  if (env.APPDATA) return path.join(env.APPDATA, 'muse-batch-manager');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'muse-batch-manager');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = num(env.PORT, 8787);
  const host = env.HOST || '127.0.0.1';
  const origins = new Set<string>();
  for (const h of ['127.0.0.1', 'localhost']) {
    origins.add(`http://${h}:${port}`);
    origins.add(`http://${h}:5173`);
  }
  for (const o of (env.MUSE_ALLOWED_ORIGINS ?? '').split(',')) if (o.trim()) origins.add(o.trim());

  return {
    host,
    port,
    dataDir: path.resolve(env.MUSE_DATA_DIR || path.join(rootDir, 'data')),
    keyDir: path.resolve(env.MUSE_KEY_DIR || defaultKeyDir(env)),
    masterKeyB64: env.MUSE_MASTER_KEY || null,
    adapter: env.MUSE_ADAPTER || 'mock',
    accessToken: env.MUSE_ACCESS_TOKEN || null,
    allowedOrigins: [...origins],
    webDist: path.join(rootDir, 'web', 'dist'),
    healthIntervalMs: num(env.MUSE_HEALTH_INTERVAL_MS, 30_000),
    healthTtlMs: num(env.MUSE_HEALTH_TTL_MS, 5_000),
    tickIntervalMs: num(env.MUSE_TICK_INTERVAL_MS, 1_000),
    mock: {
      jobSeconds: num(env.MUSE_MOCK_JOB_SECONDS, 14),
      failRate: num(env.MUSE_MOCK_FAIL_RATE, 0.05),
    },
    muse: {
      baseUrl: (env.MUSE_PLATFORM_URL || 'https://muse.ai/').replace(/\/?$/, '/'),
      cdpUrl: env.MUSE_CDP || null,
      profileDir: env.MUSE_PROFILE_DIR ? path.resolve(env.MUSE_PROFILE_DIR) : null,
      loginWaitMs: num(env.MUSE_LOGIN_WAIT_MS, 5 * 60_000),
      channel: env.MUSE_CHANNEL || 'chrome',
      headless: env.MUSE_HEADLESS === '1',
      maxWaitMs: num(env.MUSE_MAX_WAIT_MS, 30 * 60_000),
      idleGraceMs: num(env.MUSE_IDLE_GRACE_MS, 120_000),
      debug: env.MUSE_DEBUG === '1',
    },
  };
}

export const ASSETS_DIR = path.resolve(import.meta.dirname, '..', 'assets');
