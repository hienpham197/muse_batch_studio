/// <reference lib="dom" />
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import sharp from 'sharp';
import { parseCookies } from '@muse/shared';
import { newId, sleep } from '../util.js';
import {
  AuthError,
  WorkerError,
  type Credentials,
  type GenerateHooks,
  type GenerateSpec,
  type GeneratedVideo,
  type HealthResult,
  type PlatformAdapter,
  type SessionHandle,
} from './types.js';

const execFileP = promisify(execFile);

/**
 * Muse không có API công khai: chat đi qua WebSocket mã hóa do chính trang web xử lý. Adapter này
 * điều khiển một Chrome thật đã đăng nhập (Playwright): đính ảnh vào khung soạn, gõ prompt, chờ Muse
 * trả video rồi tải file về. Các selector lấy từ dự án duclm1x1/Muse-Chat-MCP (MIT).
 */
export const MUSE_SELECTORS = {
  composerRoot: '[data-hatch-composer-root]',
  editor: '[data-lexical-editor="true"], [data-hatch-composer-root] textarea, [data-hatch-composer-prehydration-input], [data-hatch-composer-root] [contenteditable="true"]',
  stopButton: '[data-testid="hatch-composer-stop-button"]',
  fileInput: '[data-hatch-composer-root] input[type="file"]',
  assistant: '[data-message-item][data-message-role="assistant"]',
  errorNotice: '[data-testid="assistant-response-error-notice"]',
} as const;

export interface MuseBrowserOptions {
  /** Địa chỉ gốc của Muse. */
  baseUrl: string;
  /** Gắn vào Chrome đang chạy với --remote-debugging-port (dùng luôn phiên đã đăng nhập). */
  cdpUrl: string | null;
  /** Thư mục profile Chrome riêng của app: đăng nhập Muse một lần, phiên được giữ lại. Dùng khi không có cdpUrl. */
  profileDir: string | null;
  /** Chế độ profile: chờ người dùng đăng nhập trong cửa sổ Chrome tối đa bao lâu. */
  loginWaitMs: number;
  /** `chrome` hoặc `msedge`. */
  channel: string;
  headless: boolean;
  tmpDir: string;
  /** Giới hạn cứng cho một lần tạo, chặn trường hợp trang treo mà dispatcher chưa kịp báo timeout. */
  maxWaitMs: number;
  /** Sau khi Muse ngừng trả lời mà chưa có video, chờ thêm bao lâu trước khi coi là không ra video. */
  idleGraceMs: number;
  /** Thư mục lưu ảnh chụp màn hình khi lỗi, để đối chiếu selector. Bỏ trống thì không chụp. */
  debugDir: string | null;
}

interface Session {
  context: BrowserContext;
  page: Page;
  /** Context do adapter tạo (đóng được) hay của người dùng (chỉ ngắt kết nối). */
  owned: boolean;
  lock: Promise<unknown>;
}

const RATE_LIMIT_RE = /rate.?limit|too many (requests|generations)|quota|usage limit|try again later|vượt (quá )?giới hạn|đạt giới hạn|quá nhiều/i;
const MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const DURATION_HINT_RE = /\b\d+\s*-?\s*(s|sec|secs|second|seconds|giây)\b/i;

/**
 * Gửi prompt NGUYÊN VĂN (giữ xuống dòng, không bọc thêm lời mở đầu) để Muse đọc đúng cấu trúc người dùng viết.
 * Chỉ nối thêm cuối prompt những thứ Muse không có chỗ khai báo riêng: độ dài / tỉ lệ nếu prompt chưa nói,
 * và thứ tự ảnh tham chiếu (tên file ảnh cũng chính là tag).
 */
export function buildMusePrompt(spec: Pick<GenerateSpec, 'prompt' | 'duration' | 'ratio' | 'refImages'>): string {
  const body = spec.prompt.replace(/\r\n?/g, '\n').trim();
  const notes: string[] = [];
  const specs: string[] = [];
  if (!DURATION_HINT_RE.test(body)) specs.push(`${spec.duration} seconds`);
  if (!body.includes(spec.ratio)) specs.push(`aspect ratio ${spec.ratio}`);
  if (specs.length > 0) notes.push(`Video specs: ${specs.join(', ')}.`);
  if (spec.refImages.length > 0) {
    notes.push(`Reference images are attached in this order, each file named after its @tag: ${spec.refImages.map((r, i) => `${i + 1}) @${r.tag}`).join(', ')}.`);
  }
  return notes.length > 0 ? `${body}\n\n${notes.join(' ')}` : body;
}

export class MuseBrowserAdapter implements PlatformAdapter {
  readonly name = 'muse';
  readonly simulated = false;
  readonly reportsProgress = false;
  private browser: Browser | null = null;
  /** Chế độ profile: context bền vững, không có đối tượng Browser. */
  private persistent: BrowserContext | null = null;
  private browserStarting: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, Session>();
  private ffmpegOk: boolean | null = null;

  constructor(private readonly opts: MuseBrowserOptions) {}

  // ---- trình duyệt ----

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browserStarting ??= (async () => {
      try {
        const b = this.opts.cdpUrl
          ? await chromium.connectOverCDP(this.opts.cdpUrl)
          : await chromium.launch({ channel: this.opts.channel, headless: this.opts.headless, args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'] });
        b.on('disconnected', () => {
          if (this.browser === b) this.browser = null;
        });
        this.browser = b;
        return b;
      } finally {
        this.browserStarting = null;
      }
    })();
    try {
      return await this.browserStarting;
    } catch (e) {
      const hint = this.opts.cdpUrl
        ? `Không kết nối được Chrome tại ${this.opts.cdpUrl}. Mở Chrome bằng lệnh có --remote-debugging-port=9222 rồi đăng nhập Muse.`
        : `Không mở được trình duyệt "${this.opts.channel}". Cài Google Chrome hoặc đặt MUSE_CHANNEL=msedge.`;
      throw new AuthError(`${hint} (${(e as Error).message.split('\n')[0]})`);
    }
  }

  /** Chrome headless tự khai "HeadlessChrome" trong User-Agent; đổi về dạng Chrome thường. */
  private headlessSafeUserAgent(browser: Browser): string {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
  }

  private async ensurePersistent(): Promise<BrowserContext> {
    if (this.persistent) return this.persistent;
    try {
      const ctx = await chromium.launchPersistentContext(this.opts.profileDir!, {
        channel: this.opts.channel,
        headless: this.opts.headless,
        viewport: { width: 1366, height: 900 },
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
      });
      ctx.on('close', () => {
        if (this.persistent === ctx) this.persistent = null;
      });
      this.persistent = ctx;
      return ctx;
    } catch (e) {
      throw new AuthError(`Không mở được Chrome với profile ${this.opts.profileDir}. Đóng cửa sổ Chrome đang dùng profile này rồi thử lại. (${(e as Error).message.split('\n')[0]})`);
    }
  }

  private async probeAuth(page: Page): Promise<{ ok: boolean; status: number }> {
    return page.evaluate(async () => {
      try {
        const res = await fetch('/api/auth/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' });
        const j = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        return { ok: !!j?.ok, status: res.status };
      } catch {
        return { ok: false, status: 0 };
      }
    });
  }

  // ---- PlatformAdapter ----

  async login(credentials: Credentials): Promise<SessionHandle> {
    const attach = this.opts.cdpUrl !== null;
    const profile = !attach && this.opts.profileDir !== null;
    const shared = attach || profile; // dùng chung một phiên đăng nhập có sẵn, bỏ qua giá trị credential
    if (!shared && credentials.kind !== 'cookie') {
      throw new AuthError('Muse đăng nhập qua Meta nên chỉ hỗ trợ đăng nhập bằng cookie. Hãy thêm tài khoản bằng cookie, hoặc đặt MUSE_PROFILE_DIR / MUSE_CDP để dùng Chrome đã đăng nhập.');
    }
    if (shared && this.sessions.size > 0) {
      throw new AuthError('Chế độ Chrome đã đăng nhập (MUSE_PROFILE_DIR / MUSE_CDP) chỉ dùng được một tài khoản, vì các tài khoản sẽ dùng chung một phiên.');
    }

    let context: BrowserContext;
    let owned: boolean;
    if (profile) {
      context = await this.ensurePersistent();
      owned = false;
    } else if (attach) {
      const browser = await this.ensureBrowser();
      context = browser.contexts()[0] ?? (await browser.newContext());
      owned = false;
    } else {
      const browser = await this.ensureBrowser();
      const parsed = parseCookies((credentials as Extract<Credentials, { kind: 'cookie' }>).cookie);
      if (!parsed.ok) throw new AuthError('Cookie không hợp lệ.');
      context = await browser.newContext({ viewport: { width: 1366, height: 900 }, ...(this.opts.headless ? { userAgent: this.headlessSafeUserAgent(browser) } : {}) });
      owned = true;
      await context.addCookies(parsed.cookies.map((c) => ({ name: c.name, value: c.value, url: this.opts.baseUrl, secure: this.opts.baseUrl.startsWith('https:') })));
    }

    let page: Page | undefined;
    try {
      // Luôn mở tab riêng, không chiếm tab Muse đang dùng của người dùng.
      page = await context.newPage();
      page.setDefaultTimeout(30_000);
      await page.goto(this.opts.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      let auth = await this.probeAuth(page);
      if (!auth.ok && profile) {
        // Cửa sổ Chrome đang mở: chờ người dùng đăng nhập Meta tại đó.
        const until = Date.now() + this.opts.loginWaitMs;
        while (!auth.ok && Date.now() < until && !page.isClosed()) {
          await sleep(2000);
          auth = await this.probeAuth(page).catch(() => ({ ok: false, status: 0 }));
        }
      }
      if (!auth.ok) {
        throw new AuthError(
          shared
            ? 'Chrome chưa đăng nhập Muse. Hãy đăng nhập muse.ai trong cửa sổ Chrome đó rồi thử lại.'
            : 'Muse không nhận cookie này (hết hạn hoặc thiếu cookie HttpOnly). Hãy lấy lại cookie từ phiên đang đăng nhập.',
        );
      }
    } catch (e) {
      if (owned) await context.close().catch(() => undefined);
      else await page?.close().catch(() => undefined);
      throw e instanceof AuthError ? e : new AuthError(`Không mở được Muse: ${(e as Error).message.split('\n')[0]}`);
    }

    const id = newId('sess');
    this.sessions.set(id, { context, page: page!, owned, lock: Promise.resolve() });
    return { id };
  }

  async health(session: SessionHandle): Promise<HealthResult> {
    const s = this.sessions.get(session.id);
    if (!s) return { status: 'expired', reason: 'Phiên không còn tồn tại.' };
    if (s.page.isClosed()) return { status: 'unreachable', reason: 'Trình duyệt chạy Muse đã đóng.' };
    const auth = await this.probeAuth(s.page).catch(() => ({ ok: false, status: 0 }));
    if (auth.ok) return { status: 'healthy' };
    if (auth.status === 0) return { status: 'unreachable', reason: 'Không kết nối được tới Muse.' };
    return { status: 'expired', reason: 'Phiên Muse đã hết hạn hoặc đã đăng xuất.' };
  }

  async refresh(session: SessionHandle): Promise<void> {
    const s = this.sessions.get(session.id);
    if (!s || s.page.isClosed()) throw new Error('Phiên không còn dùng được.');
    await s.page.goto(this.opts.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!(await this.probeAuth(s.page)).ok) throw new Error('Cần đăng nhập lại Muse.');
  }

  async close(session: SessionHandle): Promise<void> {
    const s = this.sessions.get(session.id);
    this.sessions.delete(session.id);
    if (s?.owned) await s.context.close().catch(() => undefined);
    else if (s) await s.page.close().catch(() => undefined);
    // Không còn phiên nào thì đóng Chrome do mình mở; Chrome của người dùng (CDP) chỉ ngắt kết nối.
    if (this.sessions.size === 0) {
      const ctx = this.persistent;
      this.persistent = null;
      await ctx?.close().catch(() => undefined);
      const b = this.browser;
      this.browser = null;
      await b?.close().catch(() => undefined);
    }
  }

  async generate(session: SessionHandle, spec: GenerateSpec, hooks: GenerateHooks): Promise<GeneratedVideo> {
    const s = this.sessions.get(session.id);
    if (!s) throw new WorkerError('session-lost', 'SESSION_LOST', 'Phiên của tài khoản không còn dùng được.');
    // Một tab chỉ chạy một job tại một thời điểm.
    const run = s.lock.then(() => this.generateLocked(s, spec, hooks));
    s.lock = run.catch(() => undefined);
    return run;
  }

  // ---- tạo video ----

  private async generateLocked(s: Session, spec: GenerateSpec, hooks: GenerateHooks): Promise<GeneratedVideo> {
    const { signal } = hooks;
    const { page } = s;
    const throwIfAborted = () => {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
    };
    try {
      throwIfAborted();
      if (page.isClosed()) throw new WorkerError('session-lost', 'PAGE_CLOSED', 'Tab Muse đã bị đóng.');
      await this.openNewChat(page);
      await this.attachRefs(page, spec);
      await this.debugSnap(page, spec.jobId, 'attached');
      throwIfAborted();
      await this.sendPrompt(page, buildMusePrompt(spec));
      await sleep(2500);
      await this.debugSnap(page, spec.jobId, 'sent');
      const sources = await this.waitForVideo(page, signal);
      const videoPath = await this.saveVideo(page, sources, spec.jobId);
      const thumbnailPath = await this.makeThumbnail(videoPath, spec.jobId);
      return { videoPath, thumbnailPath, quality: 'Muse' };
    } catch (e) {
      if (signal.aborted) {
        await page.locator(MUSE_SELECTORS.stopButton).first().click({ timeout: 2000 }).catch(() => undefined);
        throw e;
      }
      await this.debugShot(page, spec.jobId, e);
      throw await this.classify(page, e);
    }
  }

  private async openNewChat(page: Page): Promise<void> {
    const base = this.opts.baseUrl;
    const composer = page.locator(MUSE_SELECTORS.editor).first();
    await page.goto(new URL('thread/new', base).toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await composer.waitFor({ state: 'visible', timeout: 30_000 });
    } catch {
      // Dự phòng: về trang chủ rồi bấm "New side chat" như dự án tham chiếu.
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const btn = page.getByRole('button', { name: /new side chat|new chat|chat mới/i });
      if (await btn.count()) await btn.first().click({ timeout: 5000 }).catch(() => undefined);
      await composer.waitFor({ state: 'visible', timeout: 60_000 });
    }
    // Chờ khung soạn hết bận.
    const root = page.locator(MUSE_SELECTORS.composerRoot).first();
    for (let i = 0; i < 60 && (await root.getAttribute('aria-busy').catch(() => null)) === 'true'; i++) await sleep(250);
  }

  /** Đính ảnh theo đúng thứ tự job; tên file là tag để Muse biết ảnh nào là @tag nào. Chỉ gửi khi thấy ảnh đã vào khung soạn. */
  private async attachRefs(page: Page, spec: GenerateSpec): Promise<void> {
    if (spec.refImages.length === 0) return;
    const files = await Promise.all(
      spec.refImages.map(async (r) => {
        const ext = path.extname(r.path).toLowerCase();
        return { name: `${r.tag}${ext}`, mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream', buffer: await fsp.readFile(r.path) };
      }),
    );
    await page.locator(MUSE_SELECTORS.fileInput).first().setInputFiles(files);

    const names = files.map((f) => f.name);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const seen = await page.evaluate(
        ({ root, names }) => {
          const el = document.querySelector(root);
          if (!el) return 0;
          const text = (el as HTMLElement).innerText || '';
          const byName = names.filter((n) => text.includes(n)).length;
          const byMedia = el.querySelectorAll('img, video, canvas, [data-testid*="attach" i], [data-testid*="file" i], [aria-label*="remove" i], [aria-label*="xóa" i]').length;
          return Math.max(byName, byMedia);
        },
        { root: MUSE_SELECTORS.composerRoot, names },
      );
      if (seen >= names.length) break;
      if (Date.now() > deadline) {
        throw new WorkerError('transient', 'REF_NOT_ATTACHED', 'Không thấy ảnh tham chiếu trong khung soạn Muse nên chưa gửi, để tránh tạo video sai.');
      }
      await sleep(400);
    }
    await sleep(500);
  }

  /** Nội dung đang có trong khung soạn: textarea/input đọc `value`, contenteditable đọc `innerText`. */
  private async composerText(editor: Locator): Promise<string> {
    return editor
      .evaluate((el) => (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : (el as HTMLElement).innerText))
      .catch(() => '');
  }

  private async sendPrompt(page: Page, text: string): Promise<void> {
    const editor = page.locator(MUSE_SELECTORS.editor).first();
    await editor.click();
    // Mỗi dòng một lần chèn, giữa các dòng Shift+Enter (Enter thường sẽ gửi tin nhắn).
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await page.keyboard.press('Shift+Enter');
      if (lines[i]) {
        try {
          await page.keyboard.insertText(lines[i]!);
        } catch {
          await page.keyboard.type(lines[i]!, { delay: 1 });
        }
      }
    }
    // Chống gửi prompt bị cụt: so độ dài chữ (bỏ khoảng trắng) với bản gốc.
    const typed = (await this.composerText(editor)).replace(/\s+/g, '').length;
    const want = text.replace(/\s+/g, '').length;
    if (typed < want * 0.9) {
      const nodes = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((n) => ({ tag: n.tagName, len: ((n as HTMLElement).innerText || (n as HTMLInputElement).value || '').replace(/\s+/g, '').length })), MUSE_SELECTORS.editor).catch(() => []);
      throw new WorkerError('transient', 'PROMPT_NOT_TYPED', `Khung soạn Muse chỉ nhận ${typed}/${want} ký tự của prompt nên chưa gửi, để tránh tạo video từ prompt bị cụt. Các ô soạn tìm thấy: ${JSON.stringify(nodes)}.`);
    }
    await sleep(200);
    await page.keyboard.press('Enter');
    // Xác nhận tin nhắn đã rời khung soạn (hoặc Muse đã bắt đầu trả lời).
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const left = (await this.composerText(editor)).trim() === '' || (await page.locator(MUSE_SELECTORS.stopButton).count()) > 0;
      if (left) return;
    }
    await page.keyboard.press('Control+Enter').catch(() => undefined);
  }

  /** Chờ Muse trả video; trả về các nguồn video (blob: hoặc http) trong tin nhắn trợ lý. */
  private async waitForVideo(page: Page, signal: AbortSignal): Promise<string[]> {
    const deadline = Date.now() + this.opts.maxWaitMs;
    let idleSince = Date.now();
    let lastKey = '';
    let videoStableSince: number | null = null;
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      if (Date.now() > deadline) throw new WorkerError('transient', 'MUSE_TIMEOUT', 'Muse không trả video trong thời gian cho phép.');
      if (page.isClosed()) throw new WorkerError('session-lost', 'PAGE_CLOSED', 'Tab Muse đã bị đóng.');

      const notice = await page.locator(MUSE_SELECTORS.errorNotice).first().innerText({ timeout: 500 }).catch(() => '');
      if (notice.trim()) throw new WorkerError(RATE_LIMIT_RE.test(notice) ? 'rate-limit' : 'transient', 'MUSE_ERROR_NOTICE', `Muse báo lỗi: ${notice.trim().slice(0, 200)}`);

      const snap = await page.evaluate(
        ({ assistant, stop }) => {
          const msgs = [...document.querySelectorAll(assistant)] as HTMLElement[];
          const urls = new Set<string>();
          for (const m of msgs) {
            for (const n of m.querySelectorAll('video, video source')) {
              const v = n as HTMLVideoElement;
              const u = v.currentSrc || v.src || v.getAttribute('src') || '';
              if (/^(https?:|blob:)/i.test(u)) urls.add(u);
            }
            for (const a of m.querySelectorAll('a[href]')) {
              const h = (a as HTMLAnchorElement).href;
              if (/\.mp4(\?|$)/i.test(h)) urls.add(h);
            }
          }
          const last = msgs[msgs.length - 1];
          return { stopping: document.querySelectorAll(stop).length > 0, urls: [...urls], text: last ? last.innerText : '', count: msgs.length };
        },
        { assistant: MUSE_SELECTORS.assistant, stop: MUSE_SELECTORS.stopButton },
      );

      const key = `${snap.count}|${snap.text}|${snap.urls.join(',')}`;
      if (key !== lastKey) {
        lastKey = key;
        idleSince = Date.now();
      }
      if (snap.urls.length > 0) {
        videoStableSince ??= Date.now();
        // Video đã hiện và Muse ngừng đổi nội dung một lúc.
        if (!snap.stopping && Date.now() - videoStableSince > 3000 && Date.now() - idleSince > 3000) return snap.urls;
      } else {
        videoStableSince = null;
        if (!snap.stopping && snap.count > 0 && Date.now() - idleSince > this.opts.idleGraceMs) {
          const reply = snap.text.replace(/\s+/g, ' ').trim().slice(0, 240);
          throw new WorkerError('permanent', 'NO_VIDEO', `Muse đã trả lời nhưng không có video: ${reply || '(trống)'}`);
        }
      }
      await sleep(1000);
    }
  }

  private async saveVideo(page: Page, sources: string[], jobId: string): Promise<string> {
    await fsp.mkdir(this.opts.tmpDir, { recursive: true });
    // Video mới nhất nằm cuối; thử từ cuối lên.
    for (const url of [...sources].reverse()) {
      const dataUrl = await page.evaluate(async (u) => {
        try {
          const res = await fetch(u, { credentials: 'include' });
          if (!res.ok) return null;
          const blob = await res.blob();
          return await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(r.error);
            r.readAsDataURL(blob);
          });
        } catch {
          return null;
        }
      }, url);
      if (!dataUrl) continue;
      const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      // MP4 có "ftyp" ở byte 4..8.
      if (buf.length < 1024 || buf.subarray(4, 8).toString('latin1') !== 'ftyp') continue;
      const out = path.join(this.opts.tmpDir, `${jobId}.mp4`);
      await fsp.writeFile(out, buf);
      return out;
    }
    throw new WorkerError('transient', 'DOWNLOAD_FAILED', 'Muse đã tạo video nhưng không tải được file về máy.');
  }

  private async hasFfmpeg(): Promise<boolean> {
    this.ffmpegOk ??= await execFileP('ffmpeg', ['-version']).then(() => true, () => false);
    return this.ffmpegOk;
  }

  private async makeThumbnail(videoPath: string, jobId: string): Promise<string> {
    const out = path.join(this.opts.tmpDir, `${jobId}.jpg`);
    if (await this.hasFfmpeg()) {
      try {
        await execFileP('ffmpeg', ['-y', '-v', 'error', '-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out]);
        return out;
      } catch {
        // rơi xuống ảnh xám bên dưới
      }
    }
    await sharp({ create: { width: 480, height: 270, channels: 3, background: '#222a36' } }).jpeg().toFile(out);
    return out;
  }

  private async classify(page: Page, e: unknown): Promise<WorkerError> {
    if (e instanceof WorkerError) return e;
    if (page.isClosed()) return new WorkerError('session-lost', 'BROWSER_CLOSED', 'Trình duyệt chạy Muse đã đóng.');
    const auth = await this.probeAuth(page).catch(() => ({ ok: true, status: 0 }));
    if (!auth.ok && auth.status !== 0) return new WorkerError('session-lost', 'SESSION_EXPIRED', 'Phiên Muse đã hết hạn.');
    return new WorkerError('transient', 'MUSE_DRIVER_ERROR', `Lỗi khi điều khiển Muse: ${(e as Error).message.split('\n')[0]}`);
  }

  /** Ảnh chụp trạng thái trang ở một bước (chỉ khi bật MUSE_DEBUG), để đối chiếu thứ tự và số ảnh đã đính. */
  private async debugSnap(page: Page, jobId: string, step: string): Promise<void> {
    if (!this.opts.debugDir || page.isClosed()) return;
    await fsp.mkdir(this.opts.debugDir, { recursive: true });
    await page.screenshot({ path: path.join(this.opts.debugDir, `${jobId}-${step}.png`) }).catch(() => undefined);
  }

  private async debugShot(page: Page, jobId: string, error?: unknown): Promise<void> {
    if (!this.opts.debugDir || page.isClosed()) return;
    await fsp.mkdir(this.opts.debugDir, { recursive: true });
    if (error) await fsp.writeFile(path.join(this.opts.debugDir, `${jobId}.txt`), `${(error as Error).name}: ${(error as Error).message}
`).catch(() => undefined);
    await page.screenshot({ path: path.join(this.opts.debugDir, `${jobId}.png`) }).catch(() => undefined);
  }
}
