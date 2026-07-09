import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only collect proper vitest suites. Standalone assertion scripts
    // (e.g. test/sensing-gate.test.mjs) are run via `node` post-build,
    // matching the geo-drop convention.
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
