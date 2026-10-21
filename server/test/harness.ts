import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { MockAdapter } from '../src/adapters/mock.js';
import { buildApp } from '../src/app.js';
import { ASSETS_DIR, loadConfig } from '../src/config.js';
import { Core, createCore } from '../src/core.js';
import { openDb } from '../src/db.js';

export interface Harness {
  core: Core;
  app: FastifyInstance;
  adapter: MockAdapter;
  dir: string;
  dataDir: string;
  /** Đẩy `offset` (ms) để mô phỏng thời gian trôi qua mà không phải chờ thật. */
  clock: { offset: number };
  call<T = any>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T; headers: Record<string, any> }>;
  upload(files: { name: string; data: Buffer; type?: string }[], url?: string): Promise<{ status: number; body: any }>;
  addAccounts(n: number): Promise<string[]>;
  addRef(tag: string, color?: string): Promise<void>;
  waitFor(cond: () => boolean | Promise<boolean>, timeoutMs?: number, label?: string): Promise<void>;
  close(): Promise<void>;
}

export const HOST = 'localhost:8787';

export async function png(color = '#cc3355', size = 64): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();
}

export function multipart(files: { name: string; data: Buffer; type?: string }[], fields: Record<string, string> = {}) {
  const boundary = `----muse${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`));
    chunks.push(f.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export async function makeHarness(env: Record<string, string> = {}, opts: { speed?: number; jobSeconds?: number } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-test-'));
  const dataDir = path.join(dir, 'data');
  const config = loadConfig({
    MUSE_DATA_DIR: dataDir,
    MUSE_KEY_DIR: path.join(dir, 'keys'),
    MUSE_TICK_INTERVAL_MS: '25',
    MUSE_HEALTH_INTERVAL_MS: '3600000',
    MUSE_HEALTH_TTL_MS: '0',
    PORT: '8787',
    ...env,
  });
  const adapter = new MockAdapter({
    assetsDir: ASSETS_DIR,
    tmpDir: path.join(dataDir, 'tmp'),
    jobSeconds: opts.jobSeconds ?? 14,
    failRate: 0,
    speed: opts.speed ?? 60,
  });
  const clock = { offset: 0 };
  const now = () => Date.now() + clock.offset;
  const core = createCore(config, { db: openDb(dataDir), adapter, now });
  await core.start();
  const app = await buildApp(core, { devRoutes: true });
  await app.ready();

  const h: Harness = {
    core,
    app,
    adapter,
    dir,
    dataDir,
    clock,
    async call(method, url, body, headers = {}) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { host: HOST, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        payload: body === undefined ? undefined : JSON.stringify(body),
      });
      let parsed: any = res.body;
      try {
        parsed = res.body ? JSON.parse(res.body) : undefined;
      } catch {
        /* nhị phân */
      }
      return { status: res.statusCode, body: parsed, headers: res.headers };
    },
    async upload(files, url = '/api/refs/upload') {
      const m = multipart(files);
      const res = await app.inject({ method: 'POST', url, headers: { host: HOST, ...m.headers }, payload: m.payload });
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
    },
    async addAccounts(n) {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const r = await h.call('POST', '/api/accounts', { identifier: `nguoi${i}@example.com`, secret: `S3cret-${i}-Pass!` });
        if (r.status !== 201) throw new Error(`addAccount: ${JSON.stringify(r.body)}`);
        ids.push(r.body.account.id);
      }
      return ids;
    },
    async addRef(tag, color) {
      const up = await h.upload([{ name: `${tag}.png`, data: await png(color) }]);
      const staged = up.body.staged[0];
      const c = await h.call('POST', '/api/refs/commit', { items: [{ stagedId: staged.stagedId, tag }] });
      if (!c.body.results[0].ok) throw new Error(JSON.stringify(c.body));
    },
    async waitFor(cond, timeoutMs = 15_000, label = 'điều kiện') {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`Hết thời gian chờ: ${label}`);
    },
    async close() {
      await app.close();
      await core.stop();
      core.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}
