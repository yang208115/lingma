import { isStoryEventKind, type PutStructure, type Structure } from '@lingma/shared';
import { ArrowDown, ArrowUp, BookOpen, Layers3, ListTree, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api.js';
import { Modal } from './Modal.js';

function inputFrom(structure: Structure): PutStructure {
  return {
    baseStructureVersion: structure.project.structureVersion,
    volumes: structure.volumes.map(({ id, title, sortOrder }) => ({ id, title, sortOrder })),
    documents: structure.documents.map(({ id, title, volumeId, sortOrder }) => ({
      id,
      title,
      volumeId,
      sortOrder,
    })),
  };
}
const byOrder = (a: { sortOrder: number; id: string }, b: { sortOrder: number; id: string }) =>
  a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);

function reorder<T extends { id: string; sortOrder: number }>(
  items: T[],
  groupIds: string[],
  id: string,
  direction: number,
): T[] {
  const ordered = [...items].sort(byOrder);
  const allowed = new Set(groupIds);
  const group = ordered.filter((item) => allowed.has(item.id));
  const index = group.findIndex((item) => item.id === id);
  const current = group[index];
  const other = group[index + direction];
  if (!current || !other) return items;
  const left = ordered.indexOf(current);
  const right = ordered.indexOf(other);
  [ordered[left], ordered[right]] = [other, current];
  // Swap this group's slots; other document kinds retain their relative positions.
  return ordered.map((item, sortOrder) => ({ ...item, sortOrder }));
}

type EditableDocument = PutStructure['documents'][number];
export function StructureDialog({
  structure,
  scope = 'chapters',
  initialOutlineKind = 'master_outline',
  onSaved,
  onClose,
}: {
  structure: Structure;
  scope?: 'chapters' | 'outlines';
  initialOutlineKind?: 'master_outline' | 'chapter_outline';
  onSaved(structure: Structure): void;
  onClose(): void;
}) {
  const [snapshot, setSnapshot] = useState(structure);
  const [input, setInput] = useState(() => inputFrom(structure));
  const [outlineKind, setOutlineKind] = useState(initialOutlineKind);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const outlinesOnly = scope === 'outlines';
  const originals = new Map(snapshot.documents.map((document) => [document.id, document]));
  const originalVolumes = new Map(snapshot.volumes.map((volume) => [volume.id, volume]));
  const documents = [...input.documents].sort(byOrder);
  const volumes = [...input.volumes].sort(byOrder);
  const chapters = documents.filter((document) => originals.get(document.id)?.kind === 'chapter');
  const masterOutlines = documents.filter(
    (document) => originals.get(document.id)?.kind === 'master_outline',
  );
  const chapterOutlines = documents.filter(
    (document) =>
      isStoryEventKind(originals.get(document.id)?.kind ?? '') &&
      !originals.get(document.id)?.archived,
  );
  const changed =
    input.volumes.length !== snapshot.volumes.length ||
    input.volumes.some((volume) => {
      const original = originalVolumes.get(volume.id);
      return (
        !original || volume.title !== original.title || volume.sortOrder !== original.sortOrder
      );
    }) ||
    input.documents.some((document) => {
      const original = originals.get(document.id);
      return (
        original &&
        (document.title !== original.title ||
          document.volumeId !== original.volumeId ||
          document.sortOrder !== original.sortOrder)
      );
    });

  async function save() {
    setBusy(true);
    setError('');
    try {
      onSaved(await api.putStructure(snapshot.project.id, input));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，修改已保留');
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    setError('');
    try {
      const latest = await api.structure(snapshot.project.id);
      setSnapshot(latest);
      setInput(inputFrom(latest));
      onSaved(latest);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重新载入失败，修改已保留');
    } finally {
      setBusy(false);
    }
  }
  function orderButtons(
    kind: 'volumes' | 'documents',
    item: { id: string; title: string },
    group: { id: string }[],
  ) {
    const index = group.findIndex((entry) => entry.id === item.id);
    const move = (direction: number) =>
      setInput((previous) =>
        kind === 'volumes'
          ? {
              ...previous,
              volumes: reorder(
                previous.volumes,
                group.map((entry) => entry.id),
                item.id,
                direction,
              ),
            }
          : {
              ...previous,
              documents: reorder(
                previous.documents,
                group.map((entry) => entry.id),
                item.id,
                direction,
              ),
            },
      );
    return (
      <div className="structure-order-actions">
        <button
          type="button"
          disabled={busy || index === 0}
          aria-label={`上移 ${item.title}`}
          title="上移"
          onClick={() => move(-1)}
        >
          <ArrowUp size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={busy || index === group.length - 1}
          aria-label={`下移 ${item.title}`}
          title="下移"
          onClick={() => move(1)}
        >
          <ArrowDown size={14} aria-hidden="true" />
        </button>
      </div>
    );
  }
  function documentRows(group: EditableDocument[], label: string, canAssignVolume = false) {
    return group.map((document, index) => (
      <div className="structure-document-row" key={document.id}>
        <span className="structure-position" aria-hidden="true">
          {String(index + 1).padStart(2, '0')}
        </span>
        <input
          required
          pattern=".*\S.*"
          aria-label={`${label}标题：${originals.get(document.id)?.title ?? ''}`}
          value={document.title}
          maxLength={200}
          disabled={busy}
          onChange={(event) =>
            setInput((previous) => ({
              ...previous,
              documents: previous.documents.map((item) =>
                item.id === document.id ? { ...item, title: event.target.value } : item,
              ),
            }))
          }
        />
        {canAssignVolume && (
          <select
            aria-label={`${document.title} 所属卷`}
            value={document.volumeId ?? ''}
            disabled={busy}
            onChange={(event) =>
              setInput((previous) => ({
                ...previous,
                documents: previous.documents.map((item) =>
                  item.id === document.id
                    ? { ...item, volumeId: event.target.value || null }
                    : item,
                ),
              }))
            }
          >
            <option value="">未分卷</option>
            {volumes.map((volume) => (
              <option key={volume.id} value={volume.id}>
                {volume.title}
              </option>
            ))}
          </select>
        )}
        {orderButtons('documents', document, group)}
      </div>
    ));
  }
  const title = outlinesOnly ? '大纲管理' : '卷章管理';
  return (
    <Modal
      labelledBy="structure-title"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="dialog wide structure-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="structure-dialog-header">
          <div className="structure-dialog-title">
            {outlinesOnly ? (
              <ListTree size={20} aria-hidden="true" />
            ) : (
              <BookOpen size={20} aria-hidden="true" />
            )}
            <div>
              <h2 id="structure-title">{title}</h2>
              <p>{snapshot.project.title}</p>
            </div>
          </div>
          <button
            type="button"
            className="structure-close"
            disabled={busy}
            aria-label={`关闭${title}`}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {outlinesOnly ? (
          <nav className="structure-tabs" aria-label="大纲类型">
            <button
              type="button"
              aria-pressed={outlineKind === 'master_outline'}
              onClick={() => setOutlineKind('master_outline')}
            >
              故事总纲 <span>{masterOutlines.length}</span>
            </button>
            <button
              type="button"
              aria-pressed={outlineKind === 'chapter_outline'}
              onClick={() => setOutlineKind('chapter_outline')}
            >
              故事时间线 <span>{chapterOutlines.length}</span>
            </button>
          </nav>
        ) : (
          <div className="structure-summary">
            <span>{volumes.length} 卷</span>
            <span>{chapters.length} 章</span>
            <span>按卷整理章节与顺序</span>
          </div>
        )}
        <div className="structure-dialog-body">
          {error && (
            <p role="alert" className="error">
              {error}（当前修改已保留）
            </p>
          )}
          {outlinesOnly ? (
            outlineKind === 'master_outline' ? (
              <section className="structure-group">
                <div className="structure-group-heading">
                  <h3>故事总纲</h3>
                  <span>调整标题与排列顺序</span>
                </div>
                {documentRows(masterOutlines, '总纲')}
                {!masterOutlines.length && (
                  <p className="structure-empty">暂无故事总纲，可在大纲页新建。</p>
                )}
              </section>
            ) : (
              <section className="structure-group">
                <div className="structure-group-heading">
                  <h3>故事时间线</h3>
                  <span>按事件实际发生顺序排列，章节阅读顺序独立管理</span>
                </div>
                {documentRows(chapterOutlines, '事件')}
                {!chapterOutlines.length && (
                  <p className="structure-empty">暂无故事事件，可在时间线中添加。</p>
                )}
              </section>
            )
          ) : (
            <>
              <div className="structure-chapters-heading">
                <p>调整章节名称、所属卷与卷内顺序。</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setInput((previous) => ({
                      ...previous,
                      volumes: [
                        ...previous.volumes,
                        {
                          id: crypto.randomUUID(),
                          title: '新卷',
                          sortOrder:
                            previous.volumes.reduce(
                              (max, volume) => Math.max(max, volume.sortOrder),
                              -1,
                            ) + 1,
                        },
                      ],
                    }))
                  }
                >
                  <Plus size={14} aria-hidden="true" /> 添加卷
                </button>
              </div>
              {[null, ...volumes].map((volume) => {
                const group = chapters.filter(
                  (chapter) => chapter.volumeId === (volume?.id ?? null),
                );
                return (
                  <section className="structure-group" key={volume?.id ?? 'unassigned'}>
                    <div className="structure-volume-heading">
                      <Layers3 size={16} aria-hidden="true" />
                      {volume ? (
                        <input
                          required
                          pattern=".*\S.*"
                          aria-label="卷标题"
                          value={volume.title}
                          maxLength={200}
                          disabled={busy}
                          onChange={(event) =>
                            setInput((previous) => ({
                              ...previous,
                              volumes: previous.volumes.map((item) =>
                                item.id === volume.id
                                  ? { ...item, title: event.target.value }
                                  : item,
                              ),
                            }))
                          }
                        />
                      ) : (
                        <h3>未分卷</h3>
                      )}
                      <span className="structure-group-count">{group.length} 章</span>
                      {volume && (
                        <>
                          {orderButtons('volumes', volume, volumes)}
                          <button
                            type="button"
                            className="structure-remove-volume"
                            disabled={busy}
                            title="移除卷，章节移至未分卷；保存后生效"
                            aria-label={`移除卷 ${volume.title}，章节移至未分卷`}
                            onClick={() =>
                              setInput((previous) => ({
                                ...previous,
                                volumes: previous.volumes.filter((item) => item.id !== volume.id),
                                documents: previous.documents.map((item) =>
                                  item.volumeId === volume.id ? { ...item, volumeId: null } : item,
                                ),
                              }))
                            }
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        </>
                      )}
                    </div>
                    {documentRows(group, '章节', true)}
                    {!group.length && <p className="structure-empty">暂无章节</p>}
                  </section>
                );
              })}
            </>
          )}
        </div>
        <footer className="structure-dialog-footer">
          <span role="status">{changed ? '有未保存的目录修改' : '目录已同步'}</span>
          <button
            type="button"
            className="structure-reload"
            disabled={busy}
            onClick={() => void reload()}
          >
            放弃修改并重新载入
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !changed} type="submit">
            {busy ? '正在处理…' : '保存修改'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
