import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { ANAFOR_DISABLE_BACKGROUND: '1' },
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    setupFiles: ['test/setup-env.ts'],
  },
});
