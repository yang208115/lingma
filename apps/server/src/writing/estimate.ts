/**
 * Conservative input-size estimate in UTF-16 code units. CJK text is roughly one to two tokens per
 * character, so counting characters tracks real usage far better than UTF-8 bytes (3 per CJK
 * character) while still exceeding it for typical prose.
 */
export const estimateTokens = (value: unknown): number =>
  (typeof value === 'string' ? value : JSON.stringify(value)).length;
