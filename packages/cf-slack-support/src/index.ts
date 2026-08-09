/**
 * Worker entry for `cf-slack-support`.
 *
 * Keep this surface **lean for Worker bundle size**:
 * - Core DO + HTTP wiring + common Worker helpers live here
 * - Browser client: `cf-slack-support/client`
 * - Optional plugins: `cf-slack-support/features/reactions`, `.../lifecycle`
 * - Rare/advanced: `cf-slack-support/protocol`, `.../emoji`, `.../slack`, …
 *
 * ```ts
 * import {
 *   defineSlackSupport,
 *   createBearerTokenAuthenticator,
 *   createKvChannelIndex,
 *   createR2MediaStore,
 *   CHANNEL_POLICY_PRESETS,
 * } from 'cf-slack-support';
 * import { reactionsFeature } from 'cf-slack-support/features/reactions';
 * import { lifecycleFeature } from 'cf-slack-support/features/lifecycle';
 *
 * defineSlackSupport({
 *   features: [reactionsFeature(), lifecycleFeature()],
 *   // ...
 * });
 * ```
 */

// ── Protocol: domain types + channel policy (small; needed for wiring) ─
export type {
  AuthenticateFn,
  ChannelCreatedContext,
  ChannelIndex,
  CustomerSupportNamespace,
  DefaultRoutes,
  MediaConfig,
  MediaObject,
  MediaStore,
  MessageHookContext,
  ResolvedMediaConfig,
  SlackCredentials,
  SlackSupportRuntime,
  StoredMedia,
  SupportAttachment,
  SupportAuthorRole,
  SupportConversation,
  SupportConversationStatus,
  SupportIdentity,
  SupportMessage,
  SupportReaction,
  ClientFrame,
  ServerFrame,
  UploadResponse,
  ChannelPolicy,
  ChannelPolicyInput,
  ChannelPolicyMode,
  ChannelPolicyPresetName,
  InboundStaffDropReason,
  InboundStaffMessageDecision,
  InboundStaffMessageRef,
  ChannelAdapterId,
  ConversationExternalBinding,
  MessageExternalRef,
} from './protocol';

export {
  DEFAULT_ALLOWED_MIME_TYPES,
  CLIENT_FRAME_LIMITS,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_ROUTES,
  parseClientFrame,
  parseServerFrame,
  isClientFrameType,
  isServerFrameType,
  CHANNEL_POLICY_PRESETS,
  DEFAULT_CHANNEL_POLICY,
  decideInboundStaffMessage,
  describeChannelPolicy,
  resolveChannelPolicy,
  resolveConversationExternal,
  resolveMessageExternal,
  slackBindingFromLegacy,
  slackMessageRef,
  slackThreadTsFromExternal,
  slackTsFromExternal,
} from './protocol';

// ── Worker helpers (opt-in via import; tree-shake unused) ───────────────
export { createKvChannelIndex, createMemoryChannelIndex } from './channel-index';

export {
  createR2MediaStore,
  mediaKeyBelongsToCustomer,
  mediaKeyFromPath,
  mediaNamespaceForCustomer,
  createMemoryMediaStore,
} from './media';
export type { R2MediaStoreOptions } from './media';

export { verifySlackSignature, createSlackClient, slugifyChannelName } from './slack';
export type {
  SlackClient,
  SlackApiError,
  SlackChannel,
  SlackPostMessageResult,
  SlackUploadExternalResult,
} from './slack';

export {
  createBearerTokenAuthenticator,
  mintSupportBearerToken,
} from './auth';
export type { BearerTokenAuthOptions } from './auth';

// ── Core: DO + define + feature plugin types ───────────────────────────
export {
  defineSlackSupport,
  createCustomerSupportDOClass,
  applyCoreSchema,
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
} from './core';
export type {
  SlackSupportApp,
  SlackSupportHonoEnv,
  SlackSupportOptions,
  SupportFeature,
  FeatureHost,
  FeatureHandle,
  FeatureSql,
  HttpFeatureContext,
  ConversationRow,
  MessageRow,
  InsertConversationInput,
  CustomerSupportDOClass,
  CustomerSupportDOConstructor,
} from './core';

// Intentionally NOT re-exported from main (import via subpaths):
// - createSupportClient → 'cf-slack-support/client'
// - reactionsFeature    → 'cf-slack-support/features/reactions'
// - lifecycleFeature    → 'cf-slack-support/features/lifecycle'
// - channel adapters    → 'cf-slack-support/channel'
// - emoji map           → 'cf-slack-support/emoji'
