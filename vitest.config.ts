import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // DB tests share one database, so run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
