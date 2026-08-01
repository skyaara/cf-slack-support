/**
 * Staff ↔ customer channel routing policies.
 *
 * One Slack channel per customer. Conversations with the customer live in
 * **threads**. These policies control what happens when staff posts in the
 * **channel root** (no `thread_ts`) vs inside a thread.
 *
 * | Mode | Channel root (top-level) | Thread reply |
 * |------|--------------------------|--------------|
 * | `threads_only` | Dropped (staff must reply in-thread) | → customer |
 * | `bidirectional` | Starts a new customer conversation | → customer |
 * | `staff_main_customer_threads` | Staff-only (not shown to customer) | → customer |
 *
 * Pass via `getRuntime().channelPolicy` (preset object, mode string, or full config).
 */

/** Built-in policy modes. */
export type ChannelPolicyMode =
  | 'threads_only'
  | 'bidirectional'
  | 'staff_main_customer_threads';

/**
 * Full policy config. Prefer presets from {@link CHANNEL_POLICY_PRESETS}
 * unless you need future extension fields.
 */
export type ChannelPolicy = {
  mode: ChannelPolicyMode;
};

/** Anything apps may pass on runtime — normalized by {@link resolveChannelPolicy}. */
export type ChannelPolicyInput = ChannelPolicyMode | ChannelPolicy | undefined | null;

/** Preset policies (frozen) for ergonomic imports. */
export const CHANNEL_POLICY_PRESETS = {
  /**
   * Staff can only reach customers by **replying in a thread**.
   * Top-level channel posts are ignored for the customer app.
   */
  threadsOnly: { mode: 'threads_only' } as const satisfies ChannelPolicy,

  /**
   * **Two-sided initiation**: a top-level staff message starts a new
   * customer conversation (thread root = that message). Customers can
   * still open chats from the app. This is the default.
   */
  bidirectional: { mode: 'bidirectional' } as const satisfies ChannelPolicy,

  /**
   * Channel root is **staff-only chatter** (not delivered to customers).
   * Only messages inside threads sync to the customer app.
   */
  staffMainCustomerThreads: {
    mode: 'staff_main_customer_threads',
  } as const satisfies ChannelPolicy,
} as const;

export type ChannelPolicyPresetName = keyof typeof CHANNEL_POLICY_PRESETS;

/** Default when `channelPolicy` is omitted. */
export const DEFAULT_CHANNEL_POLICY: ChannelPolicy = CHANNEL_POLICY_PRESETS.bidirectional;

/** Why an inbound staff message was not delivered to the customer. */
export type InboundStaffDropReason =
  | 'missing_ts'
  | 'top_level_threads_only'
  | 'top_level_staff_main';

/**
 * Decision for a staff Slack `message` event after bot-echo filters.
 * Pure function — unit-test without Durable Objects.
 */
export type InboundStaffMessageDecision =
  | {
      action: 'deliver_to_customer';
      /** Value stored as `conversation.slackThreadTs`. */
      threadRoot: string;
      /** True when this Slack message is the parent of a new conversation. */
      isThreadParent: boolean;
    }
  | {
      action: 'drop';
      reason: InboundStaffDropReason;
    };

/** Minimal Slack message fields needed for policy routing. */
export type InboundStaffMessageRef = {
  ts?: string | null;
  thread_ts?: string | null;
};

/** Normalize runtime input → full {@link ChannelPolicy}. */
export function resolveChannelPolicy(input: ChannelPolicyInput): ChannelPolicy {
  if (input == null) return { ...DEFAULT_CHANNEL_POLICY };
  if (typeof input === 'string') {
    if (
      input === 'threads_only' ||
      input === 'bidirectional' ||
      input === 'staff_main_customer_threads'
    ) {
      return { mode: input };
    }
    return { ...DEFAULT_CHANNEL_POLICY };
  }
  if (
    input.mode === 'threads_only' ||
    input.mode === 'bidirectional' ||
    input.mode === 'staff_main_customer_threads'
  ) {
    return { mode: input.mode };
  }
  return { ...DEFAULT_CHANNEL_POLICY };
}

/**
 * Decide whether a staff channel/thread message should create or update a
 * customer conversation.
 */
export function decideInboundStaffMessage(
  policyInput: ChannelPolicyInput,
  event: InboundStaffMessageRef,
): InboundStaffMessageDecision {
  const policy = resolveChannelPolicy(policyInput);
  const ts = event.ts?.trim();
  if (!ts) {
    return { action: 'drop', reason: 'missing_ts' };
  }

  const threadTs = event.thread_ts?.trim() || null;

  // Reply (or thread_broadcast) inside an existing thread.
  if (threadTs) {
    return {
      action: 'deliver_to_customer',
      threadRoot: threadTs,
      isThreadParent: false,
    };
  }

  // Top-level channel message (no thread_ts).
  switch (policy.mode) {
    case 'bidirectional':
      return {
        action: 'deliver_to_customer',
        threadRoot: ts,
        isThreadParent: true,
      };
    case 'threads_only':
      return { action: 'drop', reason: 'top_level_threads_only' };
    case 'staff_main_customer_threads':
      return { action: 'drop', reason: 'top_level_staff_main' };
    default: {
      const _exhaustive: never = policy.mode;
      return _exhaustive;
    }
  }
}

/** Human-readable summary for docs / health endpoints. */
export function describeChannelPolicy(input: ChannelPolicyInput): string {
  const { mode } = resolveChannelPolicy(input);
  switch (mode) {
    case 'threads_only':
      return 'Staff must reply in threads; top-level channel posts are not delivered to customers.';
    case 'bidirectional':
      return 'Top-level staff posts start a new customer conversation; thread replies continue it.';
    case 'staff_main_customer_threads':
      return 'Channel root is staff-only; only thread messages are delivered to customers.';
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}
