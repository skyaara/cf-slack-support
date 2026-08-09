import type { ChannelPolicyInput } from './channel-policy';
import type {
  ConversationExternalBinding,
  MessageExternalRef,
} from './external-binding';

/** Authenticated customer identity returned by your `authenticate` hook. */
export type SupportIdentity = {
  /** Stable key used for DO idFromName and Slack channel mapping. */
  customerKey: string;
  displayName?: string;
  /**
   * Arbitrary metadata stored on the DO and available to hooks.
   * Recognized keys:
   * - `username` / `profilePhotoUrl` — Slack customize display
   * - `channelPolicy` — per-customer {@link ChannelPolicyMode} override
   */
  meta?: Record<string, unknown> & {
    channelPolicy?: import('./channel-policy').ChannelPolicyMode | string;
    channel_policy?: import('./channel-policy').ChannelPolicyMode | string;
    username?: string;
    profilePhotoUrl?: string;
    profile_photo_url?: string;
  };
};

export type SupportAttachment = {
  id: string;
  url: string;
  contentType: string;
  filename?: string;
  bytes?: number;
  width?: number;
  height?: number;
};

/** Who authored a support message — humans, agents, or system notices. */
export type SupportAuthorRole = 'customer' | 'staff' | 'agent' | 'system';

/**
 * Aggregated reaction on a support message (Slack → customer, one-way).
 * Only present when `cf-slack-support/features/reactions` is registered.
 */
export type SupportReaction = {
  /** Unicode emoji character(s), e.g. "👍". */
  emoji: string;
  /** Slack short name that produced this emoji (e.g. "thumbsup"). */
  name: string;
  /** Distinct staff reactors counted for this emoji. */
  count: number;
};

export type SupportMessage = {
  id: string;
  conversationId: string;
  body: string | null;
  attachments: SupportAttachment[];
  authorRole: SupportAuthorRole;
  authorName?: string;
  createdAt: number;
  clientId?: string;
  /**
   * Opaque platform message id for the channel adapter that carried this message.
   * Prefer this over {@link slackTs}.
   */
  external?: MessageExternalRef | null;
  /**
   * Slack message `ts` when mirrored via the Slack adapter.
   * @deprecated Prefer `external` (`adapterId: 'slack'`). Still populated for compat.
   */
  slackTs?: string;
  /** Populated by the reactions feature. */
  reactions?: SupportReaction[];
};

/** Lifecycle of a support request (one conversation). Requires lifecycle feature. */
export type SupportConversationStatus = 'open' | 'closed';

export type SupportConversation = {
  id: string;
  title: string | null;
  /**
   * Where this conversation lives on an external channel (Slack thread, agent
   * session, Discord channel, …). Null until the first successful egress bind.
   */
  external?: ConversationExternalBinding | null;
  /**
   * Slack thread root `ts` when bound to Slack.
   * @deprecated Prefer `external`. Still populated for compat / existing clients.
   */
  slackThreadTs: string | null;
  /** Defaults to `open` when lifecycle feature is absent or for legacy rows. */
  status: SupportConversationStatus;
  /** Epoch ms when closed; null while open. */
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ChannelCreatedContext = {
  customerKey: string;
  channelId: string;
  channelName: string;
  identity: SupportIdentity;
};

export type MessageHookContext = {
  customerKey: string;
  message: SupportMessage;
  conversation: SupportConversation;
  /**
   * `to_slack` / `from_slack` kept for existing hooks.
   * Newer code should also read {@link adapterId}.
   */
  direction: 'to_slack' | 'from_slack' | 'to_external' | 'from_external';
  /** Channel adapter that carried this message (`slack`, `agent`, …). */
  adapterId?: string;
};

export type ChannelIndex = {
  getCustomerKey(channelId: string): Promise<string | null>;
  setCustomerKey(channelId: string, customerKey: string): Promise<void>;
};

/** Minimal DO namespace surface - avoids hard dependency on workers-types in consumer TS projects. */
export type CustomerSupportNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
};

export type MediaObject = {
  key: string;
  body: ReadableStream | ArrayBuffer | Uint8Array | Blob | string;
  contentType: string;
  customMetadata?: Record<string, string>;
};

export type StoredMedia = {
  key: string;
  contentType: string;
  bytes?: number;
  etag?: string;
};

/** Pluggable media storage (default: R2). */
export interface MediaStore {
  put(object: MediaObject): Promise<StoredMedia>;
  get(key: string): Promise<{
    body: ReadableStream;
    contentType: string;
    bytes?: number;
    etag?: string;
  } | null>;
  publicUrl(key: string): string;
}

export type SlackCredentials = {
  botToken: string;
  signingSecret: string;
  /** Optional bot user id - used to ignore echo events when set. */
  botUserId?: string;
};

export type MediaConfig = {
  store: MediaStore;
  /** e.g. https://support.example.com */
  publicBaseUrl: string;
  maxImageBytes?: number;
  allowedMimeTypes?: string[];
  /**
   * Allow unauthenticated reads from the media route. Disabled by default.
   * Prefer authenticated reads and native Slack uploads for support content.
   */
  publicRead?: boolean;
};

export type ResolvedMediaConfig = Required<
  Pick<MediaConfig, 'store' | 'publicBaseUrl' | 'maxImageBytes' | 'allowedMimeTypes'>
>;

/**
 * Runtime config resolved per-request from Worker `env`.
 * Keep secrets and bindings here - never hardcode in the DO class.
 */
export type SlackSupportRuntime = {
  slack: SlackCredentials;
  /**
   * Image store + limits. Required when using media/uploads features;
   * optional for text-only bridges.
   */
  media?: MediaConfig;
  channelIndex: ChannelIndex;
  customers: CustomerSupportNamespace;
  staffUserIds: string[];
  /**
   * Optional staff authorization hook. When omitted, only IDs in
   * `staffUserIds` may send messages or reactions to customers.
   */
  authorizeSlackActor?: (input: {
    userId: string;
    channelId: string;
    eventType: string;
  }) => boolean | Promise<boolean>;
  channelIsPrivate: boolean;
  channelName: (identity: SupportIdentity) => string;
  corsOrigins: string[] | '*';
  /** Fallback display name for staff when users.info fails. */
  staffDisplayNameFallback?: string;
  /**
   * How top-level Slack channel messages map to customer chats.
   * Accepts a mode string, preset object, or omit for `bidirectional`.
   *
   * @see CHANNEL_POLICY_PRESETS
   * @see decideInboundStaffMessage
   */
  channelPolicy?: ChannelPolicyInput;
  onChannelCreated?: (ctx: ChannelCreatedContext) => void | Promise<void>;
  onMessage?: (ctx: MessageHookContext) => void | Promise<void>;
};

export type AuthenticateFn<Env extends object = Record<string, unknown>> = (
  request: Request,
  env: Env,
) => Promise<SupportIdentity | Response | null>;

export type DefaultRoutes = {
  health: string;
  ws: string;
  uploads: string;
  media: string;
  conversations: string;
  slackEvents: string;
};

export const DEFAULT_ROUTES: DefaultRoutes = {
  health: '/health',
  ws: '/ws',
  uploads: '/uploads',
  media: '/media',
  conversations: '/conversations',
  slackEvents: '/slack/events',
};

export const DEFAULT_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
