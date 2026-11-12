import type { Project } from '@lingma/shared';

export function projectOptionLabel(project: Project, projects: Project[]): string {
  const duplicate = projects.some(
    (other) => other.id !== project.id && other.title === project.title,
  );
  return `${project.title} · ${project.format === 'short' ? '短篇' : '长篇'}${duplicate ? ` · ${project.id.slice(0, 8)}` : ''}`;
}
