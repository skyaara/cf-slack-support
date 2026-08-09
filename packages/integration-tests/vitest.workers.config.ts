import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(here, '../..');
const packagesSrc = path.join(monorepoRoot, 'packages');

/**
 * Workers tests run inside workerd via @cloudflare/vitest-pool-workers.
 *
 * Coverage: V8 native coverage is NOT supported in workerd (Cloudflare known
 * issue). Use Istanbul instrumentation instead.
 * @see https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#coverage
 */
export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.workers.test.ts'],
    // SQLite Durable Objects + WAL leave .sqlite-shm files that break
    // per-test isolated storage snapshots in pool-workers 0.8.x.
    fileParallelism: false,
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            SUPPORT_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
            SLACK_BOT_TOKEN: 'xoxb-test',
            SLACK_SIGNING_SECRET: 'slack-signing-secret',
            SUPPORT_PUBLIC_BASE_URL: 'https://support.test',
          },
        },
      },
    },
    coverage: {
      provider: 'istanbul',
      reportsDirectory: path.join(monorepoRoot, 'coverage/workers'),
      reporter: ['text', 'json', 'html', 'lcov', 'text-summary'],
      // Workspace packages resolve outside this package root (and via node_modules links).
      allowExternal: true,
      include: [
        // Integration worker entry
        path.join(here, 'src/**/*.ts'),
        // Single library package (absolute globs)
        path.join(packagesSrc, 'cf-slack-support/src/**/*.ts'),
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.workers.test.ts',
        '**/tests/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/examples/**',
        '**/test/stubs/**',
        '**/integration-tests/vitest.workers.config.ts',
      ],
      all: false,
    },
  },
});
