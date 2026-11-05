import { type Json, jsonSchema } from '@lingma/shared';

export function json(value: unknown): Json {
  return jsonSchema.parse(value);
}
export function canonical(value: unknown): string {
  const sort = (item: Json): Json => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => [key, sort(value)]),
      );
    return item;
  };
  return JSON.stringify(sort(json(value)));
}
