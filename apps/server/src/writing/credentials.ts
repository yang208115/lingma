import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../errors.js';

export class LocalCredentials {
  private readonly values = new Map<string, string>();
  private readonly keyPath: string;
  private readonly dataPath: string;
  constructor(directory: string) {
    this.keyPath = join(directory, 'credentials.key');
    this.dataPath = join(directory, 'credentials.enc');
    if (!existsSync(this.dataPath)) return;
    try {
      const record = JSON.parse(readFileSync(this.dataPath, 'utf8')) as {
        iv: string;
        tag: string;
        data: string;
      };
      const decipher = createDecipheriv(
        'aes-256-gcm',
        readFileSync(this.keyPath),
        Buffer.from(record.iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(record.tag, 'hex'));
      const entries = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(record.data, 'hex')),
          decipher.final(),
        ]).toString('utf8'),
      ) as [string, string][];
      for (const [ref, value] of entries) this.values.set(ref, value);
    } catch {
      throw new AppError('STORAGE_ERROR', '无法读取本机模型凭据', 503);
    }
  }
  get(reference: string) {
    return this.values.get(reference);
  }
  set(reference: string, value: string) {
    try {
      if (!existsSync(this.keyPath))
        writeFileSync(this.keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
      const next = new Map(this.values).set(reference, value);
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', readFileSync(this.keyPath), iv);
      const data = Buffer.concat([
        cipher.update(JSON.stringify([...next]), 'utf8'),
        cipher.final(),
      ]);
      const temp = `${this.dataPath}.tmp`;
      writeFileSync(
        temp,
        JSON.stringify({
          iv: iv.toString('hex'),
          tag: cipher.getAuthTag().toString('hex'),
          data: data.toString('hex'),
        }),
        { mode: 0o600 },
      );
      renameSync(temp, this.dataPath);
      this.values.set(reference, value);
    } catch {
      throw new AppError('STORAGE_ERROR', '无法保存本机模型凭据', 503);
    }
  }
}
