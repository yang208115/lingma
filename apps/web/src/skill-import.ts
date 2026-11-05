import { relativePathSchema } from '@lingma/shared';

export function splitSkillDirectory(paths: readonly string[]) {
  const normalized = paths.map((path) => {
    const value = path.normalize('NFC');
    if (!relativePathSchema.safeParse(value).success) throw new Error('所选目录包含无效的相对路径');
    return value;
  });
  const roots: string[] = [];
  for (const path of normalized
    .filter((path) => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
    .map((path) => path.slice(0, -'SKILL.md'.length))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    // An entry inside an existing Skill belongs to that Skill's attachments.
    if (!roots.some((root) => path.startsWith(root))) roots.push(path);
  }
  if (!roots.length) throw new Error('所选目录及其子目录中没有找到 SKILL.md');
  const skills = roots.map((root) => ({ root, indices: [] as number[], paths: [] as string[] }));
  const ignored: string[] = [];
  for (const [index, path] of normalized.entries()) {
    const group = skills.find((skill) => path.startsWith(skill.root));
    if (!group) {
      ignored.push(path);
      continue;
    }
    group.indices.push(index);
    const directory = group.root.split('/').filter(Boolean).at(-1);
    group.paths.push(`${directory ? `${directory}/` : ''}${path.slice(group.root.length)}`);
  }
  return { skills, ignored };
}
