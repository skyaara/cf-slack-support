/**
 * Opaque links from durable support entities to an external channel adapter.
 * Defined in protocol so conversations/messages can carry them without importing
 * the full adapter interface (`cf-slack-support/channel`).
 */

/** Stable adapter id (`slack`, `discord`, `agent`, …). */
export type ChannelAdapterId = string;

/**
 * Binding from a {@link import('./types').SupportConversation} to one platform location.
 * Only the owning adapter interprets the string ids.
 */
export type ConversationExternalBinding = {
  adapterId: ChannelAdapterId;
  /**
   * Shared container when the platform uses an inbox + nested threads
   * (e.g. Slack channel id). Omitted for flat / 1:1 locations.
   */
  inboxId?: string;
  /**
   * Platform id for *this* conversation:
   * - Slack: thread root `ts`
   * - Discord thread / agent session: that id
   * - single-stream DMs: usually equals `inboxId`
   */
  locationId: string;
};

/** Per-message platform id (Slack `ts`, Discord snowflake, agent event id, …). */
export type MessageExternalRef = {
  adapterId: ChannelAdapterId;
  messageId: string;
};

/** Build a Slack binding from legacy channel + thread fields. */
export function slackBindingFromLegacy(input: {
  channelId?: string | null;
  slackThreadTs: string | null | undefined;
}): ConversationExternalBinding | null {
  const locationId = input.slackThreadTs?.trim();
  if (!locationId) return null;
  const inboxId = input.channelId?.trim() || undefined;
  return {
    adapterId: 'slack',
    ...(inboxId ? { inboxId } : {}),
    locationId,
  };
}

export function slackThreadTsFromExternal(
  external: ConversationExternalBinding | null | undefined,
): string | null {
  if (!external || external.adapterId !== 'slack') return null;
  return external.locationId;
}

export function slackMessageRef(messageId: string): MessageExternalRef {
  return { adapterId: 'slack', messageId };
}

export function slackTsFromExternal(
  external: MessageExternalRef | null | undefined,
): string | undefined {
  if (!external || external.adapterId !== 'slack') return undefined;
  return external.messageId;
}

/** Prefer explicit external; else derive from legacy Slack thread ts. */
export function resolveConversationExternal(input: {
  external?: ConversationExternalBinding | null;
  slackThreadTs?: string | null;
  channelId?: string | null;
}): ConversationExternalBinding | null {
  if (input.external?.locationId) return input.external;
  return slackBindingFromLegacy({
    channelId: input.channelId,
    slackThreadTs: input.slackThreadTs,
  });
}

/** Prefer explicit external; else derive from legacy `slackTs`. */
export function resolveMessageExternal(input: {
  external?: MessageExternalRef | null;
  slackTs?: string | null;
}): MessageExternalRef | null {
  if (input.external?.messageId) return input.external;
  const slackTs = input.slackTs?.trim();
  if (!slackTs) return null;
  return slackMessageRef(slackTs);
}
