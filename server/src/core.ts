import path from 'node:path';
import type { AppState } from '@muse/shared';
import { MockAdapter } from './adapters/mock.js';
import { MuseBrowserAdapter } from './adapters/muse-browser.js';
import type { PlatformAdapter } from './adapters/types.js';
import { AccountService } from './accounts.js';
import { ASSETS_DIR, type AppConfig } from './config.js';
import { Vault, loadMasterKey } from './crypto.js';
import { openDb, type Db } from './db.js';
import { Dispatcher } from './dispatcher.js';
import { ImageStore } from './images.js';
import { JobRepo } from './jobs.js';
import { QueueService } from './queue.js';
import { SettingsService } from './settings.js';
import { StudioService } from './studio.js';

export interface CoreOverrides {
  db?: Db;
  adapter?: PlatformAdapter;
  now?: () => number;
}

/** Ghép các service lại với nhau; app.ts chỉ nói chuyện với đối tượng này. */
export class Core {
  readonly vault: Vault;
  readonly settings: SettingsService;
  readonly images: ImageStore;
  readonly jobs: JobRepo;
  readonly accounts: AccountService;
  readonly dispatcher: Dispatcher;
  readonly queue: QueueService;
  readonly studio: StudioService;

  constructor(
    readonly config: AppConfig,
    readonly db: Db,
    readonly adapter: PlatformAdapter,
    now: () => number = Date.now,
  ) {
    this.vault = new Vault(loadMasterKey({ masterKeyB64: config.masterKeyB64, keyDir: config.keyDir, dataDir: config.dataDir }));
    this.settings = new SettingsService(db);
    this.images = new ImageStore(db, config.dataDir, now);
    this.jobs = new JobRepo(db, now);
    this.images.affectedJobs = (fileId) => this.jobs.affectedByFile(fileId);
    this.accounts = new AccountService(db, this.vault, adapter, this.settings, now);
    this.accounts.runningCount = (id) => this.jobs.runningCountByAccount(id);
    this.dispatcher = new Dispatcher(this.jobs, this.accounts, this.images, this.settings, adapter, { dataDir: config.dataDir, tickIntervalMs: config.tickIntervalMs, healthTtlMs: config.healthTtlMs }, now);
    this.queue = new QueueService(this.jobs, this.images, this.dispatcher);
    this.studio = new StudioService(db, this.images, this.jobs, this.dispatcher, now);
  }

  async start(): Promise<void> {
    await this.dispatcher.init();
    await this.images.cleanupStaged(60 * 60_000);
    // Khôi phục session ở nền để server nhận request ngay.
    void this.accounts.restoreSessions().then(() => this.dispatcher.wake());
    this.accounts.startHealthLoop(this.config.healthIntervalMs);
    this.dispatcher.start();
  }

  async stop(): Promise<void> {
    await this.dispatcher.shutdown();
    await this.accounts.shutdown();
  }

  /** getState(): đủ để render header, tabs và dải trực tiếp trong một request. */
  getState(): AppState {
    const online = this.accounts.assignable();
    const list = this.accounts.list();
    return {
      serverTime: new Date().toISOString(),
      online: online.length > 0,
      adapter: this.adapter.name,
      simulated: this.adapter.simulated,
      reportsProgress: this.adapter.reportsProgress,
      dispatcherRunning: this.dispatcher.isRunning,
      dispatcherBlocked: this.dispatcher.blocked(),
      counts: this.jobs.countsAll(),
      refCount: this.images.refCount(),
      accounts: { total: list.length, enabled: list.filter((a) => a.enabled).length, online: online.length },
      concurrency: this.dispatcher.concurrency(),
      settings: this.settings.get(),
      runningJobs: this.jobs.running().map((j) => this.jobs.toJob(j)),
    };
  }
}

export function createAdapter(config: AppConfig): PlatformAdapter {
  if (config.adapter === 'mock') {
    return new MockAdapter({
      assetsDir: path.join(ASSETS_DIR, ''),
      tmpDir: path.join(config.dataDir, 'tmp'),
      jobSeconds: config.mock.jobSeconds,
      failRate: config.mock.failRate,
    });
  }
  if (config.adapter === 'muse') {
    return new MuseBrowserAdapter({
      ...config.muse,
      tmpDir: path.join(config.dataDir, 'tmp'),
      debugDir: config.muse.debug ? path.join(config.dataDir, 'muse-debug') : null,
    });
  }
  throw new Error(`Adapter "${config.adapter}" chưa được hỗ trợ. Dùng MUSE_ADAPTER=muse hoặc mock, hoặc thêm adapter mới trong server/src/adapters.`);
}

export function createCore(config: AppConfig, overrides: CoreOverrides = {}): Core {
  const db = overrides.db ?? openDb(config.dataDir);
  return new Core(config, db, overrides.adapter ?? createAdapter(config), overrides.now);
}
