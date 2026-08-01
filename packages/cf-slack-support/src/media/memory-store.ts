import type { MediaObject, MediaStore, StoredMedia } from '../protocol';

type Entry = {
  body: ArrayBuffer;
  contentType: string;
  customMetadata?: Record<string, string>;
};

/** In-memory MediaStore for tests. */
export function createMemoryMediaStore(publicBaseUrl = 'https://media.test'): MediaStore {
  const map = new Map<string, Entry>();

  return {
    async put(object: MediaObject): Promise<StoredMedia> {
      let body: ArrayBuffer;
      if (object.body instanceof ArrayBuffer) {
        body = object.body;
      } else if (object.body instanceof Uint8Array) {
        body = object.body.buffer.slice(
          object.body.byteOffset,
          object.body.byteOffset + object.body.byteLength,
        ) as ArrayBuffer;
      } else if (typeof object.body === 'string') {
        body = new TextEncoder().encode(object.body).buffer as ArrayBuffer;
      } else if (object.body instanceof Blob) {
        body = await object.body.arrayBuffer();
      } else {
        body = await new Response(object.body).arrayBuffer();
      }
      map.set(object.key, {
        body,
        contentType: object.contentType,
        customMetadata: object.customMetadata,
      });
      return {
        key: object.key,
        contentType: object.contentType,
        bytes: body.byteLength,
        etag: `"${body.byteLength}"`,
      };
    },
    async get(key: string) {
      const entry = map.get(key);
      if (!entry) return null;
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(entry.body));
            controller.close();
          },
        }),
        contentType: entry.contentType,
        bytes: entry.body.byteLength,
        etag: `"${entry.body.byteLength}"`,
      };
    },
    publicUrl(key: string) {
      return `${publicBaseUrl.replace(/\/+$/, '')}/media/${key}`;
    },
  };
}
