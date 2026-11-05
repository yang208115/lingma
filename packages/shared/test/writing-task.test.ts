import { expect, it } from 'vitest';
import { visibleWritingTask } from '../src/writing-task.js';

it.each(['作品大纲规划', '故事大纲与时间线规划'])(
  'hides legacy %s instructions without removing the author message',
  (mode) => {
    const task = '规划三个事件\n\n保留人物的选择。';
    expect(visibleWritingTask(`当前是${mode}。内部工具指令\n\n${task}`)).toBe(task);
    expect(visibleWritingTask(`当前是${mode}。内部工具指令\r\n\r\n${task}`)).toBe(task);
  },
);

it('preserves ordinary multi-paragraph tasks and incomplete legacy prefixes', () => {
  for (const text of ['请规划故事\n\n保留结局', '当前是故事大纲与时间线规划。没有分隔段'])
    expect(visibleWritingTask(text)).toBe(text);
});
