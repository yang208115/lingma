import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashSchema } from '@lingma/shared';
import { AppError } from '../errors.js';
import type { MaintenanceGate } from './maintenance.js';

export interface BlobRef {
  hash: string;
  sizeBytes: number;
}
export interface BlobStore {
  put(content: Uint8Array): Promise<BlobRef>;
  get(hash: string): Promise<Uint8Array>;
}

export class FileBlobStore implements BlobStore {
  constructor(
    private readonly root: string,
    private readonly gate: MaintenanceGate,
  ) {}

  async put(content: Uint8Array): Promise<BlobRef> {
    return this.gate.withWrite(async () => {
      const hash = createHash('sha256').update(content).digest('hex');
      const path = this.path(hash);
      await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
      // Stage beside the final file so the atomic publication never crosses filesystems.
      const staged = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(staged, content, { flag: 'wx', mode: 0o600, flush: true });
        try {
          await link(staged, path);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST')
            throw error;
          await this.get(hash);
        }
      } finally {
        await rm(staged, { force: true });
      }
      return { hash, sizeBytes: content.byteLength };
    });
  }

  async get(hash: string): Promise<Uint8Array> {
    const content = await readFile(this.path(hash));
    if (createHash('sha256').update(content).digest('hex') !== hash) {
      throw new AppError('STORAGE_ERROR', '附件完整性校验失败', 503);
    }
    return content;
  }
  private path(hash: string): string {
    if (!hashSchema.safeParse(hash).success)
      throw new AppError('VALIDATION_ERROR', '无效的附件 hash', 400);
    return resolve(this.root, hash.slice(0, 2), hash);
  }
}
