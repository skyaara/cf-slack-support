import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { createBearerTokenAuthenticator, mintSupportBearerToken } from '../../src/auth';

describe('auth bearer', () => {
  it('round-trips identity (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 32, maxLength: 64 })
          .filter((value) => value.replace(/\s/g, '').length >= 32),
        fc.string({ minLength: 1, maxLength: 40 }).filter((value) => Boolean(value.trim())),
        fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
        async (secret, customerKey, displayName) => {
          const token = await mintSupportBearerToken({
            secret,
            customerKey,
            displayName,
            meta: { username: 'alice' },
          });
          const auth = createBearerTokenAuthenticator({ getSecret: () => secret });
          const identity = await auth(
            new Request('https://x.test', {
              headers: { Authorization: `Bearer ${token}` },
            }),
            {},
          );
          expect(identity).toEqual({
            customerKey: customerKey.trim(),
            displayName,
            meta: { username: 'alice' },
          });
        },
      ),
      { numRuns: 30 },
    );
  });

  it('rejects wrong secret and expired tokens', async () => {
    const secret = 'good-secret-with-at-least-32-characters';
    const token = await mintSupportBearerToken({
      secret,
      customerKey: 'u1',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const auth = createBearerTokenAuthenticator({ getSecret: () => secret });
    expect(
      await auth(
        new Request('https://x.test', { headers: { Authorization: `Bearer ${token}` } }),
        {},
      ),
    ).toBeNull();

    const live = await mintSupportBearerToken({ secret, customerKey: 'u1' });
    const bad = createBearerTokenAuthenticator({
      getSecret: () => 'different-secret-with-at-least-32-chars',
    });
    expect(
      await bad(
        new Request('https://x.test', { headers: { Authorization: `Bearer ${live}` } }),
        {},
      ),
    ).toBeNull();
  });

  it('rejects legacy non-expiring tokens unless explicitly enabled', async () => {
    const secret = 'good-secret-with-at-least-32-characters';
    const payload = btoa(JSON.stringify({ customerKey: 'u1' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const signature = [...new Uint8Array(mac)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const request = new Request('https://x.test', {
      headers: { Authorization: `Bearer ${payload}.${signature}` },
    });

    expect(
      await createBearerTokenAuthenticator({ getSecret: () => secret })(request, {}),
    ).toBeNull();
    expect(
      await createBearerTokenAuthenticator({
        getSecret: () => secret,
        allowNonExpiringTokens: true,
      })(request, {}),
    ).toMatchObject({ customerKey: 'u1' });
  });
});
