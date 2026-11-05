import { expect, it } from 'vitest';
import { splitSkillDirectory } from '../src/skill-import.js';

it('finds Skills at multiple depths and keeps each attachment within its own directory', () => {
  const result = splitSkillDirectory([
    'skills/README.md',
    'skills/writing/SKILL.md',
    'skills/writing/references/style.md',
    'skills/categories/review/SKILL.md',
    'skills/categories/review/examples/demo.md',
    'skills/empty/notes.md',
  ]);
  expect(result.skills).toEqual([
    {
      root: 'skills/writing/',
      indices: [1, 2],
      paths: ['writing/SKILL.md', 'writing/references/style.md'],
    },
    {
      root: 'skills/categories/review/',
      indices: [3, 4],
      paths: ['review/SKILL.md', 'review/examples/demo.md'],
    },
  ]);
  expect(result.ignored).toEqual(['skills/README.md', 'skills/empty/notes.md']);
});

it('keeps nested example Skills as attachments when the selected root is already a Skill', () => {
  const result = splitSkillDirectory([
    'writing/examples/template/SKILL.md',
    'writing/SKILL.md',
    'writing/references/a.md',
  ]);
  expect(result.skills).toHaveLength(1);
  expect(result.skills[0]?.indices).toEqual([0, 1, 2]);
  expect(result.skills[0]?.paths).toContain('writing/examples/template/SKILL.md');
  expect(splitSkillDirectory(['SKILL.md', 'style.md']).skills[0]?.paths).toEqual([
    'SKILL.md',
    'style.md',
  ]);
});

it('rejects a collection with no entry or unsafe paths before uploading anything', () => {
  expect(() => splitSkillDirectory(['skills/readme.md'])).toThrow('没有找到 SKILL.md');
  expect(() => splitSkillDirectory(['skills/SKILL.md', '../escape.md'])).toThrow('无效的相对路径');
});
