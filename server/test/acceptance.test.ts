import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppState, Job, JobListResult } from '@muse/shared';
import { makeHarness, png, type Harness } from './harness.js';

const OPTS = { duration: 10, ratio: '9:16' } as const;
let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

const enqueue = (prompts: string[], options: Record<string, unknown> = OPTS) => h.call('POST', '/api/queue/enqueue', { prompts, options });
const state = async () => (await h.call<AppState>('GET', '/api/state')).body;
const job = (id: string) => h.core.jobs.find(id)!;
const jobsOf = async (status = 'all', extra = '') => (await h.call<JobListResult>('GET', `/api/jobs?status=${status}&pageSize=50${extra}`)).body;

describe('AC-02 / AC-03: @mention và tag lạ', () => {
  it('job mang đúng file ảnh của tag santa (kiểm chứng ở dữ liệu job)', async () => {
    h = await makeHarness();
    await h.addRef('santa', '#aa0000');
    await h.addRef('x07', '#0000aa');
    const ref = (await h.call('GET', '/api/refs/santa')).body.ref;
    const res = await enqueue(['@santa đi trên tuyết cùng @x07 và @Santa']);
    expect(res.status).toBe(201);
    const stored = job(res.body.taskIds[0]);
    expect(stored.refTags).toEqual(['santa', 'x07']);
    expect(stored.refs[0]!.fileId).toBe(ref.id);
    expect(stored.refs.map((r) => r.tag)).toEqual(['santa', 'x07']);
  });

  it('tag chưa có ảnh: từ chối và không tạo job nào', async () => {
    h = await makeHarness();
    await h.addRef('santa');
    const res = await enqueue(['@santa ổn', '@khongco thiếu ảnh']);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REF_TAG_NOT_FOUND');
    expect(res.body.error.details.missingTags).toEqual(['khongco']);
    expect((await state()).counts.total).toBe(0);
  });

  it('ảnh dùng chung được thêm sau các ảnh @tag và không gắn trùng', async () => {
    h = await makeHarness();
    await h.addRef('santa');
    await h.addRef('bg');
    const res = await enqueue(['@santa a', 'b'], { ...OPTS, sharedTag: 'bg' });
    expect(res.body.jobs[0].refs.map((r: any) => r.tag)).toEqual(['santa', 'bg']);
    expect(res.body.jobs[1].refs.map((r: any) => r.tag)).toEqual(['bg']);
  });
});

describe('AC-04: upload nhiều ảnh', () => {
  it('5 file → 5 dòng chờ lưu, tag tự sinh, sửa tag, lưu một lần', async () => {
    h = await makeHarness();
    const names = ['Santa Claus.png', 'X07.jpg', 'Sevolra.webp', 'Chú Sói.png', 'santa claus.png'];
    const files = await Promise.all(names.map(async (name) => ({ name, data: await png() })));
    const up = await h.upload(files);
    expect(up.body.rejected).toEqual([]);
    expect(up.body.staged.map((s: any) => s.suggestedTag)).toEqual(['santa-claus', 'x07', 'sevolra', 'chu-soi', 'santa-claus-2']);

    const items = up.body.staged.map((s: any, i: number) => ({ stagedId: s.stagedId, tag: i === 0 ? 'santa' : s.suggestedTag }));
    const commit = await h.call('POST', '/api/refs/commit', { items });
    expect(commit.body.results.every((r: any) => r.ok)).toBe(true);
    const refs = (await h.call('GET', '/api/refs')).body.refs;
    expect(refs.map((r: any) => r.tag).sort()).toEqual(['chu-soi', 'santa', 'santa-claus-2', 'sevolra', 'x07']);
  });

  it('file lỗi bị từ chối riêng lẻ, không hủy cả đợt', async () => {
    h = await makeHarness();
    const up = await h.upload([
      { name: 'ok.png', data: await png() },
      { name: 'gia-mao.png', data: Buffer.from('đây không phải ảnh') },
      { name: 'qua-lon.png', data: Buffer.alloc(9 * 1024 * 1024, 1) },
    ]);
    expect(up.status).toBe(200);
    expect(up.body.staged.map((s: any) => s.fileName)).toEqual(['ok.png']);
    expect(up.body.rejected.map((r: any) => [r.fileName, r.code])).toEqual([
      ['gia-mao.png', 'IMAGE_INVALID_FORMAT'],
      ['qua-lon.png', 'IMAGE_TOO_LARGE'],
    ]);
    expect(up.body.rejected[1].message).toContain('8 MB');
  });

  it('tag trùng / không hợp lệ chặn đúng ảnh đó, ảnh khác vẫn lưu', async () => {
    h = await makeHarness();
    await h.addRef('santa');
    const up = await h.upload([
      { name: 'a.png', data: await png() },
      { name: 'b.png', data: await png() },
      { name: 'c.png', data: await png() },
    ]);
    const [a, b, c] = up.body.staged;
    const commit = await h.call('POST', '/api/refs/commit', {
      items: [
        { stagedId: a.stagedId, tag: 'santa' },
        { stagedId: b.stagedId, tag: 'Có Dấu' },
        { stagedId: c.stagedId, tag: 'hop-le' },
      ],
    });
    expect(commit.body.results.map((r: any) => [r.ok, r.code])).toEqual([
      [false, 'TAG_DUPLICATE'],
      [false, 'TAG_INVALID'],
      [true, undefined],
    ]);
    expect(commit.body.results[0].message).toContain('@santa');
  });

  it('xóa ảnh đang được job chờ dùng cần xác nhận; job mất ảnh bị báo lỗi rõ ràng', async () => {
    h = await makeHarness();
    await h.addAccounts(1);
    await h.addRef('santa');
    const { body } = await enqueue(['@santa']);
    const del = await h.call('DELETE', '/api/refs/santa');
    expect(del.status).toBe(409);
    expect(del.body.error.details.affectedJobs).toBe(1);
    expect((await h.call('DELETE', '/api/refs/santa?force=true')).status).toBe(200);

    await h.call('POST', '/api/queue/process');
    const id = body.taskIds[0];
    await h.waitFor(() => job(id).status === 'failed', 5000, 'job mất ảnh thất bại');
    expect(job(id).error?.code).toBe('REF_MISSING');
    expect(job(id).error?.message).toContain('@santa');
  });
});

describe('Account Pool và dispatcher', () => {
  it('chưa có tài khoản Online: chặn chạy và báo rõ, không để job treo ở "Đang chạy"', async () => {
    h = await makeHarness();
    await enqueue(['a']);
    const res = await h.call('POST', '/api/queue/process');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_ONLINE_ACCOUNT');
    const s = await state();
    expect(s.dispatcherRunning).toBe(false);
    expect(s.counts.running).toBe(0);
    expect(s.counts.waiting).toBe(1);
  });

  it('AC-06: 6 video với 3 tài khoản → tối đa 3 chạy cùng lúc, cuốn chiếu tới khi hết', async () => {
    h = await makeHarness({}, { speed: 25 });
    await h.addAccounts(3);
    await h.call('PUT', '/api/settings/concurrency', { n: 6 });
    await enqueue(Array.from({ length: 6 }, (_, i) => `video ${i + 1}`));
    await h.call('POST', '/api/queue/process');

    let peak = 0;
    const seenAccounts = new Set<string>();
    await h.waitFor(async () => {
      const s = await state();
      peak = Math.max(peak, s.runningJobs.length);
      s.runningJobs.forEach((j) => seenAccounts.add(j.accountId!));
      expect(s.runningJobs.length).toBeLessThanOrEqual(3);
      expect(s.concurrency.effective).toBe(3);
      return s.counts.completed === 6;
    }, 20_000, '6 job hoàn thành');
    expect(peak).toBe(3);
    expect(seenAccounts.size).toBe(3);
    expect((await state()).dispatcherRunning).toBe(false);
  });

  it('hạ số luồng xuống 1 thì chỉ còn 1 job chạy ở các lần gán sau', async () => {
    h = await makeHarness({}, { speed: 25 });
    await h.addAccounts(3);
    await h.call('PUT', '/api/settings/concurrency', { n: 1 });
    await enqueue(['a', 'b', 'c']);
    await h.call('POST', '/api/queue/process');
    let peak = 0;
    await h.waitFor(async () => {
      const s = await state();
      peak = Math.max(peak, s.runningJobs.length);
      return s.counts.completed === 3;
    });
    expect(peak).toBe(1);
  });

  it('AC-08: tài khoản rơi giữa chừng → job được gán lại, hoàn thành, không mất / không trùng', async () => {
    h = await makeHarness({}, { speed: 8 });
    const [a, b] = await h.addAccounts(2);
    await h.call('PUT', '/api/settings/concurrency', { n: 2 });
    const { body } = await enqueue(['một', 'hai', 'ba', 'bốn']);
    await h.call('POST', '/api/queue/process');

    await h.waitFor(async () => (await state()).runningJobs.length === 2, 5000, '2 job đang chạy');
    const onA = (await state()).runningJobs.filter((j) => j.accountId === a).map((j) => j.id);
    expect(onA).toHaveLength(1);

    await h.call('POST', `/api/dev/accounts/${a}/session`, { state: 'dropped' });
    await h.waitFor(async () => (await state()).counts.completed === 4, 20_000, '4 job hoàn thành');

    const all = (body.taskIds as string[]).map(job);
    expect(all.every((j) => j.status === 'completed')).toBe(true);
    expect(new Set(all.map((j) => j.id)).size).toBe(4);
    expect(job(onA[0]!).accountId).toBe(b);
    expect(fs.readdirSync(path.join(h.dataDir, 'videos')).sort()).toEqual(body.taskIds.map((id: string) => `${id}.mp4`).sort());
    const accounts = (await h.call('GET', '/api/accounts')).body.accounts;
    expect(accounts.find((x: any) => x.id === a).online).toBe(false);
  });

  it('AC-08: tắt tài khoản đang chạy cũng gán lại job', async () => {
    h = await makeHarness({}, { speed: 8 });
    const [a] = await h.addAccounts(2);
    await h.call('PUT', '/api/settings/concurrency', { n: 2 });
    await enqueue(['một', 'hai']);
    await h.call('POST', '/api/queue/process');
    await h.waitFor(async () => (await state()).runningJobs.length === 2);
    const res = await h.call('PATCH', `/api/accounts/${a}`, { enabled: false });
    expect(res.body.account.enabled).toBe(false);
    await h.waitFor(async () => (await state()).counts.completed === 2, 20_000);
    expect((await jobsOf('completed')).items.every((j) => j.accountId !== a)).toBe(true);
  });

  it('AC-09: job lỗi tự retry tới N lần rồi mới "Thất bại" kèm mã lỗi gốc', async () => {
    h = await makeHarness({}, { speed: 40 });
    await h.addAccounts(1);
    const { body } = await enqueue(['[lỗi] luôn lỗi']);
    const id = body.taskIds[0];
    await h.call('POST', '/api/queue/process');
    await h.waitFor(() => {
      h.clock.offset += 5000; // bỏ qua thời gian chờ giữa các lần retry
      return job(id).status === 'failed';
    }, 20_000);
    const j = job(id);
    expect(j.attempts).toBe(2);
    expect(j.error?.originalCode).toBe('MOCK_GENERATION_FAILED');
    expect(j.error?.message).toContain('2/2');
  });

  it('AC-09: marker tiếng Anh [fail] hoạt động như [lỗi]', async () => {
    h = await makeHarness({}, { speed: 40 });
    await h.addAccounts(1);
    const id = (await enqueue(['[fail] always fails'])).body.taskIds[0];
    await h.call('POST', '/api/queue/process');
    await h.waitFor(() => {
      h.clock.offset += 5000;
      return job(id).status === 'failed';
    }, 20_000);
    expect(job(id).error?.originalCode).toBe('MOCK_GENERATION_FAILED');
  });

  it('AC-09: lỗi lần đầu rồi chạy lại thành công', async () => {
    h = await makeHarness({}, { speed: 40 });
    await h.addAccounts(1);
    const id = (await enqueue(['[lỗi-lần-đầu] thử lại'])).body.taskIds[0];
    await h.call('POST', '/api/queue/process');
    await h.waitFor(() => {
      h.clock.offset += 5000;
      return job(id).status === 'completed';
    });
    expect(job(id).attempts).toBe(1);
    expect(job(id).error).toBeNull();
  });

  it('AC-09: job treo quá X phút bị timeout, giải phóng slot và chạy lại được', async () => {
    h = await makeHarness({}, { speed: 40 });
    await h.addAccounts(1);
    const id = (await enqueue(['[treo] không báo tiến độ'])).body.taskIds[0];
    await h.call('POST', '/api/queue/process');
    await h.waitFor(() => job(id).status === 'running' && job(id).progress >= 10, 10_000, 'job đã chạy');
    // Chờ mock thôi báo tiến độ (treo ở 30%) rồi mới đẩy đồng hồ, tránh một lần báo muộn làm mới mốc tiến độ.
    await new Promise((r) => setTimeout(r, 500));

    h.clock.offset += 16 * 60_000;
    await h.waitFor(() => job(id).timedOut, 5000, 'job bị đánh dấu timeout');
    expect(job(id).error?.code).toBe('JOB_TIMEOUT');
    expect(h.core.jobs.runningCountByAccount((await h.call('GET', '/api/accounts')).body.accounts[0].id)).toBeLessThanOrEqual(1);

    // Hết N lần thì thất bại với JOB_TIMEOUT, và người dùng chạy lại được.
    await h.waitFor(() => {
      h.clock.offset += 16 * 60_000;
      return job(id).status === 'failed';
    }, 15_000, 'hết lượt retry');
    expect(job(id).error?.code).toBe('JOB_TIMEOUT');
    const retry = await h.call('POST', `/api/jobs/${id}/retry`);
    expect(retry.status).toBe(200);
    expect(['waiting', 'running']).toContain(job(id).status);
    expect(job(id).attempts).toBe(0);
  });

  it('rate limit: dispatcher giảm nhịp, tự thử lại và không tốn lượt retry', async () => {
    h = await makeHarness({}, { speed: 40 });
    await h.addAccounts(1);
    const id = (await enqueue(['[giới-hạn] bị giới hạn một lần'])).body.taskIds[0];
    await h.call('POST', '/api/queue/process');
    await h.waitFor(() => h.core.dispatcher.blocked() === 'cooldown', 5000, 'vào cooldown');
    expect((await state()).dispatcherBlocked).toBe('cooldown');
    await h.waitFor(() => {
      h.clock.offset += 6000;
      return job(id).status === 'completed';
    });
    expect(job(id).attempts).toBe(0);
  });

  it('Dừng tất cả: job đang chạy → Đã dừng, job chờ giữ nguyên và không tự chạy lại', async () => {
    h = await makeHarness({}, { speed: 5 });
    await h.addAccounts(1);
    const ids = (await enqueue(['một', 'hai', 'ba'])).body.taskIds as string[];
    await h.call('POST', '/api/queue/process');
    await h.waitFor(async () => (await state()).runningJobs.length === 1);
    const stop = await h.call('POST', '/api/queue/stop');
    expect(stop.body.stopped).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    const s = await state();
    expect(s.counts).toMatchObject({ stopped: 1, waiting: 2, running: 0 });
    expect(s.dispatcherRunning).toBe(false);
    expect(job(ids[0]!).status).toBe('stopped');

    expect((await h.call('POST', `/api/jobs/${ids[0]}/retry`)).status).toBe(200);
    expect((await h.call('POST', `/api/jobs/${ids[1]}/retry`)).status).toBe(409);
  });

  it('thêm batch mới khi đang chạy: dispatcher tự nhận job mới', async () => {
    h = await makeHarness({}, { speed: 25 });
    await h.addAccounts(1);
    await enqueue(['một']);
    await h.call('POST', '/api/queue/process');
    await h.waitFor(async () => (await state()).runningJobs.length === 1);
    await enqueue(['hai']);
    await h.waitFor(async () => (await state()).counts.completed === 2, 20_000);
  });

  it('tài khoản bị từ chối đăng nhập vẫn vào pool nhưng Offline kèm lý do; không nhận job', async () => {
    h = await makeHarness();
    const res = await h.call('POST', '/api/accounts', { identifier: 'sai@example.com', secret: 'invalid-secret' });
    expect(res.status).toBe(201);
    expect(res.body.account).toMatchObject({ online: false, sessionStatus: 'expired' });
    expect(res.body.account.sessionReason).toBeTruthy();
    await enqueue(['a']);
    expect((await h.call('POST', '/api/queue/process')).status).toBe(409);
  });

  it('xóa tài khoản cần xác nhận, không trùng tài khoản', async () => {
    h = await makeHarness();
    const [id] = await h.addAccounts(1);
    const dup = await h.call('POST', '/api/accounts', { identifier: 'NGUOI0@example.com', secret: 'khac-nhau-1234' });
    expect(dup.status).toBe(409);
    expect((await h.call('DELETE', `/api/accounts/${id}`)).status).toBe(409);
    expect((await h.call('DELETE', `/api/accounts/${id}?confirm=true`)).status).toBe(200);
    expect((await h.call('GET', '/api/accounts')).body.accounts).toEqual([]);
  });
});

describe('AC-07 / AC-10: xem trước, tải, danh sách', () => {
  it('video phát được qua Range, tải đúng file, thumbnail có thật', async () => {
    h = await makeHarness({}, { speed: 60 });
    await h.addAccounts(1);
    const id = (await enqueue(['xem thử'])).body.taskIds[0];
    await h.call('POST', '/api/queue/process');
    await h.waitFor(() => job(id).status === 'completed');

    const full = await h.app.inject({ method: 'GET', url: `/api/jobs/${id}/video?download=1`, headers: { host: 'localhost:8787' } });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(String(full.headers['content-disposition'])).toContain(`${id}.mp4`);
    expect(full.rawPayload.equals(fs.readFileSync(path.join(h.dataDir, 'videos', `${id}.mp4`)))).toBe(true);
    expect(full.rawPayload.subarray(4, 8).toString()).toBe('ftyp');

    const part = await h.app.inject({ method: 'GET', url: `/api/jobs/${id}/video`, headers: { host: 'localhost:8787', range: 'bytes=0-99' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload).toHaveLength(100);
    expect(part.headers['content-range']).toMatch(/^bytes 0-99\/\d+$/);

    const thumb = await h.app.inject({ method: 'GET', url: `/api/jobs/${id}/thumbnail`, headers: { host: 'localhost:8787' } });
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    expect(thumb.rawPayload[0]).toBe(0xff);

    const listed = (await jobsOf('completed')).items[0]!;
    expect(listed.videoUrl).toBe(`/api/jobs/${id}/video`);
    expect(listed.progress).toBe(100);
    expect(listed.quality).toBe('HD');
  });

  it('lọc theo tab, bộ đếm, tìm theo Task ID / prompt không dấu, phân trang', async () => {
    h = await makeHarness();
    const prompts = Array.from({ length: 12 }, (_, i) => (i === 3 ? 'Cô gái chạy trên đồi' : `prompt ${i + 1}`));
    const created = (await enqueue(prompts)).body.taskIds as string[];

    const p1 = (await h.call<JobListResult>('GET', '/api/jobs?pageSize=10&page=1')).body;
    expect(p1).toMatchObject({ page: 1, pageSize: 10, totalPages: 2, filteredTotal: 12 });
    expect(p1.items).toHaveLength(10);
    expect(p1.items.map((j) => j.id)).toEqual(created.slice(0, 10));
    expect((await h.call<JobListResult>('GET', '/api/jobs?pageSize=10&page=2')).body.items).toHaveLength(2);
    expect(p1.counts).toMatchObject({ total: 12, waiting: 12, running: 0, completed: 0 });

    const byId = await jobsOf('all', `&search=${created[5]}`);
    expect(byId.items.map((j) => j.id)).toEqual([created[5]]);
    const byText = await jobsOf('all', `&search=${encodeURIComponent('co gai CHAY')}`);
    expect(byText.items.map((j) => j.id)).toEqual([created[3]]);
    expect((await jobsOf('failed')).items).toEqual([]);
    expect((await h.call('GET', '/api/jobs?pageSize=7')).status).toBe(400);
  });

  it('"Dọn mục đã xong" chỉ ẩn khỏi danh sách, video vẫn xem lại được', async () => {
    h = await makeHarness({}, { speed: 60 });
    await h.addAccounts(1);
    const id = (await enqueue(['xong'])).body.taskIds[0];
    await h.call('POST', '/api/queue/process');
    await h.waitFor(() => job(id).status === 'completed');
    expect((await h.call('POST', '/api/queue/clear-finished')).body.cleared).toBe(1);
    expect((await jobsOf()).items).toEqual([]);
    expect((await h.call('GET', `/api/jobs/${id}/video`)).status).toBe(200);
  });

  it('Hoàn tác chỉ xóa job còn chờ', async () => {
    h = await makeHarness({}, { speed: 5 });
    await h.addAccounts(1);
    const ids = (await enqueue(['một', 'hai'])).body.taskIds as string[];
    await h.call('POST', '/api/queue/process');
    await h.waitFor(async () => (await state()).runningJobs.length === 1);
    const res = await h.call('POST', '/api/jobs/delete-many', { ids });
    expect(res.body.deleted).toBe(1);
    expect(job(ids[0]!).status).toBe('running');
    expect(h.core.jobs.find(ids[1]!)).toBeUndefined();
  });
});

describe('AC-11: Flow Studio', () => {
  it('thêm ảnh → thẻ không chồng nhau, kéo-thả lưu vị trí, Tạo tất cả ra video trên từng thẻ', async () => {
    h = await makeHarness({}, { speed: 40 });
    await h.addAccounts(2);
    await h.addRef('santa');

    const a = (await h.upload([{ name: 'a.png', data: await png('#112233') }], '/api/studio/cards')).body.card;
    const b = (await h.upload([{ name: 'b.png', data: await png('#332211') }], '/api/studio/cards')).body.card;
    const c = (await h.call('POST', '/api/studio/cards', { tag: 'santa' })).body.card;
    expect(c.inputTag).toBe('santa');
    const overlap = (p: any, q: any) => Math.abs(p.x - q.x) < 320 && Math.abs(p.y - q.y) < 470;
    expect(overlap(a, b) || overlap(a, c) || overlap(b, c)).toBe(false);

    const moved = (await h.call('PATCH', `/api/studio/cards/${a.id}`, { x: 500, y: 120, prompt: '@santa chào' })).body.card;
    expect([moved.x, moved.y, moved.prompt]).toEqual([500, 120, '@santa chào']);
    await h.call('PATCH', `/api/studio/cards/${b.id}`, { prompt: 'cảnh biển' });

    const gen = await h.call('POST', '/api/studio/generate-all', OPTS);
    expect(gen.status).toBe(200);
    expect(gen.body.queued.sort()).toEqual([a.id, b.id].sort());
    expect(gen.body.skipped.map((s: any) => s.cardId)).toEqual([c.id]); // thẻ chưa có prompt

    await h.waitFor(async () => {
      const cards = (await h.call('GET', '/api/studio/cards')).body.cards as any[];
      return cards.filter((x) => x.status === 'done').length === 2;
    }, 20_000);
    const cards = (await h.call('GET', '/api/studio/cards')).body.cards as any[];
    const done = cards.find((x) => x.id === a.id);
    expect(done).toMatchObject({ status: 'done', quality: 'HD', x: 500 });
    expect(done.videoUrl).toMatch(/^\/api\/jobs\/task_/);
    expect(cards.find((x) => x.id === c.id).status).toBe('idle');

    // Job của Studio không lẫn vào danh sách Batch nhưng vẫn nằm trong bộ đếm chung.
    expect((await jobsOf()).items).toEqual([]);
    expect((await state()).counts.completed).toBe(2);
    // Ảnh đầu vào của thẻ đi vào job trước các @tag.
    const stored = h.core.jobs.find(done.jobId)!;
    expect(stored.refs.map((r) => r.tag)).toEqual(['', 'santa']);
  });

  it('một thẻ lỗi không chặn thẻ còn lại; Tạo tất cả chặn khi không có tài khoản Online', async () => {
    h = await makeHarness({}, { speed: 40 });
    const a = (await h.upload([{ name: 'a.png', data: await png() }], '/api/studio/cards')).body.card;
    await h.call('PATCH', `/api/studio/cards/${a.id}`, { prompt: 'x' });
    const none = await h.call('POST', '/api/studio/generate-all', OPTS);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NO_ONLINE_ACCOUNT');

    await h.addAccounts(1);
    const b = (await h.upload([{ name: 'b.png', data: await png() }], '/api/studio/cards')).body.card;
    await h.call('PATCH', `/api/studio/cards/${a.id}`, { prompt: '[lỗi] hỏng' });
    await h.call('PATCH', `/api/studio/cards/${b.id}`, { prompt: 'ổn' });
    await h.call('POST', '/api/studio/generate-all', OPTS);
    await h.waitFor(async () => {
      h.clock.offset += 5000;
      const cards = (await h.call('GET', '/api/studio/cards')).body.cards as any[];
      return cards.find((x) => x.id === a.id).status === 'error' && cards.find((x) => x.id === b.id).status === 'done';
    }, 20_000);
  });
});

describe('Trạng thái tổng quan (getState)', () => {
  it('đủ dữ liệu để render header, tabs và dải trực tiếp trong một request', async () => {
    h = await makeHarness({}, { speed: 5 });
    await h.addAccounts(2);
    await h.addRef('santa');
    await enqueue(['một', 'hai', 'ba']);
    await h.call('POST', '/api/queue/process');
    await h.waitFor(async () => (await state()).runningJobs.length === 2);
    const s = await state();
    expect(s).toMatchObject({
      online: true,
      simulated: true,
      dispatcherRunning: true,
      refCount: 1,
      accounts: { total: 2, enabled: 2, online: 2 },
      counts: { running: 2, waiting: 1, total: 3 },
      concurrency: { configured: 3, effective: 2, onlineAccounts: 2 },
    });
    const live = s.runningJobs as Job[];
    expect(live.every((j) => j.status === 'running' && typeof j.elapsedSec === 'number' && j.accountLabel)).toBe(true);
  });
});

describe('Tạo lại job', () => {
  it('job hoàn thành: tạo job mới cùng prompt, ảnh, độ dài, tỉ lệ; video cũ được giữ', async () => {
    h = await makeHarness();
    await h.addAccounts(1);
    await h.addRef('santa');
    const { body } = await enqueue(['@santa chạy trên cát'], { duration: 15, ratio: '16:9' });
    const oldId = body.taskIds[0];
    await h.call('POST', '/api/queue/process');
    await h.waitFor(() => job(oldId).status === 'completed', 8000, 'job hoàn thành');

    const res = await h.call('POST', `/api/jobs/${oldId}/regenerate`);
    expect(res.status).toBe(201);
    const newId: string = res.body.taskIds[0];
    expect(newId).not.toBe(oldId);
    const fresh = job(newId);
    expect([fresh.prompt, fresh.duration, fresh.ratio, fresh.refTags]).toEqual(['@santa chạy trên cát', 15, '16:9', ['santa']]);
    expect(fresh.refs[0]!.fileId).toBe(job(oldId).refs[0]!.fileId);
    expect(fresh.attempts).toBe(0);
    expect(job(oldId).status).toBe('completed');
    expect(job(oldId).videoFile).toBeTruthy();

    await h.waitFor(() => job(newId).status === 'completed', 8000, 'job tạo lại hoàn thành');
    expect(job(newId).videoFile).not.toBe(job(oldId).videoFile);
  });

  it('khi job tạo lại còn chờ hoặc chạy: khóa tạo lại và chạy lại job gốc, job mới ghi rõ nguồn', async () => {
    h = await makeHarness();
    const [accId] = await h.addAccounts(1);
    await h.addRef('santa');
    const { body } = await enqueue(['@santa']);
    const id = body.taskIds[0];
    await h.call('POST', '/api/queue/process');
    await h.waitFor(() => job(id).status === 'completed', 8000);
    // Tắt tài khoản để job tạo lại nằm ở trạng thái chờ, không chạy mất.
    await h.call('PATCH', `/api/accounts/${accId}`, { enabled: false });

    const first = await h.call('POST', `/api/jobs/${id}/regenerate`);
    expect(first.status).toBe(201);
    const childId: string = first.body.taskIds[0];

    const again = await h.call('POST', `/api/jobs/${id}/regenerate`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('REGEN_PENDING');
    expect((await jobsOf('all')).items.filter((j) => j.prompt === '@santa')).toHaveLength(2); // không sinh job trùng

    const list = (await jobsOf('all')).items;
    expect(list.find((j) => j.id === id)).toMatchObject({ regenerating: true, regenOf: null });
    expect(list.find((j) => j.id === childId)).toMatchObject({ regenerating: false, regenOf: id });

    // Job gốc thất bại / dừng cũng không chạy lại được khi đang có job tạo lại.
    h.core.jobs.patch(id, { status: 'failed', error: JSON.stringify({ code: 'JOB_FAILED', message: 'x' }) });
    const retry = await h.call('POST', `/api/jobs/${id}/retry`);
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('REGEN_PENDING');

    // Xóa job tạo lại thì job gốc được mở khóa.
    await h.call('DELETE', `/api/jobs/${childId}`);
    expect((await jobsOf('all')).items.find((j) => j.id === id)).toMatchObject({ regenerating: false });
    expect((await h.call('POST', `/api/jobs/${id}/retry`)).status).toBe(200);
  });

  it('từ chối job đang chờ, job không tồn tại và job mất ảnh trong kho', async () => {
    h = await makeHarness();
    await h.addAccounts(1);
    await h.addRef('santa');
    const { body } = await enqueue(['@santa']);
    const id = body.taskIds[0];
    expect((await h.call('POST', `/api/jobs/${id}/regenerate`)).status).toBe(409);
    expect((await h.call('POST', '/api/jobs/task_none/regenerate')).status).toBe(404);

    await h.call('POST', '/api/queue/process');
    await h.waitFor(() => job(id).status === 'completed', 8000);
    await h.call('DELETE', '/api/refs/santa?force=true');
    const res = await h.call('POST', `/api/jobs/${id}/regenerate`);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('@santa');
  });
});
