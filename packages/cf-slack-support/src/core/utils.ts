/** Node-safe utils (no `cloudflare:workers` import). */
export {
  buildBlocks,
  clientSafeError,
  extensionForMime,
  extensionForMimeOrBin,
  escapeSlackMrkdwn,
  hasExpectedImageSignature,
  isSafeInlineImageMime,
  isMissingChannelError,
  jsonAttachments,
  jsonReactions,
  newId,
  parseAttachments,
  parseReactions,
  titleFromFirstMessage,
} from './do/utils';
