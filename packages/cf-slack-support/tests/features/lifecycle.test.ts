import { describe, expect, it } from 'vitest';
import type { FeatureHost } from '../../src/core';
import type { SupportConversation } from '../../src/protocol';
import { lifecycleFeature } from '../../src/features/lifecycle';

function createHost(conversation: SupportConversation): FeatureHost & {
  sent: unknown[];
  broadcasts: unknown[];
} {
  const sent: unknown[] = [];
  const broadcasts: unknown[] = [];
  let conv = { ...conversation };

  return {
    sent,
    broadcasts,
    env: {},
    sql: { exec: () => ({ toArray: () => [] }) },
    runtime: async () =>
      ({
        slack: { botToken: 'x', signingSecret: 'y' },
        channelIndex: {
          getCustomerKey: async () => null,
          setCustomerKey: async () => {},
        },
        customers: {
          idFromName: () => 'id',
          get: () => ({ fetch: async () => new Response() }),
        },
        staffUserIds: [],
        channelIsPrivate: true,
        channelName: () => 'support-u',
        corsOrigins: '*',
      }) as never,
    slack: async () => {
      throw new Error('unused');
    },
    metaGet: () => null,
    metaSet: () => {},
    metaDelete: () => {},
    identityFromMeta: () => ({ customerKey: 'u1' }),
    listConversations: () => [conv],
    getConversation: (id) => (id === conv.id ? conv : null),
    getConversationByThread: () => null,
    getConversationByBinding: () => null,
    insertConversation: () => conv,
    bindConversation: () => {},
    setConversationStatus: (id, status, at) => {
      if (id !== conv.id) return null;
      conv = {
        ...conv,
        status,
        closedAt: status === 'closed' ? at : null,
        updatedAt: at,
      };
      return conv;
    },
    insertMessage: (m) => m,
    findByClientId: () => null,
    findBySlackTs: () => null,
    findMessageByExternalRef: () => null,
    messagesSince: () => [],
    rowToMessage: () => {
      throw new Error('unused');
    },
    broadcast: (frame) => {
      broadcasts.push(frame);
    },
    send: (_ws, frame) => {
      sent.push(frame);
    },
    ensureChannel: async () => ({ channelId: 'C1', created: false }),
    postToSlack: async () => ({ slackTs: '1', threadTs: '1' }),
    resolveAttachments: async () => [],
    newId: (p) => `${p}_test`,
    hasFeature: (n) => n === 'lifecycle',
    resolveStaffDisplayName: async () => 'Support',
  };
}

describe('lifecycleFeature', () => {
  it('closes an open conversation and acks', async () => {
    const feature = lifecycleFeature();
    const host = createHost({
      id: 'conv_1',
      title: 'Hi',
      slackThreadTs: null,
      status: 'open',
      closedAt: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const ws = {} as WebSocket;

    const result = await feature.onClientFrame?.(
      host,
      ws,
      { type: 'close_conversation', clientId: 'c1', conversationId: 'conv_1' },
      'u1',
    );
    expect(result).toBe('handled');
    expect(host.getConversation('conv_1')?.status).toBe('closed');
    expect(host.broadcasts.some((f) => (f as { type: string }).type === 'conversation')).toBe(
      true,
    );
    expect(host.sent.some((f) => (f as { type: string }).type === 'ack')).toBe(true);
  });

  it('rejects reopen by default (Flickks behavior)', async () => {
    const feature = lifecycleFeature();
    const host = createHost({
      id: 'conv_1',
      title: null,
      slackThreadTs: null,
      status: 'closed',
      closedAt: 2,
      createdAt: 1,
      updatedAt: 2,
    });
    const result = await feature.onClientFrame?.(
      host,
      {} as WebSocket,
      { type: 'reopen_conversation', clientId: 'c1', conversationId: 'conv_1' },
      'u1',
    );
    expect(result).toBe('handled');
    expect(host.sent[0]).toMatchObject({
      type: 'error',
      code: 'conversation_closed',
    });
  });

  it('passes non-lifecycle frames', async () => {
    const feature = lifecycleFeature();
    const host = createHost({
      id: 'conv_1',
      title: null,
      slackThreadTs: null,
      status: 'open',
      closedAt: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const result = await feature.onClientFrame?.(
      host,
      {} as WebSocket,
      { type: 'ping' },
      'u1',
    );
    expect(result).toBe('pass');
  });
});
