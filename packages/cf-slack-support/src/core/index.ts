export type {
  ConversationRow,
  FeatureHandle,
  FeatureHost,
  FeatureSql,
  HttpFeatureContext,
  InsertConversationInput,
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

/** Re-export channel policy types/helpers so Also exported from the main package entry. */
export type {
  ChannelPolicy,
  ChannelPolicyInput,
  ChannelPolicyMode,
  InboundStaffMessageDecision,
} from '../protocol';
export {
  CHANNEL_POLICY_PRESETS,
  DEFAULT_CHANNEL_POLICY,
  decideInboundStaffMessage,
  describeChannelPolicy,
  resolveChannelPolicy,
} from '../protocol';
