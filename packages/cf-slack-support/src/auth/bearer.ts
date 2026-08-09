import type { SupportIdentity } from '../protocol';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

const DEFAULT_TOKEN_TTL_SECONDS = 5 * 60;
const MAX_TOKEN_CHARACTERS = 16 * 1024;
const DEFAULT_MIN_SECRET_CHARACTERS = 32;

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function validIdentityPayload(value: unknown): value is {
  customerKey: string;
  displayName?: string;
  exp: number;
  meta?: Record<string, unknown>;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.customerKey !== 'string' ||
    !payload.customerKey.trim() ||
    payload.customerKey.length > 256 ||
    !Number.isSafeInteger(payload.exp) ||
    (payload.displayName !== undefined &&
      (typeof payload.displayName !== 'string' || payload.displayName.length > 200)) ||
    (payload.meta !== undefined &&
      (!payload.meta || typeof payload.meta !== 'object' || Array.isArray(payload.meta)))
  ) {
    return false;
  }
  return true;
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
  /** Minimum accepted shared-secret length. Default 32 characters. */
  minimumSecretLength?: number;
  /** Permit legacy tokens without `exp`. Disabled by default. */
  allowNonExpiringTokens?: boolean;
  /** Clock skew accepted around expiration. Default 30 seconds. */
  clockSkewSeconds?: number;
};

/**
 * Built-in authenticator: `Authorization: Bearer <payload>.<hmac>`.
 * Uses expiring tokens by default. Prefer exchanging your application session for
 * a short-lived support token instead of exposing a long-lived session credential.
 */
export function createBearerTokenAuthenticator(
  options: BearerTokenAuthOptions,
): (request: Request, env: unknown) => Promise<SupportIdentity | null> {
  return async (request, env) => {
    const header = request.headers.get('Authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const token = match[1]!.trim();
    if (!token || token.length > MAX_TOKEN_CHARACTERS) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const payloadPart = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const secret = await options.getSecret(env);
    const minimumSecretLength = options.minimumSecretLength ?? DEFAULT_MIN_SECRET_CHARACTERS;
    if (
      typeof secret !== 'string' ||
      secret.replace(/\s/g, '').length < minimumSecretLength
    ) {
      throw new Error(
        `Support bearer secret must contain at least ${minimumSecretLength} characters`,
      );
    }
    if (!/^[a-f0-9]{64}$/i.test(sig)) return null;
    const expected = await hmacHex(secret, payloadPart);
    if (!timingSafeEqual(expected, sig.toLowerCase())) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(base64UrlDecode(payloadPart));
    } catch {
      return null;
    }
    if (
      options.allowNonExpiringTokens &&
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).exp === undefined
    ) {
      (payload as Record<string, unknown>).exp = Number.MAX_SAFE_INTEGER;
    }
    if (!validIdentityPayload(payload)) return null;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const clockSkewSeconds = Math.max(0, options.clockSkewSeconds ?? 30);
    if (payload.exp < nowSeconds - clockSkewSeconds) return null;
    return {
      customerKey: payload.customerKey.trim(),
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
  /** Unix seconds. Defaults to five minutes from mint time. */
  exp?: number;
  /** Lifetime used when `exp` is omitted. Default 300 seconds. */
  ttlSeconds?: number;
  meta?: Record<string, unknown>;
}): Promise<string> {
  if (input.secret.replace(/\s/g, '').length < DEFAULT_MIN_SECRET_CHARACTERS) {
    throw new Error(
      `Support bearer secret must contain at least ${DEFAULT_MIN_SECRET_CHARACTERS} characters`,
    );
  }
  if (!input.customerKey.trim() || input.customerKey.length > 256) {
    throw new Error('Support customerKey must contain 1 to 256 characters');
  }
  const exp =
    input.exp ??
    Math.floor(Date.now() / 1000) + Math.max(1, input.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS);
  const json = JSON.stringify({
    customerKey: input.customerKey.trim(),
    displayName: input.displayName,
    exp,
    meta: input.meta,
  });
  const payloadPart = base64UrlEncode(json);
  const sig = await hmacHex(input.secret, payloadPart);
  return `${payloadPart}.${sig}`;
}
