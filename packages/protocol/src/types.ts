/** Authenticated customer identity returned by your `authenticate` hook. */
export type SupportIdentity = {
  /** Stable key used for DO idFromName and Slack channel mapping. */
  customerKey: string;
  displayName?: string;
  /** Arbitrary metadata stored on the DO and available to hooks. */
  meta?: Record<string, unknown>;
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

export type SupportAuthorRole = 'customer' | 'staff' | 'system';

/**
 * Aggregated reaction on a support message (Slack → customer, one-way).
 * Only present when `@cf-slack-support/reactions` is registered.
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
  slackTs?: string;
  /** Populated by the reactions feature. */
  reactions?: SupportReaction[];
};

/** Lifecycle of a support request (one Slack thread). Requires lifecycle feature. */
export type SupportConversationStatus = 'open' | 'closed';

export type SupportConversation = {
  id: string;
  title: string | null;
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
  direction: 'to_slack' | 'from_slack';
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
  channelIsPrivate: boolean;
  channelName: (identity: SupportIdentity) => string;
  corsOrigins: string[] | '*';
  /** Fallback display name for staff when users.info fails. */
  staffDisplayNameFallback?: string;
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
