import { posix } from 'node:path';
import { type Json, jsonSchema, relativePathSchema, skillLimits } from '@lingma/shared';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { AppError } from '../errors.js';

export interface SkillInputFile {
  path: string;
  bytes: Uint8Array;
}
export const invalid = (message: string): never => {
  throw new AppError('VALIDATION_ERROR', message, 400);
};
export function safeSkillPath(input: string): string {
  const path = input.normalize('NFC');
  if (
    !relativePathSchema.safeParse(path).success ||
    path.split('/').length > skillLimits.pathDepth ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path
      .split('/')
      .some(
        (part) =>
          part.endsWith('.') ||
          part.endsWith(' ') ||
          /[:<>"|?*]/.test(part) ||
          /^(\.git|\.hg|\.svn)$/i.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part),
      )
  )
    return invalid('文件路径不安全或层级过深');
  return path;
}
export function decodeSkillText(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\0')) return invalid('文本必须是无 NUL 的 UTF-8');
    return text;
  } catch {
    return invalid('文本必须使用 UTF-8 编码');
  }
}
export function validateFiles(files: SkillInputFile[]): SkillInputFile[] {
  if (files.length === 0 || files.length > skillLimits.files)
    return invalid('文件数必须在 1—200 之间');
  let total = 0;
  const seen = new Set<string>();
  const normalized = files.map(({ path, bytes }) => {
    path = safeSkillPath(path);
    const folded = path.toLocaleLowerCase('en-US');
    if (seen.has(folded)) return invalid('文件路径重复（包含大小写或 Unicode 等价路径）');
    seen.add(folded);
    total += bytes.byteLength;
    if (bytes.byteLength > skillLimits.fileBytes || total > skillLimits.totalBytes)
      return invalid('文件超过 2 MiB 或目录超过 16 MiB');
    return { path, bytes };
  });
  const entry = normalized.find((file) => file.path === 'SKILL.md');
  if (!entry) return invalid('所选目录根部必须包含 SKILL.md');
  if (entry.bytes.byteLength > skillLimits.entryBytes) return invalid('SKILL.md 超过 256 KiB');
  for (const file of normalized) {
    const parts = file.path.split('/');
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join('/').toLocaleLowerCase('en-US')))
        return invalid('文件与目录路径冲突');
      parts.pop();
    }
  }
  return normalized.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export function parseSkill(entryContent: string, paths: readonly string[]) {
  if (
    entryContent.includes('\0') ||
    Buffer.from(entryContent, 'utf8').toString('utf8') !== entryContent
  )
    return invalid('SKILL.md 必须是无 NUL 的有效 Unicode 文本');
  if (Buffer.byteLength(entryContent) > skillLimits.entryBytes)
    return invalid('SKILL.md 超过 256 KiB');
  let body = entryContent.replace(/^\uFEFF/, '');
  let metadata: Record<string, Json> = {};
  if (/^---\r?\n/.test(body)) {
    const match = /^---\r?\n((?:[\s\S]*?\r?\n)?)(?:---|\.\.\.)(?:\r?\n|$)/.exec(body);
    if (!match) return invalid('front matter 缺少结束分隔符');
    try {
      const doc = parseDocument(match[1] ?? '', { schema: 'core', uniqueKeys: true });
      if (doc.errors.length || doc.warnings.length)
        return invalid('front matter YAML 无效或包含不支持的标签');
      const value: unknown = doc.toJS({ maxAliasCount: 0 });
      if (value !== null && (typeof value !== 'object' || Array.isArray(value)))
        return invalid('front matter 必须是对象');
      metadata = z.record(z.string(), jsonSchema).parse(value ?? {});
      if (JSON.stringify(metadata).length > 65536) return invalid('front matter 超过 64 KiB');
    } catch (error) {
      if (error instanceof AppError) throw error;
      return invalid('front matter YAML 无效，不允许别名');
    }
    body = body.slice(match[0].length);
  }
  const missing = new Set<string>();
  const warnings = new Set<string>();
  const ast = fromMarkdown(body);
  const visit = (node: { type: string; url?: string; children?: unknown[] }) => {
    if (node.url && ['link', 'image', 'definition'].includes(node.type)) {
      const url = node.url;
      if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) {
        try {
          const decoded = decodeURIComponent(url.split(/[?#]/)[0] ?? '');
          if (decoded) {
            const path = safeSkillPath(posix.normalize(decoded));
            // Never resolve links above the Skill root, even when normalization could hide it.
            if (decoded.split('/').includes('..')) warnings.add(`越界关联链接已禁用：${url}`);
            else if (!paths.includes(path)) missing.add(path);
          }
        } catch {
          warnings.add(`无效关联链接已禁用：${url}`);
        }
      }
    }
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  };
  visit(ast);
  if (missing.size) warnings.add('部分关联文件缺失，可重新上传完整目录补齐');
  const rawName = typeof metadata.name === 'string' ? metadata.name.trim() : '';
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const name = (rawName || heading || '未命名 Skill').slice(0, 200);
  return {
    name,
    metadata,
    body,
    missingFiles: [...missing],
    warnings: [...warnings],
    examples: paths.filter((path) => /^(examples?|samples?)\//i.test(path)),
  };
}
export function mediaType(path: string): string {
  if (/\.md$/i.test(path)) return 'text/markdown; charset=utf-8';
  if (/\.(txt|csv|ya?ml|json|js|ts|py|sh|css|html|xml)$/i.test(path))
    return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
