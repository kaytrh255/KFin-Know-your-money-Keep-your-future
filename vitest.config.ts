import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
  },
});
