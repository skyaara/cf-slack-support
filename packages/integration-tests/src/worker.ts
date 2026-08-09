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
  SUPPORT_AUTH_SECRET: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  /**
   * `threads_only` | `bidirectional` | `staff_main_customer_threads`
   * @default bidirectional
   */
  SUPPORT_CHANNEL_POLICY?: string;
};

function policyFromEnv(env: Env): ChannelPolicyInput {
  const raw = env.SUPPORT_CHANNEL_POLICY?.trim();
  if (!raw) return CHANNEL_POLICY_PRESETS.bidirectional;
  return resolveChannelPolicy(raw as ChannelPolicyInput);
}

const support = defineSlackSupport<Env>({
  features: [reactionsFeature(), lifecycleFeature()],
  authenticate: createBearerTokenAuthenticator({
    getSecret: (env) => (env as Env).SUPPORT_AUTH_SECRET,
  }),
  getRuntime: (env) => ({
    slack: {
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
    },
    media: {
      store: createR2MediaStore({
        bucket: env.SUPPORT_BUCKET,
        publicBaseUrl: env.SUPPORT_PUBLIC_BASE_URL,
      }),
      publicBaseUrl: env.SUPPORT_PUBLIC_BASE_URL,
    },
    channelIndex: createKvChannelIndex(env.SUPPORT_INDEX),
    customers: env.CUSTOMER_SUPPORT,
    staffUserIds: ['U_STAFF'],
    channelIsPrivate: true,
    channelName: (id) => slugifyChannelName(`support-${id.customerKey}`),
    corsOrigins: ['https://app.test'],
    channelPolicy: policyFromEnv(env),
  }),
});

export const CustomerSupportDO: CustomerSupportDOConstructor<Env> = support.CustomerSupportDO;
export default { fetch: support.fetch };
