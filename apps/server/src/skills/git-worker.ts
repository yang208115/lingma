import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { gitImportSchema, relativePathSchema, skillLimits } from '@lingma/shared';
import ipaddr from 'ipaddr.js';
import git, { type GitHttpRequest } from 'isomorphic-git';

export function isPublicAddress(address: string) {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast' && parsed.toString() !== '168.63.129.16';
  } catch {
    return false;
  }
}

// A custom transport validates and pins DNS, counts all response bytes, and never follows redirects.
export function createGitHttp(
  repository: string,
  signal: AbortSignal,
  maxBytes: number = skillLimits.gitDownloadBytes,
  resolver: (
    hostname: string,
    options: { all: true; verbatim: true },
  ) => Promise<LookupAddress[]> = lookup,
  sendRequest: typeof request = request,
) {
  const allowed = new URL(gitImportSchema.parse({ repository }).repository);
  const pinned = new Map<string, LookupAddress>();
  let received = 0;
  return {
    request: async ({ url, method = 'GET', headers = {}, body }: GitHttpRequest) => {
      const target = new URL(url);
      if (
        target.origin !== allowed.origin ||
        target.username ||
        target.password ||
        !target.pathname.startsWith(`${allowed.pathname.replace(/\/$/, '')}/`)
      )
        throw new Error('Git 请求越出了仓库范围');
      let address = pinned.get(target.hostname);
      if (!address) {
        const addresses = await resolver(target.hostname.replace(/^\[|\]$/g, ''), {
          all: true,
          verbatim: true,
        });
        if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address)))
          throw new Error('Git 来源必须解析到公网地址');
        address = addresses.find((item) => item.family === 4) ?? addresses[0];
        if (!address) throw new Error('Git 来源没有可用的公网地址');
        pinned.set(target.hostname, address);
      }
      signal.throwIfAborted();
      const pinnedAddress = address;
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = sendRequest(
          target,
          {
            method,
            signal,
            agent: false,
            headers: { ...headers, 'accept-encoding': 'identity' },
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, [pinnedAddress]);
              else callback(null, pinnedAddress.address, pinnedAddress.family);
            },
          },
          resolve,
        );
        req.on('error', reject);
        void (async () => {
          try {
            if (body)
              for await (const chunk of body) {
                if (!req.write(chunk))
                  await new Promise<void>((done, fail) => {
                    req.once('drain', done);
                    req.once('error', fail);
                  });
              }
            req.end();
          } catch (error) {
            req.destroy(error instanceof Error ? error : new Error('Git 请求发送失败'));
          }
        })();
      });
      if (
        response.statusCode !== 200 ||
        (response.headers['content-encoding'] &&
          response.headers['content-encoding'] !== 'identity')
      ) {
        response.destroy();
        throw new Error('Git 下载失败：仅支持公开仓库，不允许重定向或压缩 HTTP 响应');
      }
      if (Number(response.headers['content-length'] ?? 0) > maxBytes - received) {
        response.destroy();
        throw new Error('Git 下载超过 32 MiB 限制');
      }
      const counted = async function* () {
        try {
          for await (const chunk of response) {
            received += chunk.byteLength;
            if (received > maxBytes) throw new Error('Git 下载超过 32 MiB 限制');
            yield chunk;
          }
        } finally {
          response.destroy();
        }
      };
      return {
        url,
        method,
        statusCode: 200,
        statusMessage: 'OK',
        headers: Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(', ') : (value ?? ''),
          ]),
        ),
        body: counted(),
      };
    },
  };
}

export async function readSelectedTree(dir: string, commit: string, subdir: string) {
  const options = { fs, dir };
  let oid = (await git.readCommit({ ...options, oid: commit })).commit.tree;
  for (const part of subdir ? subdir.split('/') : []) {
    const entry = (await git.readTree({ ...options, oid })).tree.find((item) => item.path === part);
    if (entry?.type !== 'tree' || entry.mode !== '040000')
      throw new Error('Git 子目录不存在或不是普通目录');
    oid = entry.oid;
  }
  const files: { path: string; bytes: Uint8Array }[] = [];
  let total = 0;
  let visited = 0;
  const walk = async (tree: string, prefix = '', depth = 0): Promise<void> => {
    if (depth >= skillLimits.pathDepth) throw new Error('Git 目录层级超过限制');
    for (const entry of (await git.readTree({ ...options, oid: tree })).tree) {
      if (++visited > 1200) throw new Error('Git Skill 目录项超过 1200');
      if (!relativePathSchema.safeParse(entry.path).success || entry.path.includes('/'))
        throw new Error('Git 路径不安全');
      const path = prefix + entry.path;
      if (entry.type === 'tree' && entry.mode === '040000')
        await walk(entry.oid, `${path}/`, depth + 1);
      else {
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
          throw new Error('Git Skill 不允许符号链接或子模块');
        if (files.length >= skillLimits.files) throw new Error('Git Skill 文件数超过 200');
        const { blob } = await git.readBlob({ ...options, oid: entry.oid });
        total += blob.byteLength;
        if (blob.byteLength > skillLimits.fileBytes || total > skillLimits.totalBytes)
          throw new Error('Git Skill 文件超过 2 MiB 或目录超过 16 MiB');
        files.push({ path, bytes: blob });
      }
    }
  };
  await walk(oid);
  return files;
}

if (!isMainThread && workerData?.repository) {
  try {
    const { repository, subdir, dir } = workerData;
    const signal = AbortSignal.timeout(skillLimits.gitTimeoutMs);
    await git.clone({
      fs,
      dir,
      url: repository,
      http: createGitHttp(repository, signal),
      depth: 1,
      singleBranch: true,
      noTags: true,
      noCheckout: true,
    });
    const commit = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const files = await readSelectedTree(dir, commit, subdir);
    parentPort?.postMessage({ commit, files });
  } catch (error) {
    // Only our own bounded diagnostics are exposed. Library/network errors may contain remote input.
    const message =
      error instanceof Error && /^(Git |文件)/.test(error.message)
        ? error.message.slice(0, 200)
        : 'Git 导入失败，请检查公开 HTTPS 仓库、子目录及网络后重试';
    parentPort?.postMessage({ error: message });
  }
}
