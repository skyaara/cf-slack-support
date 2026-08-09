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
  /** Requires `cf-slack-support/features/lifecycle`. */
  | { type: 'close_conversation'; clientId: string; conversationId: string }
  /** Requires `cf-slack-support/features/lifecycle` (may reject permanently). */
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

/** Conservative protocol limits applied before frames reach storage or Slack. */
export const CLIENT_FRAME_LIMITS = {
  maxBytes: 64 * 1024,
  maxClientIdCharacters: 128,
  maxConversationIdCharacters: 128,
  maxMessageCharacters: 8_000,
  maxTitleCharacters: 120,
  maxAttachmentIdCharacters: 512,
  maxAttachments: 10,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalBoundedString(
  value: unknown,
  maxCharacters: number,
): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= maxCharacters);
}

function requiredBoundedString(value: unknown, maxCharacters: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxCharacters;
}

export function parseClientFrame(raw: string): ClientFrame | null {
  if (new TextEncoder().encode(raw).byteLength > CLIENT_FRAME_LIMITS.maxBytes) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data) || typeof data.type !== 'string' || !CLIENT_TYPES.has(data.type)) {
      return null;
    }

    switch (data.type) {
      case 'ping':
        return { type: 'ping' };
      case 'hello':
        if (
          !optionalBoundedString(data.lastSeenId, CLIENT_FRAME_LIMITS.maxConversationIdCharacters) ||
          !optionalBoundedString(data.conversationId, CLIENT_FRAME_LIMITS.maxConversationIdCharacters)
        ) {
          return null;
        }
        return {
          type: 'hello',
          ...(data.lastSeenId ? { lastSeenId: data.lastSeenId } : {}),
          ...(data.conversationId ? { conversationId: data.conversationId } : {}),
        };
      case 'send': {
        if (
          !requiredBoundedString(data.clientId, CLIENT_FRAME_LIMITS.maxClientIdCharacters) ||
          !optionalBoundedString(data.conversationId, CLIENT_FRAME_LIMITS.maxConversationIdCharacters) ||
          !optionalBoundedString(data.body, CLIENT_FRAME_LIMITS.maxMessageCharacters)
        ) {
          return null;
        }
        if (
          data.attachmentIds !== undefined &&
          (!Array.isArray(data.attachmentIds) ||
            data.attachmentIds.length > CLIENT_FRAME_LIMITS.maxAttachments ||
            !data.attachmentIds.every((id) =>
              requiredBoundedString(id, CLIENT_FRAME_LIMITS.maxAttachmentIdCharacters),
            ))
        ) {
          return null;
        }
        return {
          type: 'send',
          clientId: data.clientId,
          ...(data.conversationId ? { conversationId: data.conversationId } : {}),
          ...(data.body !== undefined ? { body: data.body } : {}),
          ...(data.attachmentIds !== undefined ? { attachmentIds: data.attachmentIds } : {}),
        };
      }
      case 'open_conversation':
        if (
          !requiredBoundedString(data.clientId, CLIENT_FRAME_LIMITS.maxClientIdCharacters) ||
          !optionalBoundedString(data.title, CLIENT_FRAME_LIMITS.maxTitleCharacters)
        ) {
          return null;
        }
        return {
          type: 'open_conversation',
          clientId: data.clientId,
          ...(data.title !== undefined ? { title: data.title } : {}),
        };
      case 'close_conversation':
      case 'reopen_conversation':
        if (
          !requiredBoundedString(data.clientId, CLIENT_FRAME_LIMITS.maxClientIdCharacters) ||
          !requiredBoundedString(
            data.conversationId,
            CLIENT_FRAME_LIMITS.maxConversationIdCharacters,
          )
        ) {
          return null;
        }
        return {
          type: data.type,
          clientId: data.clientId,
          conversationId: data.conversationId,
        };
      default:
        return null;
    }
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
