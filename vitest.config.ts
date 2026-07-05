import { defineConfig } from 'vitest/config';

// Scope vitest to the node unit suites under test/. The Playwright E2E script
// (test-e2e/demo.spec.ts) is a standalone `npm run e2e` runner, NOT a vitest suite
// (M2-SPEC §4) — vitest's default `**/*.spec.ts` glob would otherwise try to collect
// it and fail ("no test suite"). All existing suites live under test/.
export default defineConfig({
  test: { include: ['test/**/*.{test,spec}.ts'] },
});
