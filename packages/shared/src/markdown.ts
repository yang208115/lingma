export function normalizeOutlineMarkdown(text: string): string {
  // Keep literal escapes inside fenced and inline code; only repair outline prose.
  return text.replace(
    /(`{3,}|~{3,})[\s\S]*?\1|(`+)[^\r\n]*?\2|\\r\\n|\\n/g,
    (match: string, fence: string | undefined, inline: string | undefined) =>
      fence || inline ? match : '\n',
  );
}
