import type { Project, Skill, SkillDetail, SkillImportJob, SkillListFilter } from '@lingma/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.js';
import { useLeaveGuard } from '../runtime.js';
import { skillApi } from '../skill-api.js';
import { DiffView } from './DiffView.js';
import { SkillMarkdown } from './SkillMarkdown.js';

const active = (job: SkillImportJob) => ['queued', 'fetching', 'publishing'].includes(job.status);
const statuses = {
  queued: '等待导入',
  fetching: '正在下载',
  publishing: '正在保存',
  completed: '导入完成',
  failed: '导入失败',
  interrupted: '导入中断',
};
type Summary = { id: string; versionNo: number; createdAt: string };
export function SkillManager({
  onClose,
  projectId,
  projects,
}: {
  onClose(): void;
  projectId?: string | undefined;
  projects: Project[];
}) {
  const filter = useRef<SkillListFilter>(
    projectId ? { scope: 'project', projectId } : { scope: 'general' },
  ).current;
  const title = projectId ? '项目 Skill' : '通用 Skill';
  const [skills, setSkills] = useState<Skill[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [entry, setEntry] = useState('');
  const [editing, setEditing] = useState(false);
  const [versions, setVersions] = useState<Summary[]>([]);
  const [versionCursor, setVersionCursor] = useState<string | null>(null);
  const [comparison, setComparison] = useState<SkillDetail | null>(null);
  const [remote, setRemote] = useState<SkillDetail | null>(null);
  const [jobs, setJobs] = useState<SkillImportJob[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [repository, setRepository] = useState('');
  const [subdir, setSubdir] = useState('');
  const [file, setFile] = useState<{ path: string; text: string | null } | null>(null);
  const [showImports, setShowImports] = useState(false);
  const fileRequest = useRef(0);
  const detailRequest = useRef(0);
  const loaded = useRef(new Set<string>());
  const dirty = Boolean(detail && entry !== detail.version.entryContent);
  useLeaveGuard(dirty, 'Skill 编辑尚未保存，离开将放弃这些编辑。');
  const historical = Boolean(detail && detail.version.id !== detail.skill.currentVersionId);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  const refreshList = useCallback(async () => {
    const result = await skillApi.list(undefined, filter);
    setSkills(result.data);
    setCursor(result.nextCursor);
  }, [filter]);
  async function history(id: string) {
    const result = await skillApi.versions(id);
    setVersions(result.data);
    setVersionCursor(result.nextCursor);
  }
  function accept(result: SkillDetail) {
    fileRequest.current++;
    setDetail(result);
    setEntry(result.version.entryContent);
    setRemote(null);
    setComparison(null);
    setFile(null);
    setEditing(false);
  }
  async function open(id: string, versionId?: string) {
    if (dirtyRef.current && !window.confirm('放弃尚未保存的 Skill 编辑？')) return;
    const request = ++detailRequest.current;
    setBusy(true);
    setError('');
    try {
      const [result, page] = await Promise.all([
        skillApi.detail(id, versionId),
        skillApi.versions(id),
      ]);
      if (request !== detailRequest.current) return;
      accept(result);
      setVersions(page.data);
      setVersionCursor(page.nextCursor);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let disposed = false;
    void Promise.all([skillApi.list(undefined, filter), skillApi.jobs(filter)])
      .then(([list, imports]) => {
        if (disposed) return;
        setSkills(list.data);
        setCursor(list.nextCursor);
        setJobs(imports);
        for (const job of imports) if (!active(job)) loaded.current.add(job.id);
      })
      .catch((error: unknown) => {
        if (!disposed) setError(message(error));
      });
    return () => {
      disposed = true;
    };
  }, [filter]);
  useEffect(() => {
    if (!jobs.some(active)) return;
    let disposed = false;
    const timer = setTimeout(() => {
      void skillApi
        .jobs(filter)
        .then(async (current) => {
          if (disposed) return;
          setJobs(current);
          for (const job of current)
            if (!active(job) && !loaded.current.has(job.id)) {
              loaded.current.add(job.id);
              if (job.status === 'completed' && job.skillId && job.versionId) {
                await refreshList();
                setNotice('导入完成。可在列表或导入记录中打开版本。');
              }
            }
        })
        .catch((error: unknown) => {
          if (!disposed) {
            setError(message(error));
            setJobs((previous) => [...previous]);
          }
        });
    }, 800);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [jobs, refreshList, filter]);
  async function beginImport(run: () => Promise<SkillImportJob>) {
    await action(async () => {
      const job = await run();
      setJobs((previous) => [job, ...previous.filter((item) => item.id !== job.id)]);
      setNotice('导入已开始，可在下方查看状态。');
    });
  }
  async function importDirectory(files: File[]) {
    await action(async () => {
      const result = await skillApi.localDirectory(
        files,
        (job) => {
          setJobs((previous) => [job, ...previous.filter((item) => item.id !== job.id)]);
          setNotice('正在逐项导入，请稍候…');
        },
        projectId ?? null,
      );
      await refreshList();
      setNotice(
        `导入完成 ${result.jobs.filter((job) => job.status === 'completed').length} 个 Skill，失败 ${result.failures.length} 项。${result.ignored.length ? `忽略 ${result.ignored.length} 个 Skill 目录外的文件。` : ''}可在下方查看各项结果。`,
      );
      if (result.failures.length)
        setError(
          result.failures.map((failure) => `${failure.directory}：${failure.message}`).join('\n'),
        );
    });
  }
  async function openFile(path: string) {
    if (!detail) return;
    if (!detail.version.files.some((file) => file.relativePath === path)) {
      setError(`关联文件缺失：${path}`);
      return;
    }
    const request = ++fileRequest.current;
    setError('');
    try {
      const bytes = await skillApi.file(detail.skill.id, detail.version.id, path);
      if (request !== fileRequest.current) return;
      let text: string | null = null;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (text.includes('\0')) text = null;
      } catch {
        /* Binary attachments are downloaded. */
      }
      setFile({ path, text });
    } catch (error) {
      setError(message(error));
    }
  }
  async function save() {
    if (!detail) return;
    await action(async () => {
      try {
        const result = await skillApi.save(detail.skill.id, detail.version.id, entry);
        accept(result);
        await refreshList();
        await history(result.skill.id);
        setNotice(`已保存为版本 ${result.version.versionNo}`);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
          setRemote(await skillApi.detail(detail.skill.id));
          setError('Skill 已被其他编辑或来源更新修改。你的编辑仍保留，请比较后合并。');
        } else throw error;
      }
    });
  }
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <section aria-label={title}>
      <div className="dialog skill-manager">
        <div className="dialog-heading">
          <div>
            <h2 id="skill-manager-title">{title}</h2>
            <p className="muted">
              {projectId
                ? `仅用于项目「${projects.find((project) => project.id === projectId)?.title ?? ''}」。写作时也可使用通用 Skill。`
                : '所有项目均可使用。项目专属规则可在当前作品的「项目 Skill」中管理。'}
            </p>
          </div>
          <button type="button" disabled={busy} onClick={close}>
            关闭 Skill 管理
          </button>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <div className="skill-layout">
          <aside className="skill-sidebar" aria-label="Skill 列表">
            <button type="button" disabled={busy} onClick={() => setShowImports((value) => !value)}>
              {showImports ? '收起导入' : '导入 Skill'}
            </button>
            {skills.length === 0 && (
              <p className="muted">还没有 Skill，请导入 SKILL.md 或完整目录。</p>
            )}
            {skills.map((skill) => (
              <button
                type="button"
                className={`document-link ${detail?.skill.id === skill.id ? 'selected' : ''}`}
                key={skill.id}
                disabled={busy}
                onClick={() => void open(skill.id)}
              >
                <span>{skill.name}</span>
                <small>{skill.source.type === 'git' ? 'Git' : '本地副本'}</small>
              </button>
            ))}
            {cursor && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const page = await skillApi.list(cursor, filter);
                    setSkills((list) => [...list, ...page.data]);
                    setCursor(page.nextCursor);
                  })
                }
              >
                更多 Skill
              </button>
            )}
          </aside>
          <main className="skill-content">
            {showImports && (
              <section className="skill-import" aria-label="导入 Skill">
                <h3>导入 Skill</h3>
                <p>
                  导入到：{title}
                  {projectId
                    ? ` · ${projects.find((project) => project.id === projectId)?.title ?? ''}`
                    : ''}
                </p>
                <p>
                  可选择单个 Skill 目录，或包含多个 Skill 的父目录，自动查找子目录中的 SKILL.md
                  并分别导入。每个 Skill 独立限制为 200 个文件、合计 16 MiB，单文件最多 2
                  MiB，入口最多 256 KiB。仅上传入口文件时会提示缺失附件。
                </p>
                <label>
                  上传文件
                  <input
                    type="file"
                    multiple
                    disabled={busy}
                    onChange={(event) => {
                      const files = [...(event.target.files ?? [])];
                      event.target.value = '';
                      if (files.length)
                        void beginImport(() =>
                          skillApi.local(files, undefined, undefined, projectId ?? null),
                        );
                    }}
                  />
                </label>
                <label>
                  上传完整目录
                  <input
                    ref={(input) => {
                      input?.setAttribute('webkitdirectory', '');
                    }}
                    type="file"
                    multiple
                    disabled={busy}
                    onChange={(event) => {
                      const files = [...(event.target.files ?? [])];
                      event.target.value = '';
                      if (files.length) void importDirectory(files);
                    }}
                  />
                </label>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void beginImport(() => skillApi.git({ repository, subdir }, projectId ?? null));
                  }}
                >
                  <label>
                    公开 HTTPS 仓库
                    <input
                      type="url"
                      required
                      placeholder="https://github.com/owner/repository.git"
                      value={repository}
                      onChange={(event) => setRepository(event.target.value)}
                    />
                  </label>
                  <label>
                    Skill 子目录
                    <input
                      value={subdir}
                      placeholder="skills/example（仓库根部可留空）"
                      onChange={(event) => setSubdir(event.target.value)}
                    />
                  </label>
                  <button type="submit" disabled={busy}>
                    从 Git 导入
                  </button>
                </form>
              </section>
            )}
            {!detail ? (
              <p className="empty-state">选择 Skill 或导入新副本，开始查看与编辑。</p>
            ) : (
              <>
                <div className="dialog-heading">
                  <h3>{detail.skill.name}</h3>
                  <button
                    type="button"
                    disabled={busy || historical}
                    onClick={() => setEditing((value) => !value)}
                  >
                    {editing ? '查看预览' : '编辑 SKILL.md'}
                  </button>
                </div>
                <label>
                  Skill 归属
                  <select
                    aria-label="Skill 归属"
                    value={detail.skill.projectId ?? ''}
                    disabled={busy || dirty || historical || Boolean(remote)}
                    onChange={(event) => {
                      const owner = event.target.value || null;
                      void action(async () => {
                        await skillApi.changeScope(
                          detail.skill.id,
                          detail.skill.currentVersionId,
                          owner,
                        );
                        setDetail(null);
                        setEntry('');
                        setEditing(false);
                        await refreshList();
                        setJobs(await skillApi.jobs(filter));
                        setNotice('已修改 Skill 归属，历史版本和附件均保留。');
                      });
                    }}
                  >
                    <option value="">通用 Skill · 所有项目可用</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        项目 Skill · {project.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  查看版本
                  <select
                    aria-label="查看 Skill 版本"
                    value={detail.version.id}
                    disabled={busy}
                    onChange={(event) => void open(detail.skill.id, event.target.value)}
                  >
                    {!versions.some((version) => version.id === detail.version.id) && (
                      <option value={detail.version.id}>版本 {detail.version.versionNo}</option>
                    )}
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        版本 {version.versionNo} · {new Date(version.createdAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
                {versionCursor && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const page = await skillApi.versions(detail.skill.id, versionCursor);
                        setVersions((previous) => [...previous, ...page.data]);
                        setVersionCursor(page.nextCursor);
                      })
                    }
                  >
                    更多历史版本
                  </button>
                )}
                {historical && (
                  <p>
                    正在查看历史版本。
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void open(detail.skill.id)}
                    >
                      返回最新版本
                    </button>
                  </p>
                )}
                <label>
                  skillVersionId
                  <input
                    readOnly
                    value={detail.version.id}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
                <p className="skill-source">
                  此版本来源：{detail.version.sourceSnapshot.type === 'git' ? 'Git' : '本地上传'} ·{' '}
                  {detail.version.sourceSnapshot.ref}
                  <br />
                  子目录：{detail.version.sourceSnapshot.subdir || '根目录'}
                  {detail.version.sourceSnapshot.commit && (
                    <>
                      <br />
                      提交：<code>{detail.version.sourceSnapshot.commit}</code>
                    </>
                  )}
                </p>
                {detail.parsed.warnings.map((warning) => (
                  <p className="warning" key={warning}>
                    {warning}
                  </p>
                ))}
                {detail.parsed.missingFiles.length > 0 && (
                  <p>缺失文件：{detail.parsed.missingFiles.join('、')}</p>
                )}
                {editing && !historical && (
                  <section aria-label="Skill 编辑">
                    <label htmlFor="skill-entry">SKILL.md 源码</label>
                    <textarea
                      id="skill-entry"
                      className="skill-editor"
                      value={entry}
                      onChange={(event) => setEntry(event.target.value)}
                      spellCheck={false}
                    />
                    <div className="actions">
                      <span>{dirty ? '有未保存的编辑' : '已保存'}</span>
                      <button
                        type="button"
                        disabled={busy || !dirty || Boolean(remote)}
                        onClick={() => void save()}
                      >
                        保存新版本
                      </button>
                    </div>
                  </section>
                )}
                {remote && (
                  <section className="conflict" aria-label="Skill 版本冲突">
                    <h4>最新版本与当前编辑</h4>
                    <p>
                      左侧为服务端最新版本，右侧为你的编辑。请在源码中完成合并，再采用最新版本作为保存基准。
                    </p>
                    <DiffView before={remote.version.entryContent} after={entry} />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setDetail(remote);
                        setRemote(null);
                        setNotice('已采用最新保存基准，你的编辑仍保留，请检查后保存。');
                        void history(remote.skill.id).catch((error: unknown) =>
                          setError(message(error)),
                        );
                      }}
                    >
                      保留编辑并采用最新基准
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        accept(remote);
                        setNotice('已明确放弃本地编辑，载入服务端最新版本。');
                      }}
                    >
                      放弃编辑，载入最新版本
                    </button>
                  </section>
                )}
                <section aria-label="Skill 正文预览">
                  <h4>正文预览{dirty ? '（已保存版本）' : ''}</h4>
                  <SkillMarkdown text={detail.parsed.body} onFile={(path) => void openFile(path)} />
                </section>
                <details>
                  <summary>front matter 元数据</summary>
                  <pre>{JSON.stringify(detail.version.metadata, null, 2)}</pre>
                </details>
                <section aria-label="Skill 关联文件">
                  <h4>关联文件</h4>
                  <p className="muted">
                    文件仅供查看或下载；脚本不执行，附件不会自动全部加入模型上下文。
                  </p>
                  {detail.version.files.map((item) => (
                    <div className="skill-file" key={item.relativePath}>
                      <button type="button" onClick={() => void openFile(item.relativePath)}>
                        {item.relativePath}
                      </button>
                      <small>{item.sizeBytes} 字节</small>
                      <a
                        href={skillApi.fileUrl(
                          detail.skill.id,
                          detail.version.id,
                          item.relativePath,
                        )}
                        download
                      >
                        下载
                      </a>
                    </div>
                  ))}
                </section>
                <section aria-label="Skill 示例">
                  <h4>示例</h4>
                  {detail.parsed.examples.length ? (
                    detail.parsed.examples.map((path) => (
                      <button type="button" key={path} onClick={() => void openFile(path)}>
                        {path}
                      </button>
                    ))
                  ) : (
                    <p className="muted">此版本没有 examples / samples 示例文件。</p>
                  )}
                </section>
                {file && (
                  <section aria-label="附件预览">
                    <h4>{file.path}</h4>
                    {file.text === null ? (
                      <p>此附件暂不支持文本预览，请下载查看。</p>
                    ) : /\.md$/i.test(file.path) ? (
                      <SkillMarkdown
                        text={file.text}
                        onFile={(path) => {
                          const prefix = file.path.includes('/')
                            ? file.path.slice(0, file.path.lastIndexOf('/') + 1)
                            : '';
                          void openFile(prefix + path);
                        }}
                      />
                    ) : (
                      <pre>{file.text}</pre>
                    )}
                  </section>
                )}
                <label>
                  选择对照版本
                  <select
                    aria-label="选择 Skill 对照版本"
                    value={comparison?.version.id ?? ''}
                    disabled={busy}
                    onChange={(event) => {
                      const version = event.target.value;
                      if (!version) setComparison(null);
                      else
                        void action(async () =>
                          setComparison(await skillApi.detail(detail.skill.id, version)),
                        );
                    }}
                  >
                    <option value="">选择版本进行比较</option>
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        版本 {version.versionNo}
                      </option>
                    ))}
                  </select>
                </label>
                {comparison && (
                  <section aria-label="Skill 版本对照">
                    <h4>
                      版本 {comparison.version.versionNo} → 版本 {detail.version.versionNo}
                    </h4>
                    <p>
                      左侧基准 skillVersionId：{comparison.version.id}
                      <br />
                      右侧 skillVersionId：{detail.version.id}
                    </p>
                    <DiffView
                      before={comparison.version.entryContent}
                      after={detail.version.entryContent}
                    />
                    <details>
                      <summary>附件与来源差异</summary>
                      <DiffView
                        before={JSON.stringify(
                          {
                            source: comparison.version.sourceSnapshot,
                            files: comparison.version.files,
                          },
                          null,
                          2,
                        )}
                        after={JSON.stringify(
                          { source: detail.version.sourceSnapshot, files: detail.version.files },
                          null,
                          2,
                        )}
                      />
                    </details>
                  </section>
                )}
                {!historical && (
                  <section aria-label="更新 Skill 来源">
                    <h4>显式更新来源</h4>
                    <p>
                      完整替换当前工作副本，创建新版本。旧正文、附件和来源仍可读取；有未保存编辑时请先保存。
                    </p>
                    {detail.version.sourceSnapshot.type === 'git' ? (
                      <button
                        type="button"
                        disabled={busy || dirty || Boolean(remote)}
                        onClick={() =>
                          void beginImport(() =>
                            skillApi.update(detail.skill.id, detail.version.id),
                          )
                        }
                      >
                        从 Git 更新为新版本
                      </button>
                    ) : (
                      <label>
                        上传完整目录更新
                        <input
                          type="file"
                          multiple
                          ref={(input) => {
                            input?.setAttribute('webkitdirectory', '');
                          }}
                          disabled={busy || dirty || Boolean(remote)}
                          onChange={(event) => {
                            const files = [...(event.target.files ?? [])];
                            event.target.value = '';
                            if (files.length)
                              void beginImport(() =>
                                skillApi.local(files, {
                                  skillId: detail.skill.id,
                                  baseVersionId: detail.version.id,
                                }),
                              );
                          }}
                        />
                      </label>
                    )}
                  </section>
                )}
              </>
            )}
            <section aria-label="Skill 导入记录">
              <h3>最近导入记录</h3>
              {jobs.length === 0 && <p className="muted">暂无导入记录。</p>}
              {jobs.map((job) => (
                <div className="skill-job" key={job.id}>
                  <strong>{statuses[job.status]}</strong>
                  <span>
                    {job.source.ref}
                    {job.source.subdir ? ` / ${job.source.subdir}` : ''}
                  </span>
                  {job.error && <p className="error">{job.error}</p>}
                  {job.status === 'completed' && job.skillId && job.versionId && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void open(job.skillId ?? '', job.versionId ?? '')}
                    >
                      打开导入版本
                    </button>
                  )}
                </div>
              ))}
            </section>
          </main>
        </div>
      </div>
    </section>
  );
}
function message(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试';
}
