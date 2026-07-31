import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.workers.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            SUPPORT_AUTH_SECRET: 'test-secret',
            SLACK_BOT_TOKEN: 'xoxb-test',
            SLACK_SIGNING_SECRET: 'slack-signing-secret',
            SUPPORT_PUBLIC_BASE_URL: 'https://support.test',
          },
        },
      },
    },
  },
});
