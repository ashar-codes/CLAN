import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts', 'apps/desktop/test/**/*.test.ts', 'apps/mobile/modules/*/tests/**/*.test.ts'], testTimeout: 20000 } });
