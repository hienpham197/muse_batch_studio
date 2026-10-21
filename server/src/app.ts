import fs from 'node:fs';
import path from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { COOKIE_LIMITS, DURATIONS, JOB_STATUSES, LIMITS, RATIOS, type ErrorCode, type UploadRejection, type UploadResult } from '@muse/shared';
import type { MockAdapter, MockControl } from './adapters/mock.js';
import { OwnerAuth, parseCookie } from './auth.js';
import type { Core } from './core.js';
import { AppError, notFound } from './errors.js';
import { sendFile } from './http.js';
import { msg as imageMsg } from './images.js';

const COOKIE = 'muse_session';

const duration = z.union(DURATIONS.map((d) => z.literal(d)) as [z.ZodLiteral<5>, z.ZodLiteral<10>, z.ZodLiteral<15>]);
const ratio = z.enum(RATIOS);
const tagParam = z.string().min(1).max(LIMITS.maxTagLength);

function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const res = schema.safeParse(data);
  if (!res.success) throw validationError(res.error);
  return res.data;
}

function validationError(err: ZodError): AppError {
  return new AppError(400, 'VALIDATION', 'Dữ liệu gửi lên chưa hợp lệ. Hãy kiểm tra lại các trường được đánh dấu.', {
    fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** Request cũ không gửi `method` thì coi là đăng nhập bằng mật khẩu. */
function withDefaultMethod(body: unknown): unknown {
  return body && typeof body === 'object' && !('method' in body) ? { ...body, method: 'password' } : body;
}

export interface BuildAppOptions {
  logger?: boolean;
  /** Đích ghi log, dùng trong test để kiểm tra log không chứa credential. */
  logStream?: { write(msg: string): void };
  /** Bật route dev điều khiển adapter mô phỏng (AC-08). */
  devRoutes?: boolean;
}

export async function buildApp(core: Core, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { config } = core;
  const app = Fastify({
    logger: options.logger
      ? {
          level: 'info',
          stream: options.logStream,
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          serializers: {
            // Không log body / query: tránh vô tình ghi credential.
            req: (r: FastifyRequest) => ({ method: r.method, url: r.url.split('?')[0] }),
          },
        }
      : false,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  const auth = new OwnerAuth(config.accessToken);
  const allowedOrigins = new Set(config.allowedOrigins);
  const allowedHosts = new Set(config.allowedOrigins.map((o) => new URL(o).host));

  await app.register(fastifyMultipart, {
    limits: { fileSize: core.images.maxImageBytes, files: LIMITS.maxUploadFiles, fields: 10, parts: LIMITS.maxUploadFiles + 10 },
    throwFileSizeLimit: false,
  });

  // ---- bảo vệ request ----
  app.addHook('onRequest', async (req, reply) => {
    // Chống DNS rebinding: chỉ phục vụ các Host đã khai báo.
    if (!req.headers.host || !allowedHosts.has(req.headers.host)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Địa chỉ truy cập không được phép.' } });
    }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (unsafe) {
      // Chống CSRF: request ghi dữ liệu phải cùng origin.
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if ((origin && !allowedOrigins.has(origin)) || (!origin && site && site !== 'same-origin' && site !== 'none')) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Nguồn gửi request không được phép.' } });
      }
    }
    const url = req.url.split('?')[0]!;
    if (url.startsWith('/api/') && !url.startsWith('/api/auth/') && !auth.isValid(parseCookie(req.headers.cookie, COOKIE))) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Cần đăng nhập bằng mã truy cập để tiếp tục.' } });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      const e = validationError(err);
      return reply.code(e.status).send({ error: { code: e.code, message: e.message, details: e.details } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      const code: ErrorCode = 'VALIDATION';
      return reply.code(err.statusCode).send({ error: { code, message: 'Request không hợp lệ.' } });
    }
    // Không trả stack / chi tiết nội bộ ra ngoài.
    req.log.error({ msg: err.message, name: err.name }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Có lỗi hệ thống. Hãy thử lại sau.' } });
  });

  // ---- xác thực chủ sở hữu ----
  app.get('/api/auth/status', async (req) => ({
    required: auth.enabled,
    authenticated: auth.isValid(parseCookie(req.headers.cookie, COOKIE)),
  }));
  app.post('/api/auth/login', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(512) }), req.body);
    const result = auth.login(token, req.ip);
    if (result && 'locked' in result) {
      return reply.code(429).send({ error: { code: 'FORBIDDEN', message: 'Nhập sai quá nhiều lần. Hãy thử lại sau 1 phút.' } });
    }
    if (!result) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Mã truy cập chưa đúng.' } });
    reply.header('Set-Cookie', `${COOKIE}=${result.sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    return { ok: true };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    auth.logout(parseCookie(req.headers.cookie, COOKIE));
    reply.header('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  // ---- tổng quan ----
  app.get('/api/state', async () => core.getState());

  // ---- Account Pool ----
  app.get('/api/accounts', async () => ({ accounts: core.accounts.list() }));
  app.post('/api/accounts', async (req, reply) => {
    const body = parse(
      z.discriminatedUnion('method', [
        z.object({ method: z.literal('password').default('password'), identifier: z.string().trim().min(3).max(200), secret: z.string().min(4).max(4096) }),
        z.object({ method: z.literal('cookie'), cookie: z.string().min(1).max(COOKIE_LIMITS.maxBytes), label: z.string().trim().max(40).optional() }),
      ]),
      withDefaultMethod(req.body),
    );
    const account = await core.accounts.add(body);
    core.dispatcher.wake();
    return reply.code(201).send({ account });
  });
  app.patch('/api/accounts/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ enabled: z.boolean().optional(), slots: z.number().int().min(1).max(LIMITS.maxSlotsPerAccount).optional() }), req.body);
    if (body.slots !== undefined) core.accounts.setSlots(id, body.slots);
    const account = body.enabled !== undefined ? await core.accounts.setEnabled(id, body.enabled) : core.accounts.getPublic(id);
    core.dispatcher.wake();
    return { account };
  });
  app.delete('/api/accounts/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const { confirm } = parse(z.object({ confirm: z.enum(['true', 'false']).optional() }), req.query);
    if (confirm !== 'true') {
      throw new AppError(409, 'CONFIRM_REQUIRED', 'Xóa tài khoản không khôi phục được. Hãy xác nhận trước khi xóa.');
    }
    await core.accounts.remove(id);
    return { ok: true };
  });
  app.post('/api/accounts/:id/health', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    core.accounts.getPublic(id);
    await core.accounts.check(id, true);
    core.dispatcher.wake();
    return { account: core.accounts.getPublic(id) };
  });

  // ---- Kho ảnh tham chiếu ----
  app.get('/api/refs', async () => ({ refs: core.images.listRefs() }));

  app.post('/api/refs/upload', async (req) => {
    if (!req.isMultipart()) throw new AppError(400, 'VALIDATION', 'Hãy gửi ảnh dưới dạng multipart/form-data.');
    const result: UploadResult = { staged: [], rejected: [] };
    const taken = core.images.knownTags();
    for await (const part of req.files()) {
      const name = part.filename || 'anh';
      const buffer = await part.toBuffer();
      const reject = (code: UploadRejection['code'], message: string) => result.rejected.push({ fileName: name, code, message });
      if (part.file.truncated) {
        reject('IMAGE_TOO_LARGE', imageMsg.tooLarge(name, core.images.maxImageBytes));
        continue;
      }
      try {
        result.staged.push(await core.images.stage(buffer, name, taken));
      } catch (e) {
        if (e instanceof AppError && (e.code === 'IMAGE_INVALID_FORMAT' || e.code === 'IMAGE_TOO_LARGE')) reject(e.code, e.message);
        else throw e;
      }
    }
    return result;
  });

  app.post('/api/refs/commit', async (req) => {
    const body = parse(
      z.object({ items: z.array(z.object({ stagedId: z.string(), tag: z.string().max(200) })).min(1).max(LIMITS.maxUploadFiles) }),
      req.body,
    );
    return { results: core.images.commit(body.items) };
  });

  app.delete('/api/refs/staged/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await core.images.discardStaged(id);
    return { ok: true };
  });

  app.get('/api/refs/:tag', async (req) => {
    const { tag } = parse(z.object({ tag: tagParam }), req.params);
    const ref = core.images.getRef(tag);
    if (!ref) throw new AppError(404, 'REF_TAG_NOT_FOUND', `Tag @${tag.toLowerCase()} chưa có ảnh trong kho. Hãy thêm ảnh hoặc sửa tag.`);
    return { ref };
  });

  app.delete('/api/refs/:tag', async (req) => {
    const { tag } = parse(z.object({ tag: tagParam }), req.params);
    const { force } = parse(z.object({ force: z.enum(['true', 'false']).optional() }), req.query);
    return core.images.deleteRef(tag.toLowerCase(), force === 'true');
  });

  const imageRoute = (kind: 'file' | 'thumb') => async (req: FastifyRequest, reply: Parameters<typeof sendFile>[1]) => {
    const { id } = parse(z.object({ id: z.string().max(40) }), req.params);
    const row = core.images.getRow(id);
    if (!row) throw notFound('ảnh');
    const immutable = 'private, max-age=31536000, immutable';
    return kind === 'file'
      ? sendFile(req, reply, core.images.filePath(row), { contentType: row.mime, cacheControl: immutable })
      : sendFile(req, reply, core.images.thumbPath(row.id), { contentType: 'image/webp', cacheControl: immutable });
  };
  app.get('/api/images/:id/file', imageRoute('file'));
  app.get('/api/images/:id/thumb', imageRoute('thumb'));

  // ---- Cấu hình ----
  app.get('/api/settings', async () => ({ settings: core.settings.get() }));
  app.put('/api/settings', async (req) => {
    const body = parse(
      z.object({
        concurrency: z.number().int().min(1).max(LIMITS.maxConcurrency).optional(),
        maxRetries: z.number().int().min(0).max(LIMITS.maxRetries).optional(),
        timeoutMinutes: z.number().int().min(1).max(LIMITS.maxTimeoutMinutes).optional(),
        slotsPerAccount: z.number().int().min(1).max(LIMITS.maxSlotsPerAccount).optional(),
      }),
      req.body,
    );
    const settings = core.settings.set(body);
    core.dispatcher.wake();
    return { settings };
  });
  // setConcurrency(n): áp dụng ngay cho các lần gán tiếp theo.
  app.put('/api/settings/concurrency', async (req) => {
    const { n } = parse(z.object({ n: z.number().int().min(1).max(LIMITS.maxConcurrency) }), req.body);
    const settings = core.settings.set({ concurrency: n });
    core.dispatcher.wake();
    return { settings, concurrency: core.dispatcher.concurrency() };
  });

  // ---- Hàng đợi ----
  app.post('/api/queue/enqueue', async (req, reply) => {
    const body = parse(
      z.object({
        prompts: z.array(z.string().max(LIMITS.maxPromptLength * 2)).min(1).max(LIMITS.maxPromptsPerBatch * 2),
        options: z.object({ duration, ratio, sharedTag: z.string().max(LIMITS.maxTagLength).nullish() }),
      }),
      req.body,
    );
    const result = core.queue.enqueueBatch(body.prompts, { ...body.options, sharedTag: body.options.sharedTag?.toLowerCase() ?? null });
    return reply.code(201).send(result);
  });
  app.post('/api/queue/process', async () => {
    core.dispatcher.processQueue();
    return { ok: true, state: core.getState() };
  });
  app.post('/api/queue/stop', async () => ({ stopped: core.dispatcher.stopAll() }));
  app.post('/api/queue/clear-finished', async () => ({ cleared: core.queue.clearFinished() }));
  app.post('/api/jobs/delete-many', async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string()).min(1).max(1000) }), req.body);
    return { deleted: await core.queue.deleteWaiting(ids) };
  });

  app.get('/api/jobs', async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['all', ...JOB_STATUSES]).default('all'),
        search: z.string().max(200).default(''),
        source: z.enum(['all', 'batch', 'studio']).default('batch'),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().refine((n) => (LIMITS.pageSizes as readonly number[]).includes(n), 'Kích thước trang không hợp lệ').default(10),
      }),
      req.query,
    );
    return core.queue.list(q);
  });
  app.post('/api/jobs/:id/retry', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    core.dispatcher.retryJob(id);
    return { ok: true };
  });
  app.post('/api/jobs/:id/regenerate', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    return reply.code(201).send(core.queue.regenerate(id));
  });
  app.delete('/api/jobs/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await core.dispatcher.deleteJob(id);
    return { ok: true };
  });
  app.get('/api/jobs/:id/video', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const { download } = parse(z.object({ download: z.enum(['1']).optional() }), req.query);
    const job = core.jobs.find(id);
    const file = job && core.dispatcher.videoFilePath(job);
    if (!job || !file) throw notFound('video');
    return sendFile(req, reply, file, { contentType: 'video/mp4', cacheControl: 'private, max-age=300', downloadName: download ? `${job.id}.mp4` : undefined });
  });
  app.get('/api/jobs/:id/thumbnail', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const job = core.jobs.find(id);
    const file = job && core.dispatcher.thumbFilePath(job);
    if (!job || !file) throw notFound('thumbnail');
    return sendFile(req, reply, file, { contentType: 'image/jpeg', cacheControl: 'private, max-age=300' });
  });

  // ---- Flow Studio ----
  app.get('/api/studio/cards', async () => ({ cards: core.studio.list() }));
  app.post('/api/studio/cards', async (req, reply) => {
    const pos = z.object({ x: z.coerce.number().optional(), y: z.coerce.number().optional() });
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new AppError(400, 'VALIDATION', 'Chưa chọn ảnh.');
      const buffer = await file.toBuffer();
      if (file.file.truncated) throw new AppError(413, 'IMAGE_TOO_LARGE', imageMsg.tooLarge(file.filename, core.images.maxImageBytes));
      const fields = Object.fromEntries(Object.entries(file.fields).flatMap(([k, v]) => (v && !Array.isArray(v) && 'value' in v ? [[k, v.value]] : [])));
      const p = parse(pos, fields);
      const card = await core.studio.addFromUpload(buffer, file.filename || 'anh', p.x !== undefined && p.y !== undefined ? { x: p.x, y: p.y } : undefined);
      return reply.code(201).send({ card });
    }
    const body = parse(z.object({ tag: tagParam, x: z.number().optional(), y: z.number().optional() }), req.body);
    const card = await core.studio.addFromTag(body.tag, body.x !== undefined && body.y !== undefined ? { x: body.x, y: body.y } : undefined);
    return reply.code(201).send({ card });
  });
  app.patch('/api/studio/cards/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(
      z.object({ prompt: z.string().max(LIMITS.maxPromptLength).optional(), x: z.number().finite().optional(), y: z.number().finite().optional() }),
      req.body,
    );
    return { card: core.studio.update(id, body) };
  });
  app.delete('/api/studio/cards/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await core.studio.remove(id);
    return { ok: true };
  });
  const generateSchema = z.object({ duration, ratio });
  app.post('/api/studio/generate-all', async (req) => core.studio.generate(null, parse(generateSchema, req.body)));
  app.post('/api/studio/cards/:id/generate', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    core.studio.get(id);
    return core.studio.generate([id], parse(generateSchema, req.body));
  });

  // ---- dev / nghiệm thu với adapter mô phỏng ----
  if (options.devRoutes && core.adapter.simulated) {
    app.post('/api/dev/accounts/:id/session', async (req) => {
      const { id } = parse(z.object({ id: z.string() }), req.params);
      const { state } = parse(z.object({ state: z.enum(['ok', 'dropped', 'expired']) }), req.body);
      const session = core.accounts.sessionForDev(id);
      if (!session) throw notFound('session của tài khoản');
      (core.adapter as MockAdapter).control(session, state as MockControl);
      await core.accounts.check(id).catch(() => undefined);
      core.dispatcher.wake();
      return { account: core.accounts.getPublic(id) };
    });
  }

  // ---- giao diện web (bản build) ----
  if (config.webDist && fs.existsSync(path.join(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy tài nguyên.' } });
    });
  }

  return app;
}
