import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type ConfirmImport,
  type ImportChapter,
  type ImportEncoding,
  type ImportPreview,
  type ImportResult,
  idSchema,
  importPreviewSchema,
  novelLimits,
} from '@lingma/shared';
import { AppError } from '../errors.js';
import type { MaintenanceGate } from '../storage/maintenance.js';
import type { NovelService } from './novels.js';

export function splitChapters(text: string): { chapters: ImportChapter[]; warnings: string[] } {
  const chapters: ImportChapter[] = [];
  let title = '导入前言';
  let lines: string[] = [];
  let headingSeen = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const match =
      line.match(
        /^(?:#{1,6}\s+)?(第[零〇一二三四五六七八九十百千万两\d]+[章回节].*|[Cc]hapter\s+\d+.*)$/,
      ) ?? line.match(/^#{2,6}\s+(.+)$/);
    if (match?.[1]) {
      if (headingSeen || lines.some((entry) => entry.trim() !== ''))
        chapters.push({ title, content: lines.join('\n') });
      if (chapters.length >= novelLimits.importChapters)
        throw new AppError('VALIDATION_ERROR', '导入章节超过 1000 项，请拆分文件', 400);
      title = match[1].trim();
      lines = [];
      headingSeen = true;
    } else lines.push(line);
  }
  if (headingSeen || lines.length) chapters.push({ title, content: lines.join('\n') });
  const warnings: string[] = [];
  const titles = new Set<string>();
  for (const [index, chapter] of chapters.entries()) {
    if (!chapter.content.trim()) warnings.push(`第 ${index + 1} 项为空章，已保留`);
    if (titles.has(chapter.title))
      warnings.push(`第 ${index + 1} 项标题“${chapter.title}”重复，已保留`);
    if (chapter.title.length > 200)
      throw new AppError('VALIDATION_ERROR', '识别出的标题超过 200 字符，请先修正源文件', 400);
    titles.add(chapter.title);
  }
  if (!headingSeen) warnings.push('未识别章节标题，已保留全部文本；可在预览中手动拆分');
  if (chapters[0]?.title === '导入前言' && headingSeen)
    warnings.push('首个章标题前的文本保留为“导入前言”，可手动调整');
  return { chapters, warnings };
}

export class ImportService {
  constructor(
    private readonly novels: NovelService,
    private readonly tempDir: string,
    private readonly gate: MaintenanceGate,
  ) {}
  async create(
    projectId: string,
    filename: string,
    bytes: Uint8Array,
    encoding: ImportEncoding,
  ): Promise<ImportPreview> {
    const project = this.novels.getProject(projectId);
    if (!/\.(md|markdown|txt)$/i.test(filename))
      throw new AppError('VALIDATION_ERROR', '仅支持 Markdown 或 TXT 文件', 400);
    if (bytes.byteLength > novelLimits.importBytes)
      throw new AppError('VALIDATION_ERROR', '导入文件不能超过 8 MiB', 400);
    let text: string;
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      throw new AppError(
        'VALIDATION_ERROR',
        '文件无法按所选编码解码，请选择正确编码后重新预览',
        400,
      );
    }
    if (text.includes('\0') || text.includes('\uFFFD'))
      throw new AppError('VALIDATION_ERROR', '解码结果包含无效字符，请检查文件编码', 400);
    if (text.length > novelLimits.importChars)
      throw new AppError('VALIDATION_ERROR', '导入总文本不能超过 400 万字符', 400);
    const { chapters, warnings } = splitChapters(text);
    const now = new Date();
    const preview = importPreviewSchema.parse({
      id: randomUUID(),
      projectId,
      baseStructureVersion: project.structureVersion,
      filename: filename.slice(0, 255),
      encoding,
      chapters,
      warnings,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86400000).toISOString(),
      result: null,
    });
    return this.gate.withWrite(async () => {
      const directory = this.path(preview.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(resolve(directory, 'source'), bytes, { flag: 'wx', mode: 0o600 });
      await writeFile(resolve(directory, 'manifest.tmp'), JSON.stringify(preview), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      await rename(resolve(directory, 'manifest.tmp'), resolve(directory, 'manifest.json'));
      return preview;
    });
  }
  async get(projectId: string, id: string): Promise<ImportPreview> {
    this.novels.getProject(projectId);
    let raw: string;
    try {
      raw = await readFile(resolve(this.path(id), 'manifest.json'), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new AppError('NOT_FOUND', '导入预览不存在，请重新上传', 404);
      throw new AppError('STORAGE_ERROR', '无法读取导入预览', 503);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new AppError('STORAGE_ERROR', '导入预览已损坏，请重新上传', 503);
    }
    const parsed = importPreviewSchema.safeParse(decoded);
    if (!parsed.success) throw new AppError('STORAGE_ERROR', '导入预览已损坏，请重新上传', 503);
    const preview = parsed.data;
    if (preview.projectId !== projectId)
      throw new AppError('NOT_FOUND', '本作品中不存在该导入', 404);
    if (Date.parse(preview.expiresAt) <= Date.now())
      throw new AppError('NOT_FOUND', '导入预览已过期，请重新上传', 404);
    return { ...preview, result: this.novels.committedImport(projectId, id) };
  }
  async confirm(projectId: string, id: string, input: ConfirmImport): Promise<ImportResult> {
    // The durable ledger is checked before reading an expiring preview. Its transaction rechecks the request hash.
    if (!this.novels.committedImport(projectId, id)) await this.get(projectId, id);
    return this.novels.confirmImport(projectId, id, input);
  }
  private path(id: string): string {
    return resolve(this.tempDir, 'novel-imports', idSchema.parse(id));
  }
}
