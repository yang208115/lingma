/** Older runs stored the outline instructions together with the author's message. */
export function visibleWritingTask(text: string): string {
  return text.replace(/^当前是(?:作品大纲规划|故事大纲与时间线规划)。[^\n]*\r?\n\r?\n/, '');
}
