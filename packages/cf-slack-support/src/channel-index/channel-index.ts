import type { ChannelIndex } from '../protocol';

const CHANNEL_PREFIX = 'channel:';

/** Default channel index backed by a Workers KV namespace. */
export function createKvChannelIndex(kv: KVNamespace): ChannelIndex {
  return {
    async getCustomerKey(channelId: string) {
      return kv.get(`${CHANNEL_PREFIX}${channelId}`);
    },
    async setCustomerKey(channelId: string, customerKey: string) {
      await kv.put(`${CHANNEL_PREFIX}${channelId}`, customerKey);
    },
  };
}

/** In-memory index for tests / single-isolate demos (not durable across isolates). */
export function createMemoryChannelIndex(
  map: Map<string, string> = new Map(),
): ChannelIndex {
  return {
    async getCustomerKey(channelId: string) {
      return map.get(channelId) ?? null;
    },
    async setCustomerKey(channelId: string, customerKey: string) {
      map.set(channelId, customerKey);
    },
  };
}
