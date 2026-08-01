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
} from './types';

export {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_ROUTES,
} from './types';

export type { ClientFrame, ServerFrame, UploadResponse } from './frames';
export {
  isClientFrameType,
  isServerFrameType,
  parseClientFrame,
  parseServerFrame,
} from './frames';

export type {
  ChannelPolicy,
  ChannelPolicyInput,
  ChannelPolicyMode,
  ChannelPolicyPresetName,
  InboundStaffDropReason,
  InboundStaffMessageDecision,
  InboundStaffMessageRef,
} from './channel-policy';

export {
  CHANNEL_POLICY_PRESETS,
  DEFAULT_CHANNEL_POLICY,
  decideInboundStaffMessage,
  describeChannelPolicy,
  resolveChannelPolicy,
} from './channel-policy';
