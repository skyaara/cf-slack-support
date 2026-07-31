import {
  createBearerTokenAuthenticator,
  createKvChannelIndex,
  createR2MediaStore,
  defineSlackSupport,
  slugifyChannelName,
} from 'cf-slack-support';
import { reactionsFeature } from '@cf-slack-support/reactions';
import { lifecycleFeature } from '@cf-slack-support/lifecycle';

export type Env = {
  SUPPORT_BUCKET: R2Bucket;
  SUPPORT_INDEX: KVNamespace;
  CUSTOMER_SUPPORT: DurableObjectNamespace;
  SUPPORT_PUBLIC_BASE_URL: string;
  SUPPORT_AUTH_SECRET: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
};

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
    staffUserIds: [],
    channelIsPrivate: true,
    channelName: (id) => slugifyChannelName(`support-${id.customerKey}`),
    corsOrigins: '*',
  }),
});

export const CustomerSupportDO = support.CustomerSupportDO;
export default { fetch: support.fetch };
