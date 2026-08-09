import type { ChannelPolicyMode, SupportIdentity } from '../protocol';
import {
  bindingForTopology,
  defineCapabilities,
  type ConversationExternalBinding,
  type EnsureInboxResult,
  type InboxRoutingMode,
  type OutboundPostInput,
  type OutboundPostResult,
  type SupportChannelAdapter,
} from './types';

/**
 * Slack staff adapter behind {@link SupportChannelAdapter}.
 *
 * Topology: `inbox_with_threads`
 * - inbox = Slack channel (one per customer)
 * - location = thread root `ts` (one per SupportConversation)
 */
export type SlackChannelAdapterOptions = {
  /** Same modes as today’s channelPolicy. */
  inboxRouting?: InboxRoutingMode | ChannelPolicyMode;
  ensureInbox: (identity: SupportIdentity) => Promise<EnsureInboxResult>;
  /**
   * Post (or upload) into channel / thread. When `threadTs` is null, post at
   * channel root; the returned message ts becomes the thread root.
   */
  postMessage: (input: {
    inboxId: string;
    threadTs: string | null;
    conversation: OutboundPostInput['conversation'];
    message: OutboundPostInput['message'];
    identity: SupportIdentity;
  }) => Promise<{ messageTs: string; threadRootTs: string }>;
};

export function createSlackChannelAdapter(
  options: SlackChannelAdapterOptions,
): SupportChannelAdapter {
  return {
    id: 'slack',
    topology: 'inbox_with_threads',
    capabilities: defineCapabilities({
      nestedThreads: true,
      reactions: true,
      editMessage: true,
      staffCanOpenConversation: true,
    }),
    inboxRouting: options.inboxRouting ?? 'bidirectional',

    ensureInbox: (identity) => options.ensureInbox(identity),

    async post(input: OutboundPostInput): Promise<OutboundPostResult> {
      const inboxId = input.binding?.inboxId ?? input.inboxId;
      if (!inboxId) {
        throw new Error('Slack post requires inboxId (channel)');
      }
      const existingThread = input.binding?.locationId ?? null;
      const posted = await options.postMessage({
        inboxId,
        threadTs: existingThread,
        conversation: input.conversation,
        message: input.message,
        identity: input.identity,
      });
      const binding = bindingForTopology({
        adapterId: 'slack',
        topology: 'inbox_with_threads',
        inboxId,
        locationId: posted.threadRootTs,
      });
      return {
        binding,
        messageRef: { adapterId: 'slack', messageId: posted.messageTs },
        createdLocation: !existingThread,
      };
    },
  };
}

/** Non-threaded agent surface (AG-UI / AI SDK session per conversation). */
export function createAgentChannelAdapterSketch(handlers: {
  post: SupportChannelAdapter['post'];
  postStream?: SupportChannelAdapter['postStream'];
}): SupportChannelAdapter {
  return {
    id: 'agent',
    topology: 'one_location_per_conversation',
    capabilities: defineCapabilities({
      nestedThreads: false,
      streaming: true,
      staffCanOpenConversation: false,
    }),
    post: handlers.post,
    postStream: handlers.postStream,
  };
}

/** Telegram-style DM — one stream; conversations stay DO-logical. */
export function createSingleStreamAdapterSketch(handlers: {
  id: string;
  ensureInbox: NonNullable<SupportChannelAdapter['ensureInbox']>;
  post: SupportChannelAdapter['post'];
}): SupportChannelAdapter {
  return {
    id: handlers.id,
    topology: 'single_stream',
    capabilities: defineCapabilities({
      nestedThreads: false,
      staffCanOpenConversation: true,
    }),
    ensureInbox: handlers.ensureInbox,
    async post(input) {
      const inboxId = input.binding?.inboxId ?? input.inboxId;
      if (!inboxId) throw new Error(`${handlers.id} post requires inboxId`);
      const withBinding: OutboundPostInput = {
        ...input,
        binding:
          input.binding ??
          ({
            adapterId: handlers.id,
            inboxId,
            locationId: inboxId,
          } satisfies ConversationExternalBinding),
        inboxId,
      };
      return handlers.post(withBinding);
    },
  };
}
