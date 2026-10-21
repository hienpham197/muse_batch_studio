import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadMasterKey, maskIdentifier, Vault } from '../src/crypto.js';
import { makeHarness, HOST, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('AC-12: không lộ credential', () => {
  const SECRET = 'Sup3r-Secret-Passw0rd!';
  const IDENT = 'chu.tai.khoan@example.com';

  it('không có phản hồi API, file dữ liệu hay log nào chứa plaintext', async () => {
    h = await makeHarness();
    const lines: string[] = [];
    const app = await buildApp(h.core, { logger: true, logStream: { write: (m) => void lines.push(m) } });
    await app.ready();

    const add = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { host: HOST, 'content-type': 'application/json' },
      payload: JSON.stringify({ identifier: IDENT, secret: SECRET }),
    });
    expect(add.statusCode).toBe(201);
    const id = add.json().account.id;
    const responses = [add.body];
    for (const url of ['/api/accounts', '/api/state', `/api/accounts/${id}/health`]) {
      const res = await app.inject({ method: url.endsWith('health') ? 'POST' : 'GET', url, headers: { host: HOST } });
      responses.push(res.body);
    }
    // Cả lỗi cũng không được phản chiếu lại secret.
    const bad = await app.inject({ method: 'POST', url: '/api/accounts', headers: { host: HOST, 'content-type': 'application/json' }, payload: JSON.stringify({ identifier: IDENT, secret: SECRET }) });
    responses.push(bad.body);

    for (const body of responses) {
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain(IDENT);
    }
    expect(add.json().account.maskedId).toBe('ch***@e***.com');

    const files = walk(h.dataDir);
    expect(files.some((f) => f.endsWith('muse.sqlite'))).toBe(true);
    for (const f of files) {
      const bytes = fs.readFileSync(f);
      expect(bytes.includes(Buffer.from(SECRET)), `${f} chứa secret`).toBe(false);
      expect(bytes.includes(Buffer.from(IDENT)), `${f} chứa định danh`).toBe(false);
    }
    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(IDENT);
    await app.close();
  });

  it('credential lưu dạng mã hóa AES-GCM, giải mã được và chống sửa đổi', () => {
    const vault = new Vault(Buffer.alloc(32, 7));
    const enc = vault.encrypt('{"secret":"abc"}');
    expect(enc).not.toContain('abc');
    expect(vault.decrypt(enc)).toBe('{"secret":"abc"}');
    const [v, iv, tag, ct] = enc.split('.');
    const flipped = Buffer.from(ct!, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => vault.decrypt([v, iv, tag, flipped.toString('base64')].join('.'))).toThrow();
    expect(new Vault(Buffer.alloc(32, 8)).identifierHash('A@b.c')).not.toBe(vault.identifierHash('A@b.c'));
  });

  it('khóa mã hóa phải nằm ngoài thư mục dữ liệu', () => {
    expect(() => loadMasterKey({ masterKeyB64: null, dataDir: '/x/data', keyDir: '/x/data/keys' })).toThrow();
    expect(() => loadMasterKey({ masterKeyB64: null, dataDir: '/x/data', keyDir: '/x' })).toThrow();
    expect(() => loadMasterKey({ masterKeyB64: Buffer.alloc(5).toString('base64'), dataDir: '/x', keyDir: '/y' })).toThrow();
  });

  it('che định danh', () => {
    expect(maskIdentifier('nguyenvan@example.com')).toBe('ng***@e***.com');
    expect(maskIdentifier('abcd')).toBe('a***');
    expect(maskIdentifier('0912345678')).toBe('09***78');
  });
});

describe('bảo vệ request', () => {
  it('từ chối Host lạ (DNS rebinding) và Origin lạ trên request ghi dữ liệu (CSRF)', async () => {
    h = await makeHarness();
    const badHost = await h.app.inject({ method: 'GET', url: '/api/state', headers: { host: 'evil.example.com' } });
    expect(badHost.statusCode).toBe(403);

    const csrf = await h.call('POST', '/api/queue/stop', undefined, { origin: 'https://evil.example.com' });
    expect(csrf.status).toBe(403);
    const crossSite = await h.call('POST', '/api/queue/stop', undefined, { 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    const ok = await h.call('POST', '/api/queue/stop', undefined, { origin: `http://${HOST}` });
    expect(ok.status).toBe(200);
  });

  it('có MUSE_ACCESS_TOKEN thì chỉ chủ sở hữu đã đăng nhập mới dùng được API', async () => {
    h = await makeHarness({ MUSE_ACCESS_TOKEN: 'ma-truy-cap-dung' });
    expect((await h.call('GET', '/api/accounts')).status).toBe(401);
    expect((await h.call('POST', '/api/auth/login', { token: 'sai' })).status).toBe(401);

    const login = await h.call('POST', '/api/auth/login', { token: 'ma-truy-cap-dung' });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const session = cookie.split(';')[0]!;
    expect((await h.call('GET', '/api/accounts', undefined, { cookie: session })).status).toBe(200);
    expect((await h.call('GET', '/api/accounts', undefined, { cookie: 'muse_session=gia-mao' })).status).toBe(401);
  });

  it('khóa tạm khi đoán mã truy cập sai nhiều lần', async () => {
    h = await makeHarness({ MUSE_ACCESS_TOKEN: 'ma-dung' });
    for (let i = 0; i < 5; i++) await h.call('POST', '/api/auth/login', { token: `sai${i}` });
    expect((await h.call('POST', '/api/auth/login', { token: 'ma-dung' })).status).toBe(429);
  });

  it('không rò stack trace; dữ liệu sai trả lỗi tiếng Việt có cấu trúc', async () => {
    h = await makeHarness();
    const res = await h.call('POST', '/api/queue/enqueue', { prompts: [], options: { duration: 7, ratio: '4:3' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts|node_modules/);
    const malformed = await h.app.inject({ method: 'POST', url: '/api/queue/enqueue', headers: { host: HOST, 'content-type': 'application/json' }, payload: '{khong-phai-json' });
    expect(malformed.statusCode).toBe(400);
  });

  it('route ảnh không cho đọc ngoài kho (id không phải đường dẫn)', async () => {
    h = await makeHarness();
    for (const id of ['..%2F..%2Fpackage.json', '%2e%2e%2fmuse.sqlite', 'img_khongco']) {
      const res = await h.app.inject({ method: 'GET', url: `/api/images/${id}/file`, headers: { host: HOST } });
      expect(res.statusCode).toBe(404);
    }
  });

  it('chỉ nhận ảnh thật: file giả đuôi .png và SVG bị từ chối', async () => {
    h = await makeHarness();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const up = await h.upload([
      { name: 'x.png', data: svg, type: 'image/png' },
      { name: 'y.svg', data: svg, type: 'image/svg+xml' },
      { name: 'z.png', data: Buffer.from('MZ\x90\x00 exe giả dạng ảnh'), type: 'image/png' },
    ]);
    expect(up.body.staged).toEqual([]);
    expect(up.body.rejected).toHaveLength(3);
  });
});
