/** Node-safe utils (no `cloudflare:workers` import). */
export {
  buildBlocks,
  clientSafeError,
  extensionForMime,
  extensionForMimeOrBin,
  isMissingChannelError,
  jsonAttachments,
  jsonReactions,
  newId,
  parseAttachments,
  parseReactions,
  titleFromFirstMessage,
} from './do/utils';
