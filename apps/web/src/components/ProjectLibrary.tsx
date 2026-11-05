import type { Project } from '@lingma/shared';
import { useState } from 'react';
export function ProjectLibrary({
  projects,
  deletedProjects,
  busy,
  onCreate,
  onOpen,
  onRename,
  onDelete,
  onRestore,
}: {
  projects: Project[];
  deletedProjects: Project[];
  busy: boolean;
  onCreate(): void;
  onOpen(id: string): void;
  onRename(project: Project): void;
  onDelete(project: Project): void;
  onRestore(id: string): Promise<void>;
}) {
  const [showTrash, setShowTrash] = useState(false);
  return (
    <main
      aria-label="作品管理"
      className={`welcome ${projects.length || deletedProjects.length ? 'project-management' : ''}`}
    >
      <p className="eyebrow">
        {projects.length || deletedProjects.length ? '你的创作书架' : '把故事留在这里'}
      </p>
      <h1>
        {projects.length || deletedProjects.length ? (
          '作品管理'
        ) : (
          <>
            从一页空白，
            <br />
            到一个完整的世界。
          </>
        )}
      </h1>
      <p className="muted">
        {projects.length || deletedProjects.length
          ? '集中管理作品，删除后的作品可在回收站恢复。'
          : '管理卷章、整理人物与大纲。每次保存都留下一个可找回的版本。'}
      </p>
      <button type="button" className="primary" onClick={onCreate}>
        {projects.length || deletedProjects.length ? '新建作品' : '创建第一部作品'}
      </button>
      <div className="project-list-heading">
        <h2>{showTrash ? '作品回收站' : '我的作品'}</h2>
        <button type="button" aria-pressed={showTrash} onClick={() => setShowTrash(!showTrash)}>
          {showTrash ? '返回我的作品' : `回收站（${deletedProjects.length}）`}
        </button>
      </div>
      <div className="project-cards">
        {(showTrash ? deletedProjects : projects).map((project) => (
          <article className="project-card" key={project.id} aria-label={project.title}>
            {showTrash ? (
              <div className="project-card-content">
                <span className="book-icon">文</span>
                <h3>{project.title}</h3>
                <small>{project.format === 'short' ? '短篇' : '长篇'}</small>
                <small>已移入回收站 · 内容与历史已保留</small>
              </div>
            ) : (
              <button
                type="button"
                className="project-card-open"
                onClick={() => onOpen(project.id)}
              >
                <span className="book-icon">文</span>
                <h3>{project.title}</h3>
                <small>{project.format === 'short' ? '短篇' : '长篇'} · </small>
                <small>更新于 {new Date(project.updatedAt).toLocaleDateString()}</small>
              </button>
            )}
            <div className="project-card-actions">
              {showTrash ? (
                <button type="button" disabled={busy} onClick={() => void onRestore(project.id)}>
                  恢复作品
                </button>
              ) : (
                <>
                  <button type="button" disabled={busy} onClick={() => onRename(project)}>
                    重命名
                  </button>
                  <button
                    type="button"
                    className="danger-text"
                    disabled={busy}
                    onClick={() => onDelete(project)}
                  >
                    删除作品
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      {showTrash && !deletedProjects.length && <p className="muted">回收站为空。</p>}
      <p className="muted fine">
        作品与历史保存在运行服务的机器上。浏览器恢复草稿按标签页保存，不代替服务端备份。
      </p>
    </main>
  );
}
