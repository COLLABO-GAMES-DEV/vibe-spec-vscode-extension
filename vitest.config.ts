import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/core/test/**/*.test.ts', 'packages/cli/test/**/*.test.ts'],
    // CLI scenarios start several native Node/Git processes; allow Windows and
    // shared development machines enough time without changing their assertions.
    testTimeout: 30_000,
  },
});
