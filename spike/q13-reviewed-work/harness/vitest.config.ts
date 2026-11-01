import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Block time in the simulator follows the wall clock, so window tests sleep.
    testTimeout: 60_000,
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
  },
});
