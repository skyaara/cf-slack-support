import type { Hono } from 'hono';
import type {
  ClientFrame,
  ConversationExternalBinding,
  MediaConfig,
  MessageExternalRef,
  SlackSupportRuntime,
  SupportConversation,
  SupportIdentity,
  SupportMessage,
} from '../../protocol';
import type { SlackClient } from '../../slack';

/** Minimal SQL surface used by features (Durable Object SQLite). */
export type FeatureSql = {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[] };
};

export type ConversationRow = {
  id: string;
  title: string | null;
  slack_thread_ts: string | null;
  status: string | null;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
  external_adapter_id?: string | null;
  external_inbox_id?: string | null;
  external_location_id?: string | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  body: string | null;
  attachments_json: string | null;
  author_role: string;
  author_name: string | null;
  created_at: number;
  client_id: string | null;
  slack_ts: string | null;
  reactions_json?: string | null;
  external_adapter_id?: string | null;
  external_message_id?: string | null;
};

export type FeatureHandle = 'handled' | 'pass';

export type InsertConversationInput = {
  id: string;
  title: string | null;
  /** Prefer this over `slackThreadTs`. */
  external?: ConversationExternalBinding | null;
  /**
   * @deprecated Prefer `external`. Still accepted; mirrored into Slack binding.
   */
  slackThreadTs?: string | null;
  createdAt: number;
  status?: SupportConversation['status'];
  closedAt?: number | null;
};

/**
 * Runtime API exposed to feature packages from inside the Durable Object.
 * Features must not reach into private DO fields — use this host only.
 */
export type FeatureHost = {
  env: unknown;
  sql: FeatureSql;
  runtime(): Promise<SlackSupportRuntime>;
  slack(): Promise<SlackClient>;
  metaGet(key: string): string | null;
  metaSet(key: string, value: string): void;
  metaDelete(key: string): void;
  identityFromMeta(): SupportIdentity;
  listConversations(): SupportConversation[];
  getConversation(id: string): SupportConversation | null;
  /** @deprecated Prefer {@link getConversationByBinding}. */
  getConversationByThread(threadTs: string): SupportConversation | null;
  getConversationByBinding(
    binding: Pick<ConversationExternalBinding, 'adapterId' | 'locationId'>,
  ): SupportConversation | null;
  insertConversation(input: InsertConversationInput): SupportConversation;
  bindConversation(conversationId: string, binding: ConversationExternalBinding): void;
  setConversationStatus(
    id: string,
    status: SupportConversation['status'],
    at: number,
  ): SupportConversation | null;
  insertMessage(message: SupportMessage): SupportMessage;
  findByClientId(clientId: string): SupportMessage | null;
  /** @deprecated Prefer {@link findMessageByExternalRef}. */
  findBySlackTs(slackTs: string): SupportMessage | null;
  findMessageByExternalRef(ref: MessageExternalRef): SupportMessage | null;
  messagesSince(lastSeenId: string | undefined, limit?: number): SupportMessage[];
  rowToMessage(row: MessageRow): SupportMessage;
  broadcast(frame: unknown, except?: WebSocket): void;
  send(ws: WebSocket, frame: unknown): void;
  ensureChannel(identity: SupportIdentity): Promise<{ channelId: string; created: boolean }>;
  /**
   * Post via the Slack channel adapter. Prefer this until multi-adapter
   * routing lands on the host (`postToChannel`).
   */
  postToSlack(input: {
    runtime: SlackSupportRuntime;
    channelId: string;
    conversation: SupportConversation;
    message: SupportMessage;
  }): Promise<{ slackTs: string; threadTs: string }>;
  resolveAttachments(
    runtime: SlackSupportRuntime,
    customerKey: string,
    attachmentIds: string[] | undefined,
  ): Promise<SupportMessage['attachments']>;
  newId(prefix: string): string;
  hasFeature(name: string): boolean;
  /** Staff display name cache + users.info. */
  resolveStaffDisplayName(slack: SlackClient, userId: string): Promise<string>;
};

export type HttpFeatureContext<Env extends object = Record<string, unknown>> = {
  basePath: string;
  routes: {
    health: string;
    ws: string;
    uploads: string;
    media: string;
    conversations: string;
    slackEvents: string;
  };
  getRuntime: (env: Env) => SlackSupportRuntime | Promise<SlackSupportRuntime>;
  resolveIdentity: (
    request: Request,
    env: Env,
  ) => Promise<SupportIdentity | Response>;
  mediaConfig: (runtime: SlackSupportRuntime) => MediaConfig | undefined;
};

/**
 * A composable support feature (reactions, lifecycle, uploads, …).
 * Register via `features: [reactionsFeature(), …]` — import plugins from
 * `cf-slack-support/features/*` (same package; subpaths for tree-shaking).
 */
export type SupportFeature<Env extends object = Record<string, unknown>> = {
  readonly name: string;
  /** Run after core schema create; add columns / tables. */
  migrate?(sql: FeatureSql): void;
  /** Enrich conversation after SQL row map. */
  enrichConversation?(
    conversation: SupportConversation,
    row: ConversationRow,
  ): SupportConversation;
  /** Enrich message after SQL row map. */
  enrichMessage?(message: SupportMessage, row: MessageRow): SupportMessage;
  /**
   * Handle a client WS frame. Return `handled` to stop core processing.
   * Core always handles: hello, ping, open_conversation, send.
   */
  onClientFrame?(
    host: FeatureHost,
    ws: WebSocket,
    frame: ClientFrame,
    customerKey: string,
  ): Promise<FeatureHandle>;
  /**
   * Handle a Slack Events API payload (already forwarded to the DO).
   * Return `handled` to skip core message handling.
   */
  onSlackEvent?(host: FeatureHost, event: unknown): Promise<FeatureHandle>;
  /** Register extra HTTP routes on the Worker Hono app. */
  registerHttp?(
    app: Hono<{ Bindings: Env; Variables: { runtime: SlackSupportRuntime } }>,
    ctx: HttpFeatureContext<Env>,
  ): void;
};

export type SlackSupportOptions<Env extends object = Record<string, unknown>> = {
  getRuntime: (env: Env) => SlackSupportRuntime | Promise<SlackSupportRuntime>;
  authenticate: (
    request: Request,
    env: Env,
  ) => Promise<SupportIdentity | Response | null>;
  basePath?: string;
  routes?: Partial<{
    health: string;
    ws: string;
    uploads: string;
    media: string;
    conversations: string;
    slackEvents: string;
  }>;
  /**
   * Feature plugins (subpath modules). Order matters for migrate + handlers
   * (first `handled` wins for frames/events).
   */
  features?: SupportFeature<Env>[];
};
