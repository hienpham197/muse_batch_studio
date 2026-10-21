import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const AAD = Buffer.from('muse-credentials-v1');

export interface KeySource {
  masterKeyB64: string | null;
  keyDir: string;
  dataDir: string;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Khóa mã hóa không được nằm cùng nơi lưu dữ liệu (Mục 2.5). */
export function loadMasterKey(src: KeySource): Buffer {
  if (src.masterKeyB64) {
    const key = Buffer.from(src.masterKeyB64, 'base64');
    if (key.length !== 32) throw new Error('MUSE_MASTER_KEY phải là 32 byte mã hóa base64.');
    return key;
  }
  if (isInside(src.keyDir, src.dataDir) || isInside(src.dataDir, src.keyDir)) {
    throw new Error('Thư mục khóa mã hóa không được nằm trong (hoặc chứa) thư mục dữ liệu.');
  }
  const file = path.join(src.keyDir, 'master.key');
  if (fs.existsSync(file)) {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error('File khóa mã hóa bị hỏng.');
    return key;
  }
  fs.mkdirSync(src.keyDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  return key;
}

export class Vault {
  private readonly dataKey: Buffer;
  private readonly hashKey: Buffer;

  constructor(master: Buffer) {
    this.dataKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'muse/credentials', 32));
    this.hashKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'muse/identifier-hash', 32));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.dataKey, iv);
    cipher.setAAD(AAD);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
  }

  decrypt(payload: string): string {
    const [v, iv, tag, ct] = payload.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Dữ liệu đăng nhập không đúng định dạng.');
    const decipher = createDecipheriv('aes-256-gcm', this.dataKey, Buffer.from(iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  }

  /** Băm có khóa để phát hiện tài khoản trùng mà không lưu định danh gốc. */
  identifierHash(identifier: string): string {
    return createHmac('sha256', this.hashKey).update(identifier.trim().toLowerCase()).digest('hex');
  }
}

/** Che một phần định danh để hiển thị: ab***@g***.com */
export function maskIdentifier(identifier: string): string {
  const id = identifier.trim();
  const at = id.indexOf('@');
  if (at > 0) {
    const local = id.slice(0, at);
    const domain = id.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    const tld = dot > 0 ? domain.slice(dot) : '';
    return `${local.slice(0, Math.min(2, local.length))}***@${domain.slice(0, 1)}***${tld}`;
  }
  if (id.length <= 6) return `${id.slice(0, 1)}***`;
  return `${id.slice(0, 2)}***${id.slice(-2)}`;
}
