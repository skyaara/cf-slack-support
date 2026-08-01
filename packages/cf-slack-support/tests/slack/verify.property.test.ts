import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { slugifyChannelName, verifySlackSignature } from '../../src/slack';

async function sign(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const base = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  const digest = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `v0=${digest}`;
}

describe('verifySlackSignature', () => {
  it('accepts valid signatures (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 32 }),
        fc.string({ maxLength: 200 }),
        async (secret, rawBody) => {
          const timestamp = String(Math.floor(Date.now() / 1000));
          const signature = await sign(secret, timestamp, rawBody);
          const ok = await verifySlackSignature({
            signingSecret: secret,
            signature,
            timestamp,
            rawBody,
            nowSeconds: Number(timestamp),
          });
          expect(ok).toBe(true);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('rejects tampered body, bad prefix, stale timestamps', async () => {
    const secret = 'test-secret-key';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = '{"type":"event_callback"}';
    const signature = await sign(secret, timestamp, rawBody);

    expect(
      await verifySlackSignature({
        signingSecret: secret,
        signature,
        timestamp,
        rawBody: rawBody + 'x',
        nowSeconds: Number(timestamp),
      }),
    ).toBe(false);

    expect(
      await verifySlackSignature({
        signingSecret: secret,
        signature: signature.replace('v0=', 'v1='),
        timestamp,
        rawBody,
        nowSeconds: Number(timestamp),
      }),
    ).toBe(false);

    expect(
      await verifySlackSignature({
        signingSecret: secret,
        signature,
        timestamp,
        rawBody,
        nowSeconds: Number(timestamp) + 10_000,
      }),
    ).toBe(false);

    expect(
      await verifySlackSignature({
        signingSecret: secret,
        signature: null,
        timestamp,
        rawBody,
      }),
    ).toBe(false);
  });
});

describe('slugifyChannelName', () => {
  it('always returns slack-safe names (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (input) => {
        const slug = slugifyChannelName(input);
        expect(slug.length).toBeGreaterThan(0);
        expect(slug.length).toBeLessThanOrEqual(80);
        expect(slug).toMatch(/^[a-z0-9-_]+$/);
      }),
      { numRuns: 100 },
    );
  });

  it('collapses junk to support', () => {
    expect(slugifyChannelName('!!!')).toBe('support');
    expect(slugifyChannelName('Support User 123')).toBe('support-user-123');
  });
});
