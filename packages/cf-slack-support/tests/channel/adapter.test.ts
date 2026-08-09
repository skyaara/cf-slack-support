import { describe, expect, it } from 'vitest';
import {
  bindingForTopology,
  createSlackChannelAdapter,
  defineCapabilities,
} from '../../src/channel';
import {
  resolveConversationExternal,
  resolveMessageExternal,
  slackBindingFromLegacy,
  slackThreadTsFromExternal,
} from '../../src/protocol';

describe('external bindings', () => {
  it('derives Slack binding from legacy thread ts', () => {
    const binding = slackBindingFromLegacy({
      channelId: 'C123',
      slackThreadTs: '1.001',
    });
    expect(binding).toEqual({
      adapterId: 'slack',
      inboxId: 'C123',
      locationId: '1.001',
    });
    expect(slackThreadTsFromExternal(binding)).toBe('1.001');
  });

  it('prefers explicit external over slackThreadTs', () => {
    expect(
      resolveConversationExternal({
        external: { adapterId: 'agent', locationId: 'run_1' },
        slackThreadTs: '9.999',
      }),
    ).toEqual({ adapterId: 'agent', locationId: 'run_1' });
  });

  it('maps message refs for Slack and agents', () => {
    expect(resolveMessageExternal({ slackTs: '2.0' })).toEqual({
      adapterId: 'slack',
      messageId: '2.0',
    });
    expect(
      resolveMessageExternal({
        external: { adapterId: 'agent', messageId: 'm1' },
        slackTs: '2.0',
      }),
    ).toEqual({ adapterId: 'agent', messageId: 'm1' });
  });
});

describe('channel topologies', () => {
  it('builds bindings per topology', () => {
    expect(
      bindingForTopology({
        adapterId: 'slack',
        topology: 'inbox_with_threads',
        inboxId: 'C1',
        locationId: '1.0',
      }),
    ).toEqual({ adapterId: 'slack', inboxId: 'C1', locationId: '1.0' });

    expect(
      bindingForTopology({
        adapterId: 'telegram',
        topology: 'single_stream',
        inboxId: 'dm:42',
      }),
    ).toEqual({ adapterId: 'telegram', inboxId: 'dm:42', locationId: 'dm:42' });

    expect(
      bindingForTopology({
        adapterId: 'agent',
        topology: 'one_location_per_conversation',
        locationId: 'session_9',
      }),
    ).toEqual({ adapterId: 'agent', locationId: 'session_9' });
  });

  it('Slack adapter posts create thread roots then reuse them', async () => {
    const posts: Array<{ inboxId: string; threadTs: string | null }> = [];
    const adapter = createSlackChannelAdapter({
      ensureInbox: async () => ({ inboxId: 'C1', created: false }),
      postMessage: async (input) => {
        posts.push({ inboxId: input.inboxId, threadTs: input.threadTs });
        const ts = input.threadTs ?? '10.0';
        return { messageTs: input.threadTs ? '10.1' : '10.0', threadRootTs: ts };
      },
    });

    expect(adapter.capabilities).toEqual(
      defineCapabilities({
        nestedThreads: true,
        reactions: true,
        editMessage: true,
        staffCanOpenConversation: true,
      }),
    );

    const conversation = {
      id: 'conv1',
      title: null,
      slackThreadTs: null,
      status: 'open' as const,
      closedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const message = {
      id: 'm1',
      conversationId: 'conv1',
      body: 'hi',
      attachments: [],
      authorRole: 'customer' as const,
      createdAt: 1,
    };

    const first = await adapter.post({
      identity: { customerKey: 'u1' },
      conversation,
      message,
      binding: null,
      inboxId: 'C1',
    });
    expect(first.createdLocation).toBe(true);
    expect(first.binding.locationId).toBe('10.0');

    const second = await adapter.post({
      identity: { customerKey: 'u1' },
      conversation: { ...conversation, external: first.binding, slackThreadTs: '10.0' },
      message: { ...message, id: 'm2' },
      binding: first.binding,
      inboxId: 'C1',
    });
    expect(second.createdLocation).toBe(false);
    expect(posts[1]?.threadTs).toBe('10.0');
  });
});
