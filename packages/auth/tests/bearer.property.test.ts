import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { createBearerTokenAuthenticator, mintSupportBearerToken } from '../src/index';

describe('@cf-slack-support/auth bearer', () => {
  it('round-trips identity (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
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
            customerKey,
            displayName,
            meta: { username: 'alice' },
          });
        },
      ),
      { numRuns: 30 },
    );
  });

  it('rejects wrong secret and expired tokens', async () => {
    const secret = 'good-secret';
    const token = await mintSupportBearerToken({
      secret,
      customerKey: 'u1',
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const auth = createBearerTokenAuthenticator({ getSecret: () => secret });
    expect(
      await auth(
        new Request('https://x.test', { headers: { Authorization: `Bearer ${token}` } }),
        {},
      ),
    ).toBeNull();

    const live = await mintSupportBearerToken({ secret, customerKey: 'u1' });
    const bad = createBearerTokenAuthenticator({ getSecret: () => 'other' });
    expect(
      await bad(
        new Request('https://x.test', { headers: { Authorization: `Bearer ${live}` } }),
        {},
      ),
    ).toBeNull();
  });
});
