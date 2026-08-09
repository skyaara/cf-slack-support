/**
 * Channel adapter contract — external surfaces for support conversations.
 *
 * **Own this interface.** Implement Slack / agent / Discord as adapters.
 * Optionally wrap Chat SDK or AG-UI *inside* an adapter; do not make those
 * SDKs the public API of `cf-slack-support`.
 *
 * @see {@link SupportChannelAdapter}
 * @see {@link ChannelTopology} for how non-threaded platforms bind conversations
 */

export type {
  ChannelAdapterHost,
  ChannelAdapterId,
  ChannelCapabilities,
  ChannelTopology,
  ConversationExternalBinding,
  EnsureInboxResult,
  InboxRoutingMode,
  InboundMessageEvent,
  InboundReactionEvent,
  MessageExternalRef,
  OutboundPostInput,
  OutboundPostResult,
  OutboundStreamInput,
  ParticipantRole,
  SupportChannelAdapter,
} from './types';

export { bindingForTopology, defineCapabilities } from './types';

export {
  slackBindingFromLegacy as slackBindingFromConversation,
  slackThreadTsFromExternal as slackThreadTsFromBinding,
} from '../protocol';

export {
  createAgentChannelAdapterSketch,
  createSingleStreamAdapterSketch,
  createSlackChannelAdapter,
} from './adapters';
export type { SlackChannelAdapterOptions } from './adapters';
