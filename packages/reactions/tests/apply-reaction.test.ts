import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { slackReactionToUnicode } from '@cf-slack-support/emoji';
import { jsonReactions, parseReactions } from '@cf-slack-support/core/utils';
import type { FeatureHost, MessageRow } from '@cf-slack-support/core';
import { applySlackReaction } from '../src/apply-reaction';

function createMockHost(initial: MessageRow): FeatureHost {
  let row = { ...initial };
  return {
    env: {},
    sql: {
      exec<T extends Record<string, unknown>>(_q: string, ...bindings: unknown[]) {
        if (_q.includes('UPDATE')) {
          const json = String(bindings[0]);
          row = { ...row, reactions_json: json };
        }
        return {
          toArray: () => [{ ...row } as unknown as T],
        };
      },
    },
    runtime: async () => {
      throw new Error('not used');
    },
    slack: async () => {
      throw new Error('not used');
    },
    metaGet: () => null,
    metaSet: () => {},
    metaDelete: () => {},
    identityFromMeta: () => ({ customerKey: 'u' }),
    listConversations: () => [],
    getConversation: () => null,
    getConversationByThread: () => null,
    insertConversation: () => {
      throw new Error('no');
    },
    setConversationStatus: () => null,
    insertMessage: (m) => m,
    findByClientId: () => null,
    findBySlackTs: () => null,
    messagesSince: () => [],
    rowToMessage: (r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      body: r.body,
      attachments: [],
      authorRole: 'staff',
      createdAt: r.created_at,
      slackTs: r.slack_ts ?? undefined,
      reactions: parseReactions(r.reactions_json ?? '[]'),
    }),
    broadcast: () => {},
    send: () => {},
    ensureChannel: async () => ({ channelId: 'C', created: false }),
    postToSlack: async () => ({ slackTs: '1', threadTs: '1' }),
    resolveAttachments: async () => [],
    newId: (p) => `${p}_x`,
    hasFeature: (n) => n === 'reactions',
    resolveStaffDisplayName: async () => 'Support',
  };
}

describe('applySlackReaction', () => {
  it('adds and removes standard reactions', () => {
    const host = createMockHost({
      id: 'msg1',
      conversation_id: 'c1',
      body: 'hi',
      attachments_json: '[]',
      author_role: 'staff',
      author_name: 'Sam',
      created_at: 1,
      client_id: null,
      slack_ts: '123.456',
      reactions_json: '[]',
    });

    const added = applySlackReaction(host, {
      slackTs: '123.456',
      reactionName: 'thumbsup',
      delta: 1,
    });
    expect(added?.reactions).toEqual([
      { emoji: slackReactionToUnicode('thumbsup'), name: 'thumbsup', count: 1 },
    ]);

    const again = applySlackReaction(host, {
      slackTs: '123.456',
      reactionName: '+1',
      delta: 1,
    });
    // +1 and thumbsup map to same unicode — may merge by emoji
    expect(again?.reactions?.some((r) => r.emoji === '👍')).toBe(true);

    const removed = applySlackReaction(host, {
      slackTs: '123.456',
      reactionName: 'thumbsup',
      delta: -1,
    });
    // count should decrease or entry drop
    const total =
      removed?.reactions?.reduce((sum, r) => sum + (r.emoji === '👍' ? r.count : 0), 0) ?? 0;
    expect(total).toBeLessThan(again?.reactions?.find((r) => r.emoji === '👍')?.count ?? 99);
  });

  it('ignores custom emoji (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('custom_party_parrot', 'my_workspace_blob', 'not_in_map_zzz'),
        (name) => {
          const host = createMockHost({
            id: 'msg1',
            conversation_id: 'c1',
            body: 'hi',
            attachments_json: '[]',
            author_role: 'staff',
            author_name: null,
            created_at: 1,
            client_id: null,
            slack_ts: '1.1',
            reactions_json: jsonReactions([]),
          });
          expect(
            applySlackReaction(host, { slackTs: '1.1', reactionName: name, delta: 1 }),
          ).toBeNull();
        },
      ),
      { numRuns: 20 },
    );
  });
});
