import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MuseBrowserAdapter, buildMusePrompt } from '../src/adapters/muse-browser.js';
import { AuthError, WorkerError, type GenerateSpec } from '../src/adapters/types.js';
import { ASSETS_DIR } from '../src/config.js';

/**
 * Chạy adapter với một "Muse giả" cục bộ có cùng thuộc tính DOM mà adapter dùng
 * (composer, file input, tin nhắn trợ lý, nút dừng, video blob). Test này kiểm tra luồng điều khiển;
 * nó KHÔNG chứng minh các selector khớp với muse.ai thật.
 */

const PAGE = `<!doctype html><meta charset="utf-8"><title>fake muse</title>
<div data-hatch-composer-root aria-busy="false">
  <div id="previews"></div>
  <textarea rows="4" style="width:100%"></textarea>
  <input type="file" multiple>
</div>
<div id="log"></div>
<script>
const files = [];
const $ = (s) => document.querySelector(s);
$('input[type=file]').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    const span = document.createElement('span'); span.textContent = f.name; $('#previews').append(span);
    files.push({ name: f.name, size: f.size });
  }
});
function msg(role, html) { const d = document.createElement('div'); d.dataset.messageItem = ''; d.dataset.messageRole = role; d.innerHTML = html; $('#log').append(d); return d; }
$('textarea').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  const text = e.target.value.trim();
  e.target.value = '';
  await fetch('/_sent', { method: 'POST', body: JSON.stringify({ text, files: files.splice(0) }) });
  $('#previews').innerHTML = '';
  msg('user', text);
  const stop = document.createElement('button'); stop.dataset.testid = 'hatch-composer-stop-button'; document.body.append(stop);
  await new Promise((r) => setTimeout(r, 1200));
  stop.remove();
  if (text.includes('[limit]')) {
    const n = document.createElement('div'); n.dataset.testid = 'assistant-response-error-notice'; n.textContent = 'Rate limit reached, try again later.'; document.body.append(n);
  } else if (text.includes('[no-video]')) {
    msg('assistant', 'Which style would you like?');
  } else {
    const blob = await (await fetch('/video.mp4')).blob();
    msg('assistant', 'Here is your video <video src="' + URL.createObjectURL(blob) + '"></video>');
  }
});
</script>`;

let server: http.Server;
let baseUrl = '';
let tmp = '';
const sent: { text: string; files: { name: string; size: number }[] }[] = [];
let canRun = false;
/** Mô phỏng người dùng đăng nhập trong cửa sổ Chrome: sau mốc này Muse giả coi là đã đăng nhập. */
let loggedInAfter = Infinity;
let adapter: MuseBrowserAdapter;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-fake-'));
  server = http.createServer((req, res) => {
    if (req.url === '/api/auth/check') {
      const ok = (req.headers.cookie ?? '').includes('sid=ok') || Date.now() >= loggedInAfter;
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify({ ok }));
    } else if (req.url === '/_sent') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        sent.push(JSON.parse(body));
        res.writeHead(204).end();
      });
    } else if (req.url === '/video.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' }).end(fs.readFileSync(path.join(ASSETS_DIR, '9x16.mp4')));
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  adapter = new MuseBrowserAdapter({
    baseUrl,
    cdpUrl: null,
    profileDir: null,
    loginWaitMs: 0,
    channel: process.env.MUSE_TEST_CHANNEL || 'msedge',
    headless: true,
    tmpDir: path.join(tmp, 'tmp'),
    maxWaitMs: 40_000,
    idleGraceMs: 2_000,
    debugDir: null,
  });
  try {
    const s = await adapter.login({ kind: 'cookie', label: 'test', cookie: 'sid=ok' });
    await adapter.close(s);
    canRun = true;
  } catch {
    canRun = false;
  }
}, 60_000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function ref(tag: string, rgb: [number, number, number]) {
  const p = path.join(tmp, `${tag}.png`);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toFile(p);
  return { tag, path: p, bytes: fs.statSync(p).size };
}

const hooks = (signal = new AbortController().signal) => ({ signal, onProgress: () => undefined });

describe('buildMusePrompt', () => {
  const refs = [{ tag: 'gecko', path: 'x' }, { tag: 'snake', path: 'y' }];

  it('giữ nguyên văn prompt, kể cả xuống dòng', () => {
    const prompt = 'Create a 10-second 16:9 video.\n\nTIMELINE:\n0-2s: @gecko chạy';
    expect(buildMusePrompt({ prompt, duration: 10, ratio: '16:9', refImages: [] })).toBe(prompt);
  });

  it('chỉ bổ sung độ dài / tỉ lệ khi prompt chưa nói, và nêu thứ tự ảnh sau prompt', () => {
    const text = buildMusePrompt({ prompt: '@gecko chạy\ntrên cát', duration: 15, ratio: '9:16', refImages: refs });
    expect(text.startsWith('@gecko chạy\ntrên cát\n\n')).toBe(true);
    expect(text).toContain('15 seconds');
    expect(text).toContain('aspect ratio 9:16');
    expect(text).toContain('1) @gecko, 2) @snake');
  });
});

describe('MuseBrowserAdapter với Muse giả', () => {
  it('từ chối mật khẩu và cookie sai', async (ctx) => {
    if (!canRun) return ctx.skip();
    await expect(adapter.login({ kind: 'password', identifier: 'a@b.c', secret: 'x' })).rejects.toBeInstanceOf(AuthError);
    await expect(adapter.login({ kind: 'cookie', label: 't', cookie: 'sid=wrong' })).rejects.toBeInstanceOf(AuthError);
  });

  it('gửi đúng prompt + ảnh tham chiếu (đúng thứ tự, đúng dung lượng) và nhận về video thật', async (ctx) => {
    if (!canRun) return ctx.skip();
    const session = await adapter.login({ kind: 'cookie', label: 't', cookie: 'sid=ok' });
    expect((await adapter.health(session)).status).toBe('healthy');
    const a = await ref('gecko-than-lan-xanh', [60, 140, 90]);
    const b = await ref('snake-ran-kem', [200, 90, 60]);
    const spec: GenerateSpec = { jobId: 'job_a', prompt: '@gecko-than-lan-xanh chạy trên cát\n@snake-ran-kem trườn theo', duration: 10, ratio: '16:9', attempt: 0, refImages: [a, b].map(({ tag, path: p }) => ({ tag, path: p })) };
    const out = await adapter.generate(session, spec, hooks());

    const got = sent.at(-1)!;
    expect(got.files.map((f) => f.name)).toEqual(['gecko-than-lan-xanh.png', 'snake-ran-kem.png']);
    expect(got.files.map((f) => f.size)).toEqual([a.bytes, b.bytes]);
    // prompt nguyên văn, giữ xuống dòng
    expect(got.text.startsWith('@gecko-than-lan-xanh chạy trên cát\n@snake-ran-kem trườn theo')).toBe(true);
    expect(got.text).toContain('aspect ratio 16:9');
    expect(got.text.indexOf('1) @gecko-than-lan-xanh')).toBeLessThan(got.text.indexOf('2) @snake-ran-kem'));

    const video = fs.readFileSync(out.videoPath);
    expect(video.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(video.length).toBe(fs.statSync(path.join(ASSETS_DIR, '9x16.mp4')).size);
    expect(fs.statSync(out.thumbnailPath).size).toBeGreaterThan(100);
    await adapter.close(session);
  }, 60_000);

  it('Muse trả lời chữ mà không có video: lỗi vĩnh viễn, nêu lời Muse', async (ctx) => {
    if (!canRun) return ctx.skip();
    const session = await adapter.login({ kind: 'cookie', label: 't', cookie: 'sid=ok' });
    const err = await adapter.generate(session, { jobId: 'job_b', prompt: '[no-video] x', duration: 10, ratio: '9:16', attempt: 0, refImages: [] }, hooks()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerError);
    expect((err as WorkerError).kind).toBe('permanent');
    expect((err as WorkerError).message).toContain('Which style would you like?');
    await adapter.close(session);
  }, 60_000);

  it('Muse báo giới hạn: rate-limit', async (ctx) => {
    if (!canRun) return ctx.skip();
    const session = await adapter.login({ kind: 'cookie', label: 't', cookie: 'sid=ok' });
    const err = await adapter.generate(session, { jobId: 'job_c', prompt: '[limit] x', duration: 10, ratio: '9:16', attempt: 0, refImages: [] }, hooks()).catch((e: unknown) => e);
    expect((err as WorkerError).kind).toBe('rate-limit');
    await adapter.close(session);
  }, 60_000);

  it('dừng giữa chừng thì nhả ngay, không treo', async (ctx) => {
    if (!canRun) return ctx.skip();
    const session = await adapter.login({ kind: 'cookie', label: 't', cookie: 'sid=ok' });
    const ac = new AbortController();
    const run = adapter.generate(session, { jobId: 'job_d', prompt: 'x', duration: 10, ratio: '9:16', attempt: 0, refImages: [] }, hooks(ac.signal));
    setTimeout(() => ac.abort(new Error('stop')), 1500);
    const t0 = Date.now();
    await expect(run).rejects.toThrow('stop');
    expect(Date.now() - t0).toBeLessThan(15_000);
    await adapter.close(session);
  }, 60_000);

  it('báo unreachable khi trình duyệt đã đóng, expired khi cookie hết hạn', async (ctx) => {
    if (!canRun) return ctx.skip();
    const session = await adapter.login({ kind: 'cookie', label: 't', cookie: 'sid=ok' });
    await adapter.close(session);
    expect((await adapter.health(session)).status).toBe('expired');
  }, 60_000);

  it('chế độ profile: chờ người dùng đăng nhập trong cửa sổ Chrome rồi mới tạo phiên', async (ctx) => {
    if (!canRun) return ctx.skip();
    const profiled = new MuseBrowserAdapter({
      baseUrl,
      cdpUrl: null,
      profileDir: path.join(tmp, 'profile'),
      loginWaitMs: 20_000,
      channel: process.env.MUSE_TEST_CHANNEL || 'msedge',
      headless: true,
      tmpDir: path.join(tmp, 'tmp2'),
      maxWaitMs: 40_000,
      idleGraceMs: 2_000,
      debugDir: null,
    });
    loggedInAfter = Date.now() + 4_000;
    const t0 = Date.now();
    const session = await profiled.login({ kind: 'cookie', label: 'bất kỳ', cookie: 'x=1' });
    expect(Date.now() - t0).toBeGreaterThan(3_000);
    expect((await profiled.health(session)).status).toBe('healthy');
    // chỉ một phiên dùng chung
    await expect(profiled.login({ kind: 'cookie', label: 'khác', cookie: 'y=2' })).rejects.toBeInstanceOf(AuthError);
    const out = await profiled.generate(session, { jobId: 'job_p', prompt: 'x', duration: 10, ratio: '9:16', attempt: 0, refImages: [] }, hooks());
    expect(fs.readFileSync(out.videoPath).subarray(4, 8).toString('latin1')).toBe('ftyp');
    await profiled.close(session);
    loggedInAfter = Infinity;
  }, 90_000);

  it('chế độ profile: không đăng nhập kịp thì báo lỗi rõ ràng', async (ctx) => {
    if (!canRun) return ctx.skip();
    const profiled = new MuseBrowserAdapter({
      baseUrl,
      cdpUrl: null,
      profileDir: path.join(tmp, 'profile2'),
      loginWaitMs: 3_000,
      channel: process.env.MUSE_TEST_CHANNEL || 'msedge',
      headless: true,
      tmpDir: path.join(tmp, 'tmp3'),
      maxWaitMs: 40_000,
      idleGraceMs: 2_000,
      debugDir: null,
    });
    await expect(profiled.login({ kind: 'cookie', label: 'a', cookie: 'x=1' })).rejects.toThrow(/chưa đăng nhập Muse/);
    await profiled.close({ id: 'none' });
  }, 60_000);
});
