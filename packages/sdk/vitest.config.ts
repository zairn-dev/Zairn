import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Distribution smoke scripts run separately after the SDK build.
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
