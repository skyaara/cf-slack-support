import type { ClientFrame, SupportConversation, SupportMessage } from '../../protocol';
import type { FeatureHost, SupportFeature } from '../../core';
import { createSlackClient } from '../../slack';

export type LifecycleFeatureOptions = {
  /**
   * When false (default, matches Flickks), reopen is rejected and customers
   * must open a new conversation.
   */
  allowReopen?: boolean;
};

async function setConversationLifecycle(
  host: FeatureHost,
  input: {
    conversationId: string;
    status: SupportConversation['status'];
    channelId: string;
    customerKey: string;
  },
): Promise<{
  conversation: SupportConversation;
  systemMessage: SupportMessage | null;
  noop: boolean;
} | null> {
  const current = host.getConversation(input.conversationId);
  if (!current) return null;
  if (current.status === input.status) {
    return { conversation: current, systemMessage: null, noop: true };
  }

  const at = Date.now();
  const conversation = host.setConversationStatus(input.conversationId, input.status, at);
  if (!conversation) return null;

  const body =
    input.status === 'closed'
      ? 'Request closed by customer'
      : 'Request reopened by customer';
  const systemMessage: SupportMessage = {
    id: host.newId('msg'),
    conversationId: conversation.id,
    body,
    attachments: [],
    authorRole: 'system',
    authorName: 'System',
    createdAt: at,
  };

  let slackTs: string | undefined;
  const binding =
    conversation.external ??
    (conversation.slackThreadTs
      ? {
          adapterId: 'slack' as const,
          inboxId: input.channelId,
          locationId: conversation.slackThreadTs,
        }
      : null);
  if (binding?.adapterId === 'slack' && binding.locationId) {
    try {
      const runtime = await host.runtime();
      const slack = createSlackClient({ botToken: runtime.slack.botToken });
      const notice =
        input.status === 'closed'
          ? '_Request closed by customer_'
          : '_Request reopened by customer_';
      const posted = await slack.postMessage({
        channel: binding.inboxId ?? input.channelId,
        text: notice,
        threadTs: binding.locationId,
      });
      slackTs = posted.ts;
    } catch (err) {
      console.warn('[cf-slack-support] lifecycle slack notice failed', {
        conversationId: conversation.id,
        status: input.status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stored = host.insertMessage({
    ...systemMessage,
    external: slackTs ? { adapterId: 'slack', messageId: slackTs } : null,
    slackTs,
  });
  const runtime = await host.runtime();
  await runtime.onMessage?.({
    customerKey: input.customerKey,
    message: stored,
    conversation,
    direction: 'to_slack',
    adapterId: 'slack',
  });

  return { conversation, systemMessage: stored, noop: false };
}

/** Enable close/reopen conversation frames. Import from `cf-slack-support/features/lifecycle`. */
export function lifecycleFeature<Env extends object = Record<string, unknown>>(
  options: LifecycleFeatureOptions = {},
): SupportFeature<Env> {
  const allowReopen = options.allowReopen === true;

  return {
    name: 'lifecycle',
    async onClientFrame(host, ws, frame, customerKey) {
      if (frame.type !== 'close_conversation' && frame.type !== 'reopen_conversation') {
        return 'pass';
      }

      if (frame.type === 'reopen_conversation' && !allowReopen) {
        host.send(ws, {
          type: 'error',
          code: 'conversation_closed',
          message: 'This request is closed and cannot be reopened.',
          clientId: frame.clientId,
        });
        return 'handled';
      }

      const identity = host.identityFromMeta();
      const { channelId } = await host.ensureChannel({
        customerKey,
        displayName: identity.displayName,
        meta: identity.meta,
      });

      const result = await setConversationLifecycle(host, {
        conversationId: (frame as Extract<ClientFrame, { type: 'close_conversation' }>)
          .conversationId,
        status: frame.type === 'close_conversation' ? 'closed' : 'open',
        channelId,
        customerKey,
      });

      if (!result) {
        host.send(ws, {
          type: 'error',
          code: 'not_found',
          message: 'Conversation not found',
          clientId: frame.clientId,
        });
        return 'handled';
      }

      if (result.noop) {
        host.send(ws, { type: 'conversation', conversation: result.conversation });
        host.send(ws, {
          type: 'ack',
          clientId: frame.clientId,
          messageId: result.conversation.id,
        });
        return 'handled';
      }

      host.broadcast({ type: 'conversation', conversation: result.conversation });
      if (result.systemMessage) {
        host.broadcast({ type: 'message', message: result.systemMessage });
      }
      host.send(ws, {
        type: 'ack',
        clientId: frame.clientId,
        messageId: result.conversation.id,
      });
      return 'handled';
    },
  };
}
