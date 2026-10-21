import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createCore } from './core.js';

const config = loadConfig();

// Không để server mở ra mạng khi chưa có mã truy cập: Account Pool chứa credential.
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
if (!loopback && !config.accessToken) {
  console.error('Từ chối khởi động: HOST không phải loopback nhưng chưa đặt MUSE_ACCESS_TOKEN.');
  process.exit(1);
}

const core = createCore(config);
await core.start();
const app = await buildApp(core, { logger: true, devRoutes: process.env.MUSE_DEV_ROUTES === '1' });

await app.listen({ host: config.host, port: config.port });
if (config.adapter === 'muse') {
  const m = config.muse;
  const login = m.cdpUrl ? 'gắn vào Chrome đang chạy (CDP)' : m.profileDir ? 'profile Chrome riêng' : 'cookie của từng tài khoản';
  app.log.info(`Adapter Muse: đăng nhập bằng ${login}, ${m.headless ? 'chạy ngầm (headless)' : 'hiện cửa sổ Chrome'}.`);
}
if (core.adapter.simulated) {
  app.log.warn('Đang dùng adapter MÔ PHỎNG: video là mẫu test pattern, không phải kết quả AI thật.');
}

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'đang tắt server');
  await app.close();
  await core.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
