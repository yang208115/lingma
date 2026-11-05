import type { ImportChapter, ImportEncoding, ImportPreview, Structure } from '@lingma/shared';
import { useState } from 'react';
import { api } from '../api.js';
import { Modal } from './Modal.js';

export function ImportDialog({
  structure,
  onImported,
  onClose,
}: {
  structure: Structure;
  onImported(ids: string[]): Promise<void>;
  onClose(): void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState<ImportEncoding>('utf-8');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [chapters, setChapters] = useState<(ImportChapter & { key: string })[]>([]);
  const [volumeId, setVolumeId] = useState('');
  const [base, setBase] = useState(structure.project.structureVersion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState<string[] | null>(null);
  async function upload() {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.importFile(structure.project.id, file, encoding);
      setPreview(result);
      setChapters(result.chapters.map((chapter) => ({ ...chapter, key: crypto.randomUUID() })));
      setBase(result.baseStructureVersion);
    } catch (error) {
      setError(error instanceof Error ? error.message : '上传失败');
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.confirmImport(structure.project.id, preview.id, {
        baseStructureVersion: base,
        volumeId: volumeId || null,
        chapters: chapters.map(({ title, content }) => ({ title, content })),
      });
      setConfirmed(result.documentIds);
      await onImported(result.documentIds);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }
  const update = (index: number, change: Partial<ImportChapter>) =>
    setChapters((items) =>
      items.map((item, offset) => (offset === index ? { ...item, ...change } : item)),
    );
  return (
    <Modal
      labelledBy="import-title"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="dialog wide">
        <div className="section-heading">
          <h2 id="import-title">导入 Markdown / TXT</h2>
          <button type="button" onClick={onClose} disabled={busy}>
            关闭导入
          </button>
        </div>
        <p className="muted">
          最多 8
          MiB。先预览并修正，再确认写入；重复确认同一导入不会重复建章。编码不匹配时请选择正确编码重新预览。
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!preview ? (
          <>
            <label>
              存稿文件
              <input
                type="file"
                accept=".md,.markdown,.txt"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <label>
              文件编码
              <select
                value={encoding}
                onChange={(event) => setEncoding(event.target.value as ImportEncoding)}
              >
                <option value="utf-8">UTF-8</option>
                <option value="gb18030">GB18030 / GBK</option>
                <option value="big5">Big5</option>
                <option value="utf-16le">UTF-16 LE</option>
              </select>
            </label>
            <button
              type="button"
              className="primary"
              disabled={!file || busy}
              onClick={() => {
                void upload();
              }}
            >
              生成拆章预览
            </button>
          </>
        ) : (
          <>
            <p>
              {preview.filename} · 共 {chapters.length} 项 · 预览有效期 24 小时
            </p>
            {preview.warnings.map((warning) => (
              <p className="warning" key={warning}>
                {warning}
              </p>
            ))}
            <label>
              导入到卷
              <select
                value={volumeId}
                disabled={busy || confirmed !== null}
                onChange={(event) => setVolumeId(event.target.value)}
              >
                <option value="">未分卷</option>
                {structure.volumes.map((volume) => (
                  <option key={volume.id} value={volume.id}>
                    {volume.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="import-chapters">
              {chapters.map((chapter, index) => (
                <fieldset key={chapter.key} disabled={busy || confirmed !== null}>
                  <legend>第 {index + 1} 项</legend>
                  <label>
                    章节标题
                    <input
                      value={chapter.title}
                      maxLength={200}
                      onChange={(event) => update(index, { title: event.target.value })}
                    />
                  </label>
                  <label>
                    章节内容
                    <textarea
                      value={chapter.content}
                      onChange={(event) => update(index, { content: event.target.value })}
                      rows={6}
                    />
                  </label>
                  <div className="row">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() =>
                        setChapters((items) => {
                          const result = [...items];
                          const previous = result[index - 1];
                          if (previous) {
                            result[index - 1] = chapter;
                            result[index] = previous;
                          }
                          return result;
                        })
                      }
                    >
                      前移
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setChapters((items) => items.filter((_, offset) => offset !== index))
                      }
                    >
                      删除此预览项
                    </button>
                  </div>
                </fieldset>
              ))}
            </div>
            {!confirmed && (
              <div className="row">
                <button
                  type="button"
                  onClick={() =>
                    setChapters((items) => [
                      ...items,
                      { key: crypto.randomUUID(), title: '新增章节', content: '' },
                    ])
                  }
                >
                  添加预览章节
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void api
                      .structure(structure.project.id)
                      .then((latest) => {
                        setBase(latest.project.structureVersion);
                        setError('已读取最新结构版本，预览修改已保留；请检查目标卷后再次确认');
                      })
                      .catch((error: Error) => setError(error.message));
                  }}
                >
                  刷新结构版本，保留预览
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || chapters.length === 0}
                  onClick={() => {
                    void confirm();
                  }}
                >
                  确认导入 {chapters.length} 章
                </button>
              </div>
            )}
            {confirmed && (
              <button
                type="button"
                onClick={() => {
                  void onImported(confirmed)
                    .then(onClose)
                    .catch((error: Error) => setError(error.message));
                }}
              >
                已导入，重新打开目录
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
