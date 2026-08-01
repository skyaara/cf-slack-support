import type { MediaObject, MediaStore, StoredMedia } from '../protocol';

export type R2MediaStoreOptions = {
  bucket: R2Bucket;
  /** Absolute public base, e.g. https://www.flickks.com/support-api */
  publicBaseUrl: string;
  /**
   * URL path prefix for served objects (no trailing slash).
   * Default: `/media`
   */
  urlPathPrefix?: string;
  /** Optional key prefix inside the bucket, e.g. `support/`. */
  keyPrefix?: string;
};

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function joinUrl(base: string, ...parts: string[]): string {
  const origin = base.replace(/\/+$/, '');
  const path = parts
    .map((p) => trimSlashes(p))
    .filter(Boolean)
    .join('/');
  return path ? `${origin}/${path}` : origin;
}

/** R2-backed MediaStore with public URLs under your support CDN host. */
export function createR2MediaStore(options: R2MediaStoreOptions): MediaStore {
  const urlPathPrefix = options.urlPathPrefix ?? '/media';
  const keyPrefix = options.keyPrefix ?? '';

  function fullKey(key: string): string {
    const clean = key.replace(/^\/+/, '');
    return keyPrefix ? `${trimSlashes(keyPrefix)}/${clean}` : clean;
  }

  return {
    async put(object: MediaObject): Promise<StoredMedia> {
      const key = fullKey(object.key);
      const result = await options.bucket.put(key, object.body, {
        httpMetadata: { contentType: object.contentType },
        customMetadata: object.customMetadata,
      });
      return {
        key: object.key,
        contentType: object.contentType,
        etag: result?.etag,
      };
    },

    async get(key: string) {
      const object = await options.bucket.get(fullKey(key));
      if (!object) return null;
      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType || 'application/octet-stream',
        bytes: object.size,
        etag: object.etag,
      };
    },

    publicUrl(key: string) {
      return joinUrl(options.publicBaseUrl, urlPathPrefix, key);
    },
  };
}

/** Strip a leading media path prefix from a request pathname → object key. */
export function mediaKeyFromPath(pathname: string, mediaRoutePrefix: string): string | null {
  const prefix = mediaRoutePrefix.endsWith('/')
    ? mediaRoutePrefix
    : `${mediaRoutePrefix}/`;
  if (!pathname.startsWith(prefix)) return null;
  const key = pathname.slice(prefix.length);
  if (!key || key.includes('..')) return null;
  try {
    const decoded = decodeURIComponent(key);
    if (!decoded || decoded.includes('..')) return null;
    return decoded;
  } catch {
    return null;
  }
}
