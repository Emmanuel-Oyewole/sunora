import { defineConfig } from 'vitest/config';

// Tests against a real Postgres (the separate sunora_test database), run with `npm run test:db`.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.db-spec.ts'],
    // One shared database, so files must not run at the same time.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
