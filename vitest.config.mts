import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    /**
     * The integration suites share one PostgreSQL database and truncate tables
     * between tests, so running test files in parallel makes them race each
     * other. The whole suite finishes in about a second, so serialising files
     * costs nothing and removes a real source of flakiness.
     */
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
