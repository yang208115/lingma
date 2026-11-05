import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/server/test/**/*.test.ts',
      'apps/web/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
