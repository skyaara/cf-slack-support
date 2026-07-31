import type { SupportAttachment, SupportConversation, SupportMessage } from './types';

/** Client → server WebSocket frames (core + optional feature frames). */
export type ClientFrame =
  | { type: 'hello'; lastSeenId?: string; conversationId?: string }
  | {
      type: 'send';
      clientId: string;
      conversationId?: string;
      body?: string;
      /** Attachment ids previously returned by POST /uploads. */
      attachmentIds?: string[];
    }
  | { type: 'open_conversation'; clientId: string; title?: string }
  /** Requires `@cf-slack-support/lifecycle`. */
  | { type: 'close_conversation'; clientId: string; conversationId: string }
  /** Requires `@cf-slack-support/lifecycle` (may reject permanently). */
  | { type: 'reopen_conversation'; clientId: string; conversationId: string }
  | { type: 'ping' };

/** Server → client WebSocket frames. */
export type ServerFrame =
  | {
      type: 'ready';
      customerKey: string;
      channelReady: boolean;
      conversations: SupportConversation[];
    }
  | { type: 'message'; message: SupportMessage }
  | { type: 'messages'; messages: SupportMessage[] }
  | { type: 'conversation'; conversation: SupportConversation }
  | { type: 'ack'; clientId: string; messageId: string }
  | { type: 'error'; code: string; message: string; clientId?: string }
  | { type: 'pong' };

const CLIENT_TYPES = new Set([
  'hello',
  'send',
  'open_conversation',
  'close_conversation',
  'reopen_conversation',
  'ping',
]);

const SERVER_TYPES = new Set([
  'ready',
  'message',
  'messages',
  'conversation',
  'ack',
  'error',
  'pong',
]);

export function parseClientFrame(raw: string): ClientFrame | null {
  try {
    const data = JSON.parse(raw) as { type?: string };
    if (!data || typeof data.type !== 'string') return null;
    if (!CLIENT_TYPES.has(data.type)) return null;
    return data as ClientFrame;
  } catch {
    return null;
  }
}

export function parseServerFrame(raw: string): ServerFrame | null {
  try {
    const data = JSON.parse(raw) as { type?: string };
    if (!data || typeof data.type !== 'string') return null;
    if (!SERVER_TYPES.has(data.type)) return null;
    return data as ServerFrame;
  } catch {
    return null;
  }
}

export type UploadResponse = {
  attachment: SupportAttachment;
};

export function isClientFrameType(type: string): type is ClientFrame['type'] {
  return CLIENT_TYPES.has(type);
}

export function isServerFrameType(type: string): type is ServerFrame['type'] {
  return SERVER_TYPES.has(type);
}
