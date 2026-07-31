import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Unit tests never execute Durable Object classes; stub CF runtime modules.
      'cloudflare:workers': new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    globals: false,
    include: ['packages/*/tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.workers.test.ts',
      'packages/integration-tests/**',
    ],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
  },
});

