import type { SupportIdentity } from '@cf-slack-support/protocol';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type BearerTokenAuthOptions = {
  /**
   * Resolve the shared secret from env, or return a static secret.
   * Token format: `base64url(payload).hex(hmac)`
   * payload JSON: `{ "customerKey": "...", "displayName"?: "...", "exp"?: number }`
   */
  getSecret: (env: unknown) => string | Promise<string>;
};

/**
 * Built-in authenticator: `Authorization: Bearer <payload>.<hmac>`.
 * Useful as a placeholder until you wire session cookies / Better Auth.
 */
export function createBearerTokenAuthenticator(
  options: BearerTokenAuthOptions,
): (request: Request, env: unknown) => Promise<SupportIdentity | null> {
  return async (request, env) => {
    const header = request.headers.get('Authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const token = match[1]!.trim();
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const payloadPart = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const secret = await options.getSecret(env);
    const expected = await hmacHex(secret, payloadPart);
    if (!timingSafeEqual(expected, sig)) return null;

    let payload: {
      customerKey?: string;
      displayName?: string;
      exp?: number;
      meta?: Record<string, unknown>;
    };
    try {
      payload = JSON.parse(atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/'))) as typeof payload;
    } catch {
      return null;
    }
    if (!payload.customerKey) return null;
    if (payload.exp != null && payload.exp * 1000 < Date.now()) return null;
    return {
      customerKey: payload.customerKey,
      displayName: payload.displayName,
      meta: payload.meta,
    };
  };
}

/** Mint a bearer token for local testing / server-side session exchange. */
export async function mintSupportBearerToken(input: {
  secret: string;
  customerKey: string;
  displayName?: string;
  /** Unix seconds. */
  exp?: number;
  meta?: Record<string, unknown>;
}): Promise<string> {
  const json = JSON.stringify({
    customerKey: input.customerKey,
    displayName: input.displayName,
    exp: input.exp,
    meta: input.meta,
  });
  const payloadPart = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sig = await hmacHex(input.secret, payloadPart);
  return `${payloadPart}.${sig}`;
}
