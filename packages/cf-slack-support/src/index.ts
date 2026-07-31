/**
 * Facade package: re-exports core + common helpers.
 *
 * Optional features are peer dependencies — install and pass them explicitly:
 *
 * ```ts
 * import { defineSlackSupport } from 'cf-slack-support';
 * import { reactionsFeature } from '@cf-slack-support/reactions';
 * import { lifecycleFeature } from '@cf-slack-support/lifecycle';
 *
 * defineSlackSupport({
 *   features: [reactionsFeature(), lifecycleFeature()],
 *   // ...
 * });
 * ```
 */

export type {
  AuthenticateFn,
  ChannelCreatedContext,
  ChannelIndex,
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
} from '@cf-slack-support/protocol';

export {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_ROUTES,
  parseClientFrame,
  parseServerFrame,
} from '@cf-slack-support/protocol';

export { createKvChannelIndex, createMemoryChannelIndex } from '@cf-slack-support/channel-index';
export { createR2MediaStore, mediaKeyFromPath, createMemoryMediaStore } from '@cf-slack-support/media';
export type { R2MediaStoreOptions } from '@cf-slack-support/media';

export { verifySlackSignature, createSlackClient, slugifyChannelName } from '@cf-slack-support/slack';
export type { SlackClient } from '@cf-slack-support/slack';

export {
  createBearerTokenAuthenticator,
  mintSupportBearerToken,
} from '@cf-slack-support/auth';
export type { BearerTokenAuthOptions } from '@cf-slack-support/auth';

export {
  defineSlackSupport,
  createCustomerSupportDOClass,
} from '@cf-slack-support/core';
export type {
  SlackSupportApp,
  SlackSupportHonoEnv,
  SlackSupportOptions,
  SupportFeature,
  FeatureHost,
  CustomerSupportDOClass,
  CustomerSupportDOConstructor,
} from '@cf-slack-support/core';

export { createSupportClient } from '@cf-slack-support/client';
export type {
  CreateSupportClientOptions,
  SupportClient,
  SupportClientEvents,
  SupportClientStatus,
} from '@cf-slack-support/client';
