import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['e2e/**/*.test.ts'], testTimeout: 400_000, hookTimeout: 30_000, fileParallelism: false, globalSetup: ['e2e/global-teardown.ts'] } });
