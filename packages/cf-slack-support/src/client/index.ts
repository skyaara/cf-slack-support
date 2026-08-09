/**
 * Browser entry: `import { createSupportClient } from 'cf-slack-support/client'`
 *
 * Does **not** pull Durable Objects, Slack verify, media stores, or feature plugins.
 * Re-exports only protocol types/parsers apps need for typed UI state.
 */

export { createSupportClient } from './create-client';
export type {
  CreateSupportClientOptions,
  SupportClient,
  SupportClientEvents,
  SupportClientStatus,
} from './create-client';

export type {
  ClientFrame,
  ServerFrame,
  ConversationExternalBinding,
  MessageExternalRef,
  SupportAttachment,
  SupportAuthorRole,
  SupportConversation,
  SupportConversationStatus,
  SupportMessage,
  SupportReaction,
  UploadResponse,
} from '../protocol';
export {
  parseClientFrame,
  parseServerFrame,
  isClientFrameType,
  isServerFrameType,
} from '../protocol';
