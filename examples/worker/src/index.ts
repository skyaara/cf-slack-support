import {
  CHANNEL_POLICY_PRESETS,
  createBearerTokenAuthenticator,
  createKvChannelIndex,
  createR2MediaStore,
  defineSlackSupport,
  resolveChannelPolicy,
  slugifyChannelName,
  type ChannelPolicyInput,
  type CustomerSupportDOConstructor,
} from 'cf-slack-support';
import { reactionsFeature } from 'cf-slack-support/features/reactions';
import { lifecycleFeature } from 'cf-slack-support/features/lifecycle';

export type Env = {
  SUPPORT_BUCKET: R2Bucket;
  SUPPORT_INDEX: KVNamespace;
  CUSTOMER_SUPPORT: DurableObjectNamespace;
  SUPPORT_PUBLIC_BASE_URL: string;
  SUPPORT_CHANNEL_PREFIX?: string;
  SUPPORT_STAFF_USER_IDS?: string;
  SUPPORT_CORS_ORIGINS?: string;
  SUPPORT_AUTH_SECRET: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_USER_ID?: string;
  /**
   * Channel routing policy:
   * - `threads_only` — staff must reply in threads
   * - `bidirectional` — top-level staff posts start a customer conversation (default)
   * - `staff_main_customer_threads` — channel root staff-only; threads = customer chats
   */
  SUPPORT_CHANNEL_POLICY?: string;
};

function parseList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCors(value: string | undefined): string[] | '*' {
  if (!value) return [];
  if (value.trim() === '*') return '*';
  return parseList(value);
}

/**
 * Full-featured example matching Flickks wiring:
 * core + reactions + lifecycle + R2 media.
 */
function channelPolicyFromEnv(env: Env): ChannelPolicyInput {
  const raw = env.SUPPORT_CHANNEL_POLICY?.trim();
  if (!raw) return CHANNEL_POLICY_PRESETS.bidirectional;
  return resolveChannelPolicy(raw as ChannelPolicyInput);
}

const support = defineSlackSupport<Env>({
  features: [reactionsFeature(), lifecycleFeature()],
  authenticate: createBearerTokenAuthenticator({
    getSecret: (env) => (env as Env).SUPPORT_AUTH_SECRET,
  }),
  getRuntime: (env) => {
    const publicBaseUrl = env.SUPPORT_PUBLIC_BASE_URL.replace(/\/+$/, '');
    const prefix = env.SUPPORT_CHANNEL_PREFIX?.trim() || 'support';
    return {
      slack: {
        botToken: env.SLACK_BOT_TOKEN,
        signingSecret: env.SLACK_SIGNING_SECRET,
        botUserId: env.SLACK_BOT_USER_ID,
      },
      media: {
        store: createR2MediaStore({
          bucket: env.SUPPORT_BUCKET,
          publicBaseUrl,
          urlPathPrefix: '/media',
        }),
        publicBaseUrl,
      },
      channelIndex: createKvChannelIndex(env.SUPPORT_INDEX),
      customers: env.CUSTOMER_SUPPORT,
      staffUserIds: parseList(env.SUPPORT_STAFF_USER_IDS),
      channelIsPrivate: true,
      channelName: (identity) =>
        slugifyChannelName(`${prefix}-${identity.customerKey}`),
      corsOrigins: parseCors(env.SUPPORT_CORS_ORIGINS),
      staffDisplayNameFallback: 'Support',
      channelPolicy: channelPolicyFromEnv(env),
    };
  },
});

export const CustomerSupportDO: CustomerSupportDOConstructor<Env> =
  support.CustomerSupportDO;
export default {
  fetch: support.fetch,
};
