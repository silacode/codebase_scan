import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
          isolate: true,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          fileParallelism: false,
          isolate: true,
          hookTimeout: 180000,
          testTimeout: 180000,
        },
      },
    ],
  },
});
