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

export function isSafeInlineImageMime(mime: string): boolean {
  return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif';
}

/** Validate the magic bytes for image types rendered inline by this package. */
export function hasExpectedImageSignature(bytes: ArrayBuffer, mime: string): boolean {
  const value = new Uint8Array(bytes);
  switch (mime) {
    case 'image/jpeg':
      return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
    case 'image/png':
      return (
        value.length >= 8 &&
        value[0] === 0x89 &&
        value[1] === 0x50 &&
        value[2] === 0x4e &&
        value[3] === 0x47 &&
        value[4] === 0x0d &&
        value[5] === 0x0a &&
        value[6] === 0x1a &&
        value[7] === 0x0a
      );
    case 'image/gif': {
      const header = new TextDecoder().decode(value.slice(0, 6));
      return header === 'GIF87a' || header === 'GIF89a';
    }
    case 'image/webp': {
      const riff = new TextDecoder().decode(value.slice(0, 4));
      const webp = new TextDecoder().decode(value.slice(8, 12));
      return value.length >= 12 && riff === 'RIFF' && webp === 'WEBP';
    }
    default:
      return false;
  }
}

/** Render untrusted text literally inside Slack mrkdwn. */
export function escapeSlackMrkdwn(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    const safeBody = escapeSlackMrkdwn(message.body);
    const safeAuthor = escapeSlackMrkdwn(message.authorName || 'Customer');
    const text = opts?.asCustomUsername
      ? safeBody
      : `*${safeAuthor}:*\n${safeBody}`;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    });
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
