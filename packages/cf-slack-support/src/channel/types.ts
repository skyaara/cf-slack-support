import type {
  ChannelAdapterId,
  ConversationExternalBinding,
  MessageExternalRef,
  SupportAttachment,
  SupportAuthorRole,
  SupportConversation,
  SupportIdentity,
  SupportMessage,
} from '../protocol';

export type {
  ChannelAdapterId,
  ConversationExternalBinding,
  MessageExternalRef,
} from '../protocol';

/**
 * How an external platform maps **inboxes** ↔ **conversations**.
 *
 * The Durable Object always owns {@link SupportConversation} as the durable unit.
 * Adapters only say how that unit is *placed* on the platform.
 *
 * | Topology | Example | Inbox | Conversation location |
 * |----------|---------|-------|------------------------|
 * | `inbox_with_threads` | Slack channel + threads | 1 channel / customer | thread root ts |
 * | `one_location_per_conversation` | Discord thread, Linear issue, agent session | optional workspace | channel / issue / session id |
 * | `single_stream` | Telegram DM, many WhatsApp bots | 1 DM / customer | same as inbox (logical convos only) |
 */
export type ChannelTopology =
  | 'inbox_with_threads'
  | 'one_location_per_conversation'
  | 'single_stream';

/**
 * Optional platform features. Core never calls a method unless the capability
 * is advertised — adapters without threads/reactions simply omit them.
 */
export type ChannelCapabilities = {
  /**
   * Platform nests reply-threads under a shared inbox (Slack).
   * When false, {@link SupportChannelAdapter.ensureConversationLocation}
   * must create/resolve a standalone location (or reuse the inbox).
   */
  nestedThreads: boolean;
  reactions: boolean;
  /** Token / partial message streaming (agents, some chat APIs). */
  streaming: boolean;
  editMessage: boolean;
  deleteMessage: boolean;
  /** Staff can open a new conversation from the platform side. */
  staffCanOpenConversation: boolean;
};

export type ParticipantRole = SupportAuthorRole;

export type OutboundPostInput = {
  identity: SupportIdentity;
  conversation: SupportConversation;
  message: SupportMessage;
  /** Prior binding if the conversation was already mirrored. */
  binding: ConversationExternalBinding | null;
  /**
   * Inbox resolved by {@link SupportChannelAdapter.ensureInbox}
   * (required for `inbox_with_threads` / `single_stream`).
   */
  inboxId?: string;
};

export type OutboundPostResult = {
  binding: ConversationExternalBinding;
  messageRef: MessageExternalRef;
  /** True when this post created the conversation's platform location. */
  createdLocation: boolean;
};

export type OutboundStreamInput = OutboundPostInput & {
  /** Async iterable of text deltas; adapter may post-then-edit or use native stream APIs. */
  deltas: AsyncIterable<string>;
};

export type InboundMessageEvent = {
  adapterId: ChannelAdapterId;
  /** Platform user / bot that authored the message. */
  externalUserId: string;
  displayName?: string;
  roleHint: ParticipantRole;
  body: string | null;
  attachments?: SupportAttachment[];
  /** Message id on the platform. */
  messageId: string;
  /**
   * Conversation location on the platform (thread root, channel id, …).
   * For top-level Slack posts under bidirectional policy, equals `messageId`.
   */
  locationId: string;
  /** Shared inbox when applicable (Slack channel). */
  inboxId?: string;
  /**
   * When topology has nested threads: true if this message *is* the thread root
   * (or should open a new conversation). Adapters without nesting always pass true
   * for the first message that should open a conversation, false for continuations
   * they can already map via `locationId`.
   */
  opensConversation: boolean;
  /** Raw platform payload for features / debugging. */
  raw?: unknown;
};

export type InboundReactionEvent = {
  adapterId: ChannelAdapterId;
  messageId: string;
  locationId: string;
  inboxId?: string;
  emoji: string;
  name: string;
  externalUserId: string;
  action: 'add' | 'remove';
  raw?: unknown;
};

/**
 * Staff-routing policy for platforms with a shared inbox + optional nesting.
 * Slack's existing channelPolicy modes map 1:1 here.
 * Adapters with `nestedThreads: false` typically ignore this and deliver every
 * inbound message in a bound location to that conversation.
 */
export type InboxRoutingMode =
  | 'threads_only'
  | 'bidirectional'
  | 'staff_main_customer_threads';

export type EnsureInboxResult = {
  inboxId: string;
  created: boolean;
};

/**
 * Host callbacks the adapter may use while handling webhooks / posts.
 * Mirrors the subset of FeatureHost that channel I/O needs — not SQL.
 */
export type ChannelAdapterHost = {
  identity: SupportIdentity;
  getConversation(id: string): SupportConversation | null;
  getConversationByBinding(
    binding: Pick<ConversationExternalBinding, 'adapterId' | 'locationId'>,
  ): SupportConversation | null;
  insertConversation(input: {
    id: string;
    title: string | null;
    external?: ConversationExternalBinding | null;
    /** @deprecated Prefer `external`. */
    slackThreadTs?: string | null;
    createdAt: number;
    status?: SupportConversation['status'];
    closedAt?: number | null;
  }): SupportConversation;
  insertMessage(message: SupportMessage): SupportMessage;
  findMessageByExternalRef(ref: MessageExternalRef): SupportMessage | null;
  bindConversation(conversationId: string, binding: ConversationExternalBinding): void;
  broadcast(frame: unknown, except?: WebSocket): void;
  newId(prefix: string): string;
};

/**
 * Pluggable external surface: Slack staff inbox, Discord, agent runtime, etc.
 *
 * **Threading rule:** core never assumes threads exist. It:
 * 1. Calls {@link ensureInbox} when the topology needs a shared container.
 * 2. Calls {@link post} with the current binding (maybe null).
 * 3. Persists {@link OutboundPostResult.binding} on the conversation.
 *
 * Adapters without nested threads either create a new location per conversation
 * or reuse the inbox and keep conversations logical (see {@link ChannelTopology}).
 */
export type SupportChannelAdapter = {
  readonly id: ChannelAdapterId;
  readonly topology: ChannelTopology;
  readonly capabilities: ChannelCapabilities;

  /**
   * Resolve or create the shared inbox for this customer (Slack channel, DM peer, …).
   * No-op / unused when topology is `one_location_per_conversation` and each
   * conversation is created only via {@link ensureConversationLocation} / {@link post}.
   */
  ensureInbox?(identity: SupportIdentity): Promise<EnsureInboxResult>;

  /**
   * Optional explicit location provisioning (e.g. open a Discord thread with a title)
   * before the first customer message. Slack usually skips this and lets {@link post}
   * create the thread root.
   */
  ensureConversationLocation?(input: {
    identity: SupportIdentity;
    conversation: SupportConversation;
    inboxId?: string;
  }): Promise<ConversationExternalBinding>;

  /** Customer / agent / system → platform. */
  post(input: OutboundPostInput): Promise<OutboundPostResult>;

  /** Optional streaming egress (agents). Only called when `capabilities.streaming`. */
  postStream?(input: OutboundStreamInput): Promise<OutboundPostResult>;

  /**
   * Platform → core. Adapter verifies signatures, normalizes events, then
   * invokes host helpers. Return whether the event was consumed.
   */
  handleWebhook?(
    request: Request,
    host: ChannelAdapterHost,
  ): Promise<Response | { handled: true } | { handled: false }>;

  /** Map a normalized inbound message into DO mutations (optional if handleWebhook does it). */
  applyInbound?(
    event: InboundMessageEvent,
    host: ChannelAdapterHost,
  ): Promise<'handled' | 'ignored'>;

  applyReaction?(
    event: InboundReactionEvent,
    host: ChannelAdapterHost,
  ): Promise<'handled' | 'ignored'>;

  /**
   * Notify platform that a conversation closed/reopened (lifecycle feature).
   * Slack posts a system line in-thread; flat adapters may no-op.
   */
  onConversationStatus?(input: {
    conversation: SupportConversation;
    binding: ConversationExternalBinding | null;
    status: SupportConversation['status'];
  }): Promise<void>;

  /**
   * Inbox routing for nested-thread topologies. Ignored when
   * `capabilities.nestedThreads === false`.
   */
  inboxRouting?: InboxRoutingMode;
};

/** Convenience: declare capabilities with safe defaults. */
export function defineCapabilities(
  partial: Partial<ChannelCapabilities> & Pick<ChannelCapabilities, 'nestedThreads'>,
): ChannelCapabilities {
  return {
    reactions: false,
    streaming: false,
    editMessage: false,
    deleteMessage: false,
    staffCanOpenConversation: false,
    ...partial,
  };
}

/**
 * Pick how a conversation binds when the adapter has no nested threads.
 *
 * - `one_location_per_conversation` → `locationId` is unique per conversation
 * - `single_stream` → `locationId === inboxId` (conversations are DO-only partitions)
 */
export function bindingForTopology(input: {
  adapterId: ChannelAdapterId;
  topology: ChannelTopology;
  inboxId?: string;
  /** Platform-native conversation location when not single-stream. */
  locationId?: string;
}): ConversationExternalBinding {
  if (input.topology === 'single_stream') {
    const inboxId = input.inboxId;
    if (!inboxId) {
      throw new Error('single_stream topology requires inboxId');
    }
    return { adapterId: input.adapterId, inboxId, locationId: inboxId };
  }
  if (input.topology === 'inbox_with_threads') {
    const locationId = input.locationId;
    if (!locationId) {
      throw new Error('inbox_with_threads requires locationId (thread root)');
    }
    return {
      adapterId: input.adapterId,
      inboxId: input.inboxId,
      locationId,
    };
  }
  // one_location_per_conversation
  const locationId = input.locationId;
  if (!locationId) {
    throw new Error('one_location_per_conversation requires locationId');
  }
  return {
    adapterId: input.adapterId,
    inboxId: input.inboxId,
    locationId,
  };
}
