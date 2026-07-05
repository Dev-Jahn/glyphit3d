import { defineConfig } from 'vitest/config';

// Use vitest's default `include` so co-located suites (e.g. web/src/*.test.ts) are
// never silently dropped, and only exclude what must not be collected: the Playwright
// E2E script (test-e2e/demo.spec.ts) is a standalone `npm run e2e` runner, NOT a
// vitest suite (M2-SPEC §4), and the build/vendor trees have no node unit tests.
export default defineConfig({
  test: { exclude: ['test-e2e/**', 'node_modules/**', 'dist/**', 'web/dist/**'] },
});
