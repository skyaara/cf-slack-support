export type {
  ConversationRow,
  FeatureHandle,
  FeatureHost,
  FeatureSql,
  HttpFeatureContext,
  MessageRow,
  SlackSupportOptions,
  SupportFeature,
} from './feature/types';

export { createCustomerSupportDOClass } from './do/customer-support-do';
export type {
  CustomerSupportDOClass,
  CustomerSupportDOConstructor,
} from './do/customer-support-do';

export {
  buildBlocks,
  clientSafeError,
  extensionForMime,
  extensionForMimeOrBin,
  isMissingChannelError,
  jsonAttachments,
  jsonReactions,
  newId,
  parseAttachments,
  parseReactions,
  titleFromFirstMessage,
} from './do/utils';

export { applyCoreSchema } from './do/schema';

export { defineSlackSupport } from './http/define-slack-support';
export type { SlackSupportApp, SlackSupportHonoEnv } from './http/define-slack-support';
