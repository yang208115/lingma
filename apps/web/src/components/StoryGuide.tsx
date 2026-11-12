import {
  basicInformationKinds,
  type ElementCandidate,
  type ElementEntry,
  type ElementGeneration,
  elementFields,
  elementLabels,
  hasElementContent,
  type ProviderConfig,
} from '@lingma/shared';
import { ArrowUp, BookOpen, LoaderCircle, MessageCircle, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MarkdownContent } from './MarkdownContent.js';
import { ShioriAvatar } from './Shiori.js';

export function StoryGuide({
  projectId,
  entries,
  jobs,
  providers,
  providerId,
  busy,
  onProvider,
  onModels,
  onSend,
  onRetry,
  onDecide,
  onEdit,
  onOpenEntry,
}: {
  projectId: string;
  entries: ElementEntry[];
  jobs: ElementGeneration[];
  providers: ProviderConfig[];
  providerId: string;
  busy: boolean;
  onProvider(id: string): void;
  onModels(): void;
  onSend(text: string): Promise<void>;
  onRetry(job: ElementGeneration): void;
  onDecide(
    job: ElementGeneration,
    candidates: ElementCandidate[],
    action: 'accept' | 'reject',
  ): void;
  onEdit(candidate: ElementCandidate): void;
  onOpenEntry(entry: ElementEntry): void;
}) {
  const storageKey = `lingma:story-guide-draft:${projectId}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  const [storageError, setStorageError] = useState(false);
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const turns = jobs
    .filter((job) => job.input.guided)
    .slice()
    .reverse();
  const running = jobs.some((job) => ['queued', 'running'].includes(job.status));
  const disabled = busy || sending || running;
  const latest = turns.at(-1);
  const filled = entries.filter((entry) => entry.status !== 'archived' && hasElementContent(entry));
  useEffect(() => {
    try {
      if (text) localStorage.setItem(storageKey, text);
      else localStorage.removeItem(storageKey);
    } catch {
      setStorageError(true);
    }
  }, [storageKey, text]);
  useEffect(() => {
    if (latest?.id && latest.status) end.current?.scrollIntoView({ block: 'nearest' });
  }, [latest?.id, latest?.status]);
  async function send() {
    if (disabled || !text.trim()) return;
    setSending(true);
    try {
      await onSend(text.trim());
      setText('');
    } catch {
      // Keep the author's answer available for retry.
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="story-guide-layout">
      <section className="story-guide-conversation" aria-label="故事引导对话">
        <div className="story-guide-messages">
          <div className="story-guide-intro">
            <div className="story-guide-companion">
              <ShioriAvatar size="large" />
              <span>栞 · 你的创作搭档</span>
            </div>
            <p className="eyebrow">从一个想法，慢慢聊成一个故事</p>
            <h2>{filled.length ? '接着聊聊你的故事' : '你想写一个怎样的故事？'}</h2>
            <p>简单说说人物、世界，或者脑海里的一个片段。不用一次想完整，我们一起慢慢补全。</p>
            {!turns.length && filled.length > 0 && (
              <p className="story-guide-example">
                已有设定会作为聊天的依据。你想先完善哪里，或改动什么？
              </p>
            )}
          </div>
          {turns.map((job) => (
            <div className="story-guide-turn" key={job.id}>
              <div className="story-guide-author">
                <span>你</span>
                <p>{job.input.idea}</p>
              </div>
              <article className="story-guide-reply" aria-label="创作搭档回复">
                <span
                  className={`story-guide-speaker${['queued', 'running'].includes(job.status) ? ' is-thinking' : ''}`}
                >
                  <ShioriAvatar size="small" /> 栞 · 创作搭档
                </span>
                {job.guidance && <MarkdownContent text={job.guidance.reply} />}
                {job.candidates.filter((candidate) => candidate.status === 'pending').length >
                  1 && (
                  <div className="row">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        onDecide(
                          job,
                          job.candidates.filter((candidate) => candidate.status === 'pending'),
                          'accept',
                        )
                      }
                    >
                      采用本轮全部建议
                    </button>
                    <small className="muted">
                      本轮共{' '}
                      {job.candidates.filter((candidate) => candidate.status === 'pending').length}{' '}
                      条修改，涉及
                      {[
                        ...new Set(
                          job.candidates
                            .filter((candidate) => candidate.status === 'pending')
                            .map((candidate) => elementLabels[candidate.kind]),
                        ),
                      ].join('、')}
                      ，可一并采用。
                    </small>
                  </div>
                )}
                {job.candidates.map((candidate) => (
                  <section
                    className="story-guide-suggestion"
                    key={candidate.id}
                    aria-label={`设定建议：${candidate.title}`}
                  >
                    <div className="row">
                      <small>{elementLabels[candidate.kind]}</small>
                      <span className="muted fine">
                        {candidate.status === 'accepted'
                          ? '已采用'
                          : candidate.status === 'rejected'
                            ? '已跳过'
                            : '建议 · 待采用'}
                      </span>
                    </div>
                    <h3>{candidate.title}</h3>
                    {candidate.data.summary && <p>{candidate.data.summary}</p>}
                    <dl>
                      {Object.entries(candidate.data.fields)
                        .filter(([, value]) => value.trim())
                        .map(([key, value]) => (
                          <div key={key}>
                            <dt>{elementFields[candidate.kind][key] ?? key}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                    </dl>
                    {candidate.content && <MarkdownContent text={candidate.content} />}
                    {candidate.reason && <p className="muted fine">{candidate.reason}</p>}
                    {candidate.status === 'pending' && (
                      <div className="row">
                        <button
                          type="button"
                          className="primary"
                          disabled={
                            disabled ||
                            candidate.data.links.some((link) =>
                              job.candidates.some(
                                (dependency) =>
                                  dependency.tempId === link.targetId &&
                                  dependency.status !== 'accepted',
                              ),
                            )
                          }
                          title="有关联的待采用设定时，请使用「采用本轮全部建议」，或先编辑关联。"
                          onClick={() => onDecide(job, [candidate], 'accept')}
                        >
                          采用这条设定
                        </button>
                        <button type="button" disabled={disabled} onClick={() => onEdit(candidate)}>
                          编辑后采用
                        </button>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => onDecide(job, [candidate], 'reject')}
                        >
                          跳过建议
                        </button>
                      </div>
                    )}
                  </section>
                ))}
                {job.guidance && (
                  <p className="story-guide-question">
                    <MessageCircle size={16} aria-hidden="true" />
                    {job.guidance.question}
                  </p>
                )}
                {['queued', 'running'].includes(job.status) && (
                  <div className="story-guide-thinking" role="status">
                    <div className="story-guide-thinking-line">
                      <span className="story-guide-thinking-dots" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                      <span>
                        {job.error ? '正在修复本轮设定的关联与格式…' : '正在整理你的想法…'}
                      </span>
                    </div>
                    <div className="story-guide-thinking-track" aria-hidden="true" />
                  </div>
                )}
                {job.error && !['queued', 'running'].includes(job.status) && (
                  <p className="error" role="alert">
                    {job.error}
                  </p>
                )}
                {['cancelled', 'interrupted'].includes(job.status) && !job.error && (
                  <p className="muted">本轮已中断。</p>
                )}
                {['failed', 'partial', 'cancelled', 'interrupted'].includes(job.status) && (
                  <button
                    type="button"
                    className="story-guide-retry"
                    disabled={disabled}
                    onClick={() => onRetry(job)}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    重试这条
                  </button>
                )}
              </article>
            </div>
          ))}
          <div ref={end} />
        </div>
        <form
          className="story-guide-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label className="sr-only" htmlFor={`story-guide-answer-${projectId}`}>
            {turns.length ? '接着说说你的想法' : '你的故事想法'}
          </label>
          <textarea
            id={`story-guide-answer-${projectId}`}
            rows={2}
            maxLength={12000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              turns.length
                ? '回答刚才的问题，或者聊聊你更想先确定的部分…'
                : '我想写一个关于……的故事'
            }
          />
          <div className="story-guide-composer-actions">
            {providers.length ? (
              <label>
                模型
                <select
                  aria-label="引导对话模型"
                  value={providerId}
                  disabled={disabled}
                  onChange={(event) => onProvider(event.target.value)}
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.config.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <button type="button" onClick={onModels}>
                配置模型
              </button>
            )}
            <button
              type="submit"
              className="primary story-guide-submit"
              disabled={disabled || !text.trim()}
              data-loading={sending || running}
            >
              {sending || running ? (
                <LoaderCircle size={15} className="is-spinning" aria-hidden="true" />
              ) : (
                <ArrowUp size={15} aria-hidden="true" />
              )}
              {sending || running ? '整理中…' : turns.length ? '继续聊' : '开始聊故事'}
            </button>
          </div>
          {storageError && (
            <p className="error fine">浏览器暂时无法保存输入草稿，请保持页面打开并及时发送。</p>
          )}
        </form>
      </section>
      <aside className="story-guide-archive" aria-label="故事档案">
        <div className="row">
          <BookOpen size={18} aria-hidden="true" />
          <h2>故事正在成形</h2>
        </div>
        <p className="muted fine">已保存的设定会同步到高级模式。</p>
        {basicInformationKinds.map((kind) => {
          const items = filled.filter((entry) => entry.document.kind === kind);
          return (
            <section key={kind}>
              <div className="row">
                <h3>{elementLabels[kind]}</h3>
                <small className="muted">{items.length ? `${items.length} 条` : '待聊聊'}</small>
              </div>
              {items.length ? (
                items.map((entry) => (
                  <button
                    type="button"
                    key={entry.document.id}
                    disabled={disabled}
                    onClick={() => onOpenEntry(entry)}
                  >
                    <strong>{entry.document.title}</strong>
                    <span>
                      {entry.data.summary ||
                        Object.values(entry.data.fields).find((value) => value.trim()) ||
                        entry.version.content.slice(0, 100)}
                    </span>
                  </button>
                ))
              ) : (
                <p className="muted fine">
                  {kind === 'story_premise' ? '从你的故事想法开始整理' : '聊到这里时再慢慢补全'}
                </p>
              )}
            </section>
          );
        })}
      </aside>
    </div>
  );
}
