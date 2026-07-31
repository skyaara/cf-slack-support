import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { createMemoryMediaStore, mediaKeyFromPath } from '../src/index';

describe('media store + path helper', () => {
  it('stores and retrieves objects', async () => {
    const store = createMemoryMediaStore('https://cdn.test');
    const put = await store.put({
      key: 'u1/a.png',
      body: new TextEncoder().encode('png-bytes'),
      contentType: 'image/png',
    });
    expect(put.key).toBe('u1/a.png');
    const got = await store.get('u1/a.png');
    expect(got?.contentType).toBe('image/png');
    expect(store.publicUrl('u1/a.png')).toBe('https://cdn.test/media/u1/a.png');
  });

  it('mediaKeyFromPath rejects traversal (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (suffix) => {
        const path = `/media/${suffix}`;
        const key = mediaKeyFromPath(path, '/media');
        if (suffix.includes('..')) {
          expect(key).toBeNull();
        } else if (!suffix || suffix.startsWith('/')) {
          // empty after prefix
          if (!suffix) expect(key).toBeNull();
        }
      }),
      { numRuns: 50 },
    );

    expect(mediaKeyFromPath('/media/a/b.png', '/media')).toBe('a/b.png');
    expect(mediaKeyFromPath('/media/../secret', '/media')).toBeNull();
    expect(mediaKeyFromPath('/other/a', '/media')).toBeNull();
  });
});
