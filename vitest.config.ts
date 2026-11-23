import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __TEST__: 'true' },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'jsdom',
    globals: true,
  },
});
