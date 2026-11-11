import {
  type Document,
  isStoryEventKind,
  linkedChapterIds,
  orderedChapters,
  type Structure,
  type UpdateChapterPlan,
} from '@lingma/shared';
import { useState } from 'react';
import { Modal } from './Modal.js';

export type ChapterPlanningRequest = {
  sourceOutlineId?: string;
  chapterCount?: number;
  volumeId: string | null;
  newVolumeTitle?: string;
};
export type PlanningInsertion = {
  id: string;
  text: string;
  planning?: ChapterPlanningRequest;
  autoStart?: boolean;
};

export function ChapterPlanningDialog({
  structure,
  source,
  onStart,
  onClose,
}: {
  structure: Structure;
  source: Document | undefined;
  onStart(request: ChapterPlanningRequest): Promise<void>;
  onClose(): void;
}) {
  const [sourceId, setSourceId] = useState(source?.id ?? '');
  const existingVolume = structure.volumes.find((volume) => volume.title === source?.title);
  const [volumeId, setVolumeId] = useState(
    source?.volumeId ?? existingVolume?.id ?? (source?.title.match(/^第.+卷/) ? 'new' : ''),
  );
  const [volumeTitle, setVolumeTitle] = useState(source?.title ?? '');
  const [count, setCount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const siblings = structure.documents.filter(
    (item) => item.kind === 'chapter_plan' && item.parentOutlineId === sourceId,
  );
  return (
    <Modal
      labelledBy="chapter-planning-title"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          void onStart({
            ...(sourceId ? { sourceOutlineId: sourceId } : {}),
            ...(count ? { chapterCount: Number(count) } : {}),
            volumeId: volumeId === 'new' ? null : volumeId || null,
            ...(volumeId === 'new' ? { newVolumeTitle: volumeTitle.trim() } : {}),
          })
            .then(onClose)
            .catch((cause: Error) => setError(cause.message))
            .finally(() => setBusy(false));
        }}
      >
        <h2 id="chapter-planning-title">拆分章纲</h2>
        <p className="muted">
          AI
          会根据规划中的情节和节奏自动安排章数，拆好每章的目标、场景与转折。生成后由你审阅并采用。
        </p>
        <label>
          来源规划
          <select
            value={sourceId}
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              setSourceId(id);
              const title = structure.documents.find((item) => item.id === id)?.title ?? '';
              const volume = structure.volumes.find((item) => item.title === title);
              setVolumeId(
                structure.documents.find((item) => item.id === id)?.volumeId ??
                  volume?.id ??
                  (/^第.+卷/.test(title) ? 'new' : ''),
              );
              setVolumeTitle(title);
            }}
          >
            <option value="">不指定，按本次要求规划</option>
            {structure.documents
              .filter(
                (item) =>
                  !item.archived && (isStoryEventKind(item.kind) || item.kind === 'master_outline'),
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        </label>
        {siblings.length > 0 && (
          <p className="warning">
            此规划已有 {siblings.length} 份章纲，AI
            会参考已有内容，补足尚未覆盖的情节。新章纲仍需你确认后保存。
          </p>
        )}
        <details>
          <summary>高级设置（可选）</summary>
          <label>
            指定章数
            <input
              type="number"
              min={1}
              max={30}
              value={count}
              placeholder="由 AI 自动安排"
              disabled={busy}
              onChange={(event) => setCount(event.target.value)}
            />
          </label>
          <label>
            所属卷
            <select
              value={volumeId}
              disabled={busy}
              onChange={(event) => setVolumeId(event.target.value)}
            >
              <option value="">未分卷</option>
              {structure.volumes.map((volume) => (
                <option key={volume.id} value={volume.id}>
                  {volume.title}
                </option>
              ))}
              <option value="new">＋ 新建卷</option>
            </select>
          </label>
          {volumeId === 'new' && (
            <label>
              新卷名称
              <input
                required
                maxLength={200}
                pattern=".*\S.*"
                value={volumeTitle}
                disabled={busy}
                onChange={(event) => setVolumeTitle(event.target.value)}
              />
            </label>
          )}
        </details>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '正在启动…' : '开始 AI 拆分'}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ChapterPlanList({
  source,
  structure,
  busy,
  onOpen,
  onDraft,
  onCreate,
  onGenerate,
}: {
  source: Document;
  structure: Structure;
  busy: boolean;
  onOpen(id: string): void;
  onDraft(id: string): void;
  onCreate(): void;
  onGenerate(): void;
}) {
  const plans = structure.documents
    .filter(
      (item) =>
        item.kind === 'chapter_plan' && item.parentOutlineId === source.id && !item.archived,
    )
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const linked = plans.filter((item) => linkedChapterIds(item).length > 0).length;
  return (
    <section className="chapter-plan-list outline-reader-section" aria-label="分章计划">
      <div className="chapter-plan-heading">
        <h2>
          分章计划{' '}
          <small>{plans.length ? `${linked} / ${plans.length} 已关联正文` : '尚未拆章'}</small>
        </h2>
        <div className="row">
          <button type="button" disabled={busy || source.archived} onClick={onGenerate}>
            AI 拆分章纲
          </button>
          <button type="button" disabled={busy || source.archived} onClick={onCreate}>
            添加章纲
          </button>
        </div>
      </div>
      {!plans.length && (
        <p className="muted">先拆出每章的目标、场景和转折，再按章纲逐章展开，避免整卷挤在一章。</p>
      )}
      <ol>
        {plans.map((plan) => {
          const chapterId = linkedChapterIds(plan)[0];
          return (
            <li key={plan.id}>
              <button type="button" className="chapter-plan-open" onClick={() => onOpen(plan.id)}>
                <strong>{plan.title}</strong>
                {plan.summary && <span>{plan.summary}</span>}
                <small>
                  {structure.volumes.find((volume) => volume.id === plan.volumeId)?.title ??
                    '未分卷'}{' '}
                  · {chapterId ? '已关联正文' : '待写正文'}
                </small>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => (chapterId ? onDraft(chapterId) : onDraft(plan.id))}
              >
                {chapterId ? '打开正文' : '按章纲写正文'}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function ChapterPlanDetails({
  plan,
  structure,
  busy,
  onOpen,
  onSave,
}: {
  plan: Document;
  structure: Structure;
  busy: boolean;
  onOpen(id: string): void;
  onSave(input: UpdateChapterPlan): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState<UpdateChapterPlan>(() => ({
    baseStructureVersion: structure.project.structureVersion,
    title: plan.title,
    storyTime: plan.storyTime ?? '',
    summary: plan.summary ?? '',
    chapterIds: linkedChapterIds(plan),
    volumeId: plan.volumeId,
    parentOutlineId: plan.parentOutlineId ?? null,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const parent = structure.documents.find((item) => item.id === plan.parentOutlineId);
  const chapters = orderedChapters(structure);
  return (
    <section
      className="outline-reader-section chapter-plan-details"
      aria-label="章纲信息与正文关联"
    >
      <div className="chapter-plan-heading">
        <h2>章纲归属与进度</h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setInput({ ...input, baseStructureVersion: structure.project.structureVersion });
            setEditing(true);
          }}
        >
          编辑关联
        </button>
      </div>
      <p>
        所属卷：{structure.volumes.find((volume) => volume.id === plan.volumeId)?.title ?? '未分卷'}
      </p>
      <p>
        来源规划：
        {parent ? (
          <button type="button" onClick={() => onOpen(parent.id)}>
            {parent.title}
          </button>
        ) : (
          '独立章纲'
        )}
      </p>
      {linkedChapterIds(plan).length ? (
        <ul>
          {chapters
            .filter((item) => linkedChapterIds(plan).includes(item.id))
            .map((chapter) => (
              <li key={chapter.id}>
                <button type="button" onClick={() => onOpen(chapter.id)}>
                  打开正文：{chapter.title}
                </button>
              </li>
            ))}
        </ul>
      ) : (
        <p className="muted">待写正文 · 仅展开本章情节，后续转折留给后续章节。</p>
      )}
      {editing && (
        <Modal
          labelledBy="chapter-plan-details-title"
          onClose={() => {
            if (!saving) setEditing(false);
          }}
        >
          <form
            className="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              setSaving(true);
              setError('');
              void onSave(input)
                .then(() => setEditing(false))
                .catch((cause: Error) => setError(cause.message))
                .finally(() => setSaving(false));
            }}
          >
            <h2 id="chapter-plan-details-title">编辑章纲信息</h2>
            <label>
              章纲标题
              <input
                required
                maxLength={200}
                value={input.title}
                onChange={(event) => setInput({ ...input, title: event.target.value })}
              />
            </label>
            <label>
              概述
              <textarea
                maxLength={1000}
                value={input.summary}
                onChange={(event) => setInput({ ...input, summary: event.target.value })}
              />
            </label>
            <label>
              来源规划
              <select
                value={input.parentOutlineId ?? ''}
                onChange={(event) =>
                  setInput({ ...input, parentOutlineId: event.target.value || null })
                }
              >
                <option value="">独立章纲</option>
                {structure.documents
                  .filter(
                    (item) =>
                      !item.archived &&
                      (isStoryEventKind(item.kind) || item.kind === 'master_outline'),
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              所属卷
              <select
                value={input.volumeId ?? ''}
                onChange={(event) => setInput({ ...input, volumeId: event.target.value || null })}
              >
                <option value="">未分卷</option>
                {structure.volumes.map((volume) => (
                  <option key={volume.id} value={volume.id}>
                    {volume.title}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>关联已有正文</legend>
              {chapters.length ? (
                chapters.map((chapter) => (
                  <label key={chapter.id} className="checkbox">
                    <input
                      type="checkbox"
                      checked={input.chapterIds.includes(chapter.id)}
                      onChange={(event) =>
                        setInput({
                          ...input,
                          chapterIds: event.target.checked
                            ? [...input.chapterIds, chapter.id]
                            : input.chapterIds.filter((id) => id !== chapter.id),
                        })
                      }
                    />
                    {chapter.title}
                  </label>
                ))
              ) : (
                <p className="muted">尚无正文</p>
              )}
            </fieldset>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="row">
              <button type="submit" className="primary" disabled={saving}>
                保存
              </button>
              <button type="button" disabled={saving} onClick={() => setEditing(false)}>
                取消
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
