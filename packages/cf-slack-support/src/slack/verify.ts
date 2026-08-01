/**
 * Verify Slack request signature (v0).
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function verifySlackSignature(options: {
  signingSecret: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  /** Reject requests older than this many seconds. Default 60 * 5. */
  maxAgeSeconds?: number;
  nowSeconds?: number;
}): Promise<boolean> {
  const {
    signingSecret,
    signature,
    timestamp,
    rawBody,
    maxAgeSeconds = 60 * 5,
    nowSeconds = Math.floor(Date.now() / 1000),
  } = options;

  if (!signature || !timestamp) return false;
  if (!signature.startsWith('v0=')) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSeconds - ts) > maxAgeSeconds) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  const digest = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const expected = `v0=${digest}`;

  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}
