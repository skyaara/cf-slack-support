import type { SupportFeature } from '@cf-slack-support/core';
import { applySlackReaction } from './apply-reaction';

type SlackReactionEvent = {
  type?: string;
  reaction?: string;
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
};

/** Enable Slack → customer reaction sync. Peer: `@cf-slack-support/reactions`. */
export function reactionsFeature<Env extends object = Record<string, unknown>>(): SupportFeature<Env> {
  return {
    name: 'reactions',
    migrate() {
      // Column is part of core schema for stable SQLite; feature gates exposure.
    },
    async onSlackEvent(host, event) {
      const e = event as SlackReactionEvent;
      if (e.type !== 'reaction_added' && e.type !== 'reaction_removed') {
        return 'pass';
      }
      if (e.item?.type !== 'message') return 'handled';
      const slackTs = e.item.ts;
      const reactionName = e.reaction;
      if (!slackTs || !reactionName) return 'handled';

      const updated = applySlackReaction(host, {
        slackTs,
        reactionName,
        delta: e.type === 'reaction_added' ? 1 : -1,
      });
      if (updated) {
        host.broadcast({ type: 'message', message: updated });
      }
      return 'handled';
    },
  };
}
