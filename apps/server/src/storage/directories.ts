import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import type { Config } from '../config.js';

const contains = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
};
const overlaps = (a: string, b: string): boolean => contains(a, b) || contains(b, a);

async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) throw new Error(`存储目录不能是符号链接：${path}`);
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  return realpath(path);
}

export interface Directories {
  data: string;
  blobs: string;
  temp: string;
  backups: string;
  release(): Promise<void>;
}

export async function openDirectories(
  config: Config,
  onCompromised: (error: Error) => void,
): Promise<Directories> {
  // Check lexical overlap before creating any directories, then canonical paths after creation.
  if (overlaps(config.dataDir, config.webDistDir) || overlaps(config.tempDir, config.webDistDir)) {
    throw new Error('数据与临时目录不能与前端静态文件目录重叠');
  }
  const data = await privateDirectory(config.dataDir);
  const release = await lockfile
    .lock(data, {
      realpath: true,
      lockfilePath: resolve(data, '.instance.lock'),
      retries: 0,
      stale: 30000,
      update: 10000,
      onCompromised,
    })
    .catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ELOCKED') {
        throw new Error(`数据目录已有实例占用：${data}`);
      }
      throw error;
    });
  try {
    const blobs = await privateDirectory(resolve(data, 'blobs'));
    const backups = await privateDirectory(resolve(data, 'backups'));
    const temp = await privateDirectory(config.tempDir);
    // A custom temporary directory may be DATA_DIR/tmp or a separate private directory.
    if (contains(temp, data) || overlaps(temp, blobs) || overlaps(temp, backups)) {
      throw new Error('临时目录不能包含数据目录或与附件、备份目录重叠');
    }
    // Resolve a not-yet-built static root through its existing ancestors to catch symlinks.
    async function canonical(path: string): Promise<string> {
      try {
        return await realpath(path);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        const parent = resolve(path, '..');
        if (parent === path) throw error;
        return resolve(await canonical(parent), relative(parent, path));
      }
    }
    const web = await canonical(config.webDistDir);
    if (overlaps(web, data) || overlaps(web, temp)) throw new Error('静态目录不能公开存储目录');
    return { data, blobs, temp, backups, release };
  } catch (error) {
    await release();
    throw error;
  }
}
