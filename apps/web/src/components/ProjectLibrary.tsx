import type { Project } from '@lingma/shared';
import { useState } from 'react';
import { ShioriIllustration } from './Shiori.js';
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
      className={`welcome library-page ${projects.length || deletedProjects.length ? 'project-management' : ''}`}
    >
      <header className="library-intro">
        <div>
          <p className="eyebrow">欢迎回来，作者。</p>
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
              ? '书签还夹在上次的那一页。选一部作品，继续你的故事。'
              : '我是栞，替你整理故事的见习管理员。从一个人物、一段灵感开始，也很好。'}
          </p>
          <button type="button" className="primary" onClick={onCreate}>
            {projects.length || deletedProjects.length ? '新建作品' : '创建第一部作品'}
          </button>
        </div>
        <figure className="library-companion">
          <ShioriIllustration />
          <figcaption>
            这一页，交给你决定。
            <span>栞 · 页间见习管理员</span>
          </figcaption>
        </figure>
      </header>
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
