import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { makeHarness, HOST, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// Toàn bộ giá trị ở đây là giả, chỉ dùng cho test.
const COOKIE = 'datr=FAKE_DATR_VALUE_0123456789; sid=SECRET_SESSION_ID_ABCDEF; hatch=v1%3Axyz-FAKE';
const PIECES = ['FAKE_DATR_VALUE_0123456789', 'SECRET_SESSION_ID_ABCDEF', 'v1%3Axyz-FAKE'];

describe('đăng nhập bằng cookie', () => {
  it('thêm tài khoản bằng cookie; không lộ cookie ở API, DB, log', async () => {
    h = await makeHarness();
    const lines: string[] = [];
    const app = await buildApp(h.core, { logger: true, logStream: { write: (m) => void lines.push(m) } });
    await app.ready();
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/accounts', headers: { host: HOST, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });

    const res = await post({ method: 'cookie', cookie: COOKIE, label: 'Muse chính' });
    expect(res.statusCode).toBe(201);
    const acc = res.json().account;
    expect(acc).toMatchObject({ authMethod: 'cookie', online: true });
    expect(acc.maskedId).toMatch(/^Muse chính · [0-9a-f]{6}$/);

    // Cùng cookie, khác thứ tự và khoảng trắng: vẫn là một tài khoản.
    const dup = await post({ method: 'cookie', cookie: 'sid=SECRET_SESSION_ID_ABCDEF;   datr=FAKE_DATR_VALUE_0123456789; hatch=v1%3Axyz-FAKE' });
    expect(dup.statusCode).toBe(409);

    const bodies = [
      res.body,
      dup.body,
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: { host: HOST } })).body,
      (await app.inject({ method: 'GET', url: '/api/state', headers: { host: HOST } })).body,
    ];
    for (const bad of ['khong-phai-cookie', '', 'a=1\r\nb=2']) bodies.push((await post({ method: 'cookie', cookie: bad })).body);
    for (const body of bodies) for (const piece of PIECES) expect(body).not.toContain(piece);

    for (const f of walk(h.dataDir)) {
      const bytes = fs.readFileSync(f);
      for (const piece of PIECES) expect(bytes.includes(Buffer.from(piece)), `${f} chứa cookie`).toBe(false);
    }
    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    for (const piece of PIECES) expect(log).not.toContain(piece);
    await app.close();
  });

  it('cookie sai định dạng bị từ chối bằng thông báo tiếng Việt, không phản chiếu nội dung', async () => {
    h = await makeHarness();
    const r = await h.call('POST', '/api/accounts', { method: 'cookie', cookie: 'abc-SECRETVALUE-xyz' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('Cookie chưa đúng định dạng');
    expect(JSON.stringify(r.body)).not.toContain('SECRETVALUE');
    expect((await h.call('GET', '/api/accounts')).body.accounts).toEqual([]);
  });

  it('cookie bị nền tảng từ chối: vào pool ở trạng thái Offline, hướng dẫn thêm cookie mới', async () => {
    h = await makeHarness();
    const r = await h.call('POST', '/api/accounts', { method: 'cookie', cookie: 'sid=invalid-het-han' });
    expect(r.status).toBe(201);
    expect(r.body.account).toMatchObject({ online: false, sessionStatus: 'expired' });
    expect(r.body.account.sessionReason).toContain('cookie mới');
    const check = await h.call('POST', `/api/accounts/${r.body.account.id}/health`);
    expect(check.body.account.online).toBe(false);
  });

  it('request cũ không có "method" vẫn hiểu là tài khoản + mật khẩu', async () => {
    h = await makeHarness();
    const r = await h.call('POST', '/api/accounts', { identifier: 'cu@example.com', secret: 'mat-khau-cu-123' });
    expect(r.status).toBe(201);
    expect(r.body.account.authMethod).toBe('password');
  });

  it('tài khoản cookie nhận job như tài khoản thường', async () => {
    h = await makeHarness();
    await h.call('POST', '/api/accounts', { method: 'cookie', cookie: COOKIE });
    const id = (await h.call('POST', '/api/queue/enqueue', { prompts: ['thử cookie'], options: { duration: 10, ratio: '9:16' } })).body.taskIds[0];
    expect((await h.call('POST', '/api/queue/process')).status).toBe(200);
    await h.waitFor(() => h.core.jobs.find(id)!.status === 'completed');
  });

  it('DB tạo từ bản cũ (chưa có cột auth_kind) được nâng cấp, giữ nguyên tài khoản cũ', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-migrate-'));
    const old = new DatabaseSync(path.join(dir, 'muse.sqlite'));
    old.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, masked_id TEXT NOT NULL, identifier_hash TEXT NOT NULL UNIQUE, credentials_enc TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, slots INTEGER NOT NULL DEFAULT 1, session_status TEXT NOT NULL DEFAULT 'unknown', session_reason TEXT, last_health_at INTEGER, created_at INTEGER NOT NULL);
      INSERT INTO accounts(id, masked_id, identifier_hash, credentials_enc, created_at) VALUES('acc_old','ab***','h','x',1);`);
    old.close();
    const db = openDb(dir);
    const row = db.prepare('SELECT auth_kind FROM accounts WHERE id = ?').get('acc_old') as { auth_kind: string };
    expect(row.auth_kind).toBe('password');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
