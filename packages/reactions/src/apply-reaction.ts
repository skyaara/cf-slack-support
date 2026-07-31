import type { SupportMessage, SupportReaction } from '@cf-slack-support/protocol';
import { slackReactionToUnicode } from '@cf-slack-support/emoji';
import { jsonReactions, parseReactions } from '@cf-slack-support/core/utils';
import type { FeatureHost, MessageRow } from '@cf-slack-support/core';

/**
 * Apply a Slack reaction_added / reaction_removed to a stored message.
 * Custom / unmapped emoji are ignored.
 */
export function applySlackReaction(
  host: FeatureHost,
  input: {
    slackTs: string;
    reactionName: string;
    delta: 1 | -1;
  },
): SupportMessage | null {
  const unicode = slackReactionToUnicode(input.reactionName);
  if (!unicode) {
    return null;
  }

  const row = host.sql
    .exec<MessageRow>(`SELECT * FROM messages WHERE slack_ts = ?`, input.slackTs)
    .toArray()[0];
  if (!row) return null;

  const current = parseReactions(row.reactions_json ?? '[]');
  const name = input.reactionName.trim().toLowerCase().split('::')[0] || input.reactionName;
  const idx = current.findIndex((r) => r.emoji === unicode || r.name === name);
  let next: SupportReaction[];

  if (input.delta === 1) {
    if (idx >= 0) {
      next = current.map((r, i) =>
        i === idx ? { ...r, count: r.count + 1, emoji: unicode, name } : r,
      );
    } else {
      next = [...current, { emoji: unicode, name, count: 1 }];
    }
  } else {
    if (idx < 0) return host.rowToMessage(row);
    const updated = {
      ...current[idx]!,
      count: current[idx]!.count - 1,
    };
    next =
      updated.count <= 0
        ? current.filter((_, i) => i !== idx)
        : current.map((r, i) => (i === idx ? updated : r));
  }

  host.sql.exec(
    `UPDATE messages SET reactions_json = ? WHERE id = ?`,
    jsonReactions(next),
    row.id,
  );

  const refreshed = host.sql
    .exec<MessageRow>(`SELECT * FROM messages WHERE id = ?`, row.id)
    .toArray()[0];
  return refreshed ? host.rowToMessage(refreshed) : null;
}
