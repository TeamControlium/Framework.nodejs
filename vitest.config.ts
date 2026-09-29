import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['html', 'text', 'lcov', 'json-summary'],
      thresholds: {
        branches: 88,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
