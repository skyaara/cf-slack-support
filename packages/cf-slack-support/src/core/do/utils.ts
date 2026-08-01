import type { ClientFrame, SupportAttachment, SupportMessage, SupportReaction } from '../../protocol';

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function jsonAttachments(value: SupportAttachment[]): string {
  return JSON.stringify(value);
}

export function parseAttachments(raw: string): SupportAttachment[] {
  try {
    const parsed = JSON.parse(raw) as SupportAttachment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function jsonReactions(value: SupportReaction[]): string {
  return JSON.stringify(value);
}

export function parseReactions(raw: string): SupportReaction[] {
  try {
    const parsed = JSON.parse(raw) as SupportReaction[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r) =>
          r &&
          typeof r.emoji === 'string' &&
          r.emoji.trim() &&
          typeof r.name === 'string' &&
          typeof r.count === 'number' &&
          r.count > 0,
      )
      .map((r) => ({
        emoji: r.emoji.trim(),
        name: r.name.trim() || r.emoji.trim(),
        count: Math.floor(r.count),
      }));
  } catch {
    return [];
  }
}

export function extensionForMime(mime: string): string | null {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return null;
  }
}

export function extensionForMimeOrBin(mime: string): string {
  return extensionForMime(mime) || 'bin';
}

/** Map internal failures to stable, user-safe WS error payloads. */
export function clientSafeError(
  raw: string,
  frameType: ClientFrame['type'] | string,
): { code: string; message: string } {
  if (/UNIQUE constraint failed:\s*messages\.slack_ts/i.test(raw) || /SQLITE_CONSTRAINT/i.test(raw)) {
    return {
      code: 'send_failed',
      message: 'Could not save that message. Please try again.',
    };
  }
  if (/^Slack\b/i.test(raw) || /slack\s+\w+\s+failed/i.test(raw)) {
    return {
      code: 'slack_failed',
      message: 'Could not deliver to support right now. Please try again.',
    };
  }
  if (frameType === 'send') {
    return {
      code: 'send_failed',
      message: 'Could not send that message. Please try again.',
    };
  }
  if (frameType === 'open_conversation') {
    return {
      code: 'open_failed',
      message: 'Could not start a new conversation. Please try again.',
    };
  }
  if (frameType === 'close_conversation') {
    return {
      code: 'close_failed',
      message: 'Could not close that request. Please try again.',
    };
  }
  if (frameType === 'reopen_conversation') {
    return {
      code: 'conversation_closed',
      message: 'This request is closed and cannot be reopened.',
    };
  }
  if (raw.includes('feature_not_enabled')) {
    return {
      code: 'feature_not_enabled',
      message: 'This feature is not enabled on the server.',
    };
  }
  return {
    code: 'handler_error',
    message: 'Something went wrong. Please try again.',
  };
}

export function buildBlocks(
  message: SupportMessage,
  title?: string | null,
  opts?: { asCustomUsername?: boolean },
): unknown[] {
  const blocks: unknown[] = [];
  if (title) {
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: title.slice(0, 150) },
    });
  }
  if (message.body) {
    const text = opts?.asCustomUsername
      ? message.body
      : `*${message.authorName || 'Customer'}:*\n${message.body}`;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    });
  }
  for (const attachment of message.attachments) {
    if (attachment.contentType.startsWith('image/')) {
      blocks.push({
        type: 'image',
        image_url: attachment.url,
        alt_text: attachment.filename || 'image',
      });
    }
  }
  return blocks;
}

export function titleFromFirstMessage(body: string | null, attachmentCount: number): string {
  const text = body?.trim();
  if (text) return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  if (attachmentCount > 0) return 'Image';
  return 'New chat';
}

export function isMissingChannelError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('channel_not_found') ||
    message.includes('not_in_channel') ||
    message.includes('is_archived') ||
    message.includes('channel_is_archived')
  );
}
