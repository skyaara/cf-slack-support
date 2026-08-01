import { defineConfig } from 'vitest/config';

/**
 * Node unit / property tests (fast-check, pure helpers).
 *
 * Workers/DO tests live under packages/integration-tests and use a separate
 * vitest-pool-workers config — workerd cannot use V8 coverage; those use Istanbul.
 */
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
    include: ['packages/cf-slack-support/tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.workers.test.ts',
      'packages/integration-tests/**',
    ],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
    coverage: {
      // Istanbul so unit + workers reports use the same provider and can be compared.
      provider: 'istanbul',
      reportsDirectory: './coverage/unit',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['packages/cf-slack-support/src/**/*.{ts,js}'],
      exclude: [
        '**/*.test.ts',
        '**/tests/**',
        '**/node_modules/**',
        '**/dist/**',
        'packages/integration-tests/**',
        '**/test/stubs/**',
      ],
    },
  },
});
