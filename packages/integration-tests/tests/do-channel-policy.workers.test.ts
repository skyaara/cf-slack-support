import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mintSupportBearerToken,
  mediaNamespaceForCustomer,
  type ChannelPolicyMode,
} from 'cf-slack-support';
import worker from '../src/worker';
import { installSlackFetchMock } from '../src/mock-slack';

type TestEnv = typeof env & {
  SUPPORT_CHANNEL_POLICY?: string;
  CUSTOMER_SUPPORT: DurableObjectNamespace;
  SUPPORT_INDEX: KVNamespace;
  SUPPORT_AUTH_SECRET: string;
  SUPPORT_BUCKET: R2Bucket;
};

const testEnv = env as TestEnv;

async function authHeader(customerKey = 'user_1') {
  const token = await mintSupportBearerToken({
    secret: testEnv.SUPPORT_AUTH_SECRET,
    customerKey,
  });
  return `Bearer ${token}`;
}

function websocketAuthProtocol(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `cf-slack-support.v1, cf-slack-support.auth.${encoded}`;
}

async function ensureCustomer(
  customerKey: string,
  channelId: string,
  channelPolicy?: ChannelPolicyMode,
) {
  const id = testEnv.CUSTOMER_SUPPORT.idFromName(customerKey);
  const stub = testEnv.CUSTOMER_SUPPORT.get(id);
  const res = await stub.fetch('https://do/ensure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerKey,
      displayName: 'Test User',
      // Per-customer override (also useful in multi-tenant apps)
      meta: channelPolicy ? { channelPolicy } : undefined,
    }),
  });
  expect(res.status).toBe(200);
  await testEnv.SUPPORT_INDEX.put(`channel:${channelId}`, customerKey);
  return stub;
}

async function postSlackEvent(event: Record<string, unknown>) {
  // Bypass signature by calling DO directly (Worker signature is tested elsewhere).
  const channelId = (event.channel as string) || (event.item as { channel?: string })?.channel;
  const customerKey = channelId
    ? await testEnv.SUPPORT_INDEX.get(`channel:${channelId}`)
    : null;
  if (!customerKey) throw new Error('missing channel mapping');
  const stub = testEnv.CUSTOMER_SUPPORT.get(testEnv.CUSTOMER_SUPPORT.idFromName(customerKey));
  return stub.fetch('https://do/slack/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
}

async function listConversations(customerKey: string) {
  const stub = testEnv.CUSTOMER_SUPPORT.get(testEnv.CUSTOMER_SUPPORT.idFromName(customerKey));
  const res = await stub.fetch('https://do/conversations');
  return res.json() as Promise<{ conversations: Array<{ id: string; slackThreadTs: string | null }> }>;
}

describe('Durable Object + channelPolicy', () => {
  let slack: ReturnType<typeof installSlackFetchMock>;

  beforeEach(() => {
    slack = installSlackFetchMock({ channelId: 'C_POLICY' });
  });

  afterEach(() => {
    slack.restore();
  });

  it('ensure creates channel via mocked Slack and lists empty conversations', async () => {
    await ensureCustomer('user_do_1', slack.channelId);
    const list = await listConversations('user_do_1');
    expect(list.conversations).toEqual([]);
    expect(slack.calls.some((c) => c.url.includes('conversations.create'))).toBe(true);
  });

  it('bidirectional: top-level staff message starts a conversation', async () => {
    await ensureCustomer('user_bi', slack.channelId, 'bidirectional');

    const res = await postSlackEvent({
      type: 'message',
      channel: slack.channelId,
      user: 'U_STAFF',
      text: 'Hello from staff channel root',
      ts: '2000.0001',
    });
    expect(res.status).toBe(200);

    const list = await listConversations('user_bi');
    expect(list.conversations.length).toBe(1);
    expect(list.conversations[0]?.slackThreadTs).toBe('2000.0001');
  });

  it('drops Slack messages from users outside the staff allowlist', async () => {
    await ensureCustomer('user_untrusted', slack.channelId, 'bidirectional');
    const res = await postSlackEvent({
      type: 'message',
      channel: slack.channelId,
      user: 'U_NOT_STAFF',
      text: 'I am not support',
      ts: '2000.0099',
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ ignored: 'unauthorized_actor' });
    expect((await listConversations('user_untrusted')).conversations).toEqual([]);
  });

  it('threads_only: top-level staff message is dropped', async () => {
    await ensureCustomer('user_to', slack.channelId, 'threads_only');

    await postSlackEvent({
      type: 'message',
      channel: slack.channelId,
      user: 'U_STAFF',
      text: 'Should not reach customer',
      ts: '3000.0001',
    });

    const list = await listConversations('user_to');
    expect(list.conversations.length).toBe(0);
  });

  it('threads_only: thread reply delivers and creates conversation', async () => {
    await ensureCustomer('user_to2', slack.channelId, 'threads_only');

    // Parent may be customer-originated (ts used as thread root) — staff replies in-thread.
    await postSlackEvent({
      type: 'message',
      channel: slack.channelId,
      user: 'U_STAFF',
      text: 'Staff reply in thread',
      ts: '3000.0002',
      thread_ts: '3000.0001',
    });

    const list = await listConversations('user_to2');
    expect(list.conversations.length).toBe(1);
    expect(list.conversations[0]?.slackThreadTs).toBe('3000.0001');
  });

  it('staff_main_customer_threads: top-level dropped, thread kept', async () => {
    await ensureCustomer('user_sm', slack.channelId, 'staff_main_customer_threads');

    await postSlackEvent({
      type: 'message',
      channel: slack.channelId,
      user: 'U_STAFF',
      text: 'staff watercooler',
      ts: '4000.0001',
    });
    expect((await listConversations('user_sm')).conversations.length).toBe(0);

    await postSlackEvent({
      type: 'message',
      channel: slack.channelId,
      user: 'U_STAFF',
      text: 'real customer reply',
      ts: '4000.0002',
      thread_ts: '4000.0099',
    });
    const list = await listConversations('user_sm');
    expect(list.conversations.length).toBe(1);
    expect(list.conversations[0]?.slackThreadTs).toBe('4000.0099');
  });

  it('thread reply attaches to existing conversation (no duplicate)', async () => {
    await ensureCustomer('user_dup', slack.channelId, 'bidirectional');

    await postSlackEvent({
      type: 'message',
      channel: slack.channelId,
      user: 'U_STAFF',
      text: 'parent',
      ts: '5000.0001',
    });
    await postSlackEvent({
      type: 'message',
      channel: slack.channelId,
      user: 'U_STAFF',
      text: 'child',
      ts: '5000.0002',
      thread_ts: '5000.0001',
    });

    const list = await listConversations('user_dup');
    expect(list.conversations.length).toBe(1);
  });

  it('HTTP conversations list requires auth and hits DO', async () => {
    await ensureCustomer('user_http', slack.channelId);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('https://example.com/conversations', {
        headers: { Authorization: await authHeader('user_http') },
      }),
      testEnv as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(Array.isArray(body.conversations)).toBe(true);
  });

  it('does not accept bearer credentials from HTTP query strings', async () => {
    const token = (await authHeader('user_http_query')).replace(/^Bearer\s+/, '');
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://example.com/conversations?token=${encodeURIComponent(token)}`),
      testEnv as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it('rejects cross-origin WebSocket upgrades', async () => {
    const token = (await authHeader('user_ws_origin')).replace(/^Bearer\s+/, '');
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('https://example.com/ws', {
        headers: {
          Upgrade: 'websocket',
          Origin: 'https://evil.example',
          'Sec-WebSocket-Protocol': websocketAuthProtocol(token),
        },
      }),
      testEnv as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });

  it('authenticates allowed WebSockets without putting the token in the URL', async () => {
    const token = (await authHeader('user_ws_protocol')).replace(/^Bearer\s+/, '');
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('https://example.com/ws', {
        headers: {
          Upgrade: 'websocket',
          Origin: 'https://app.test',
          'Sec-WebSocket-Protocol': websocketAuthProtocol(token),
        },
      }),
      testEnv as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(101);
    expect(res.headers.get('sec-websocket-protocol')).toBe('cf-slack-support.v1');
    res.webSocket?.accept();
    res.webSocket?.close(1000, 'test complete');
  });

  it('requires matching customer authentication for media reads', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const mediaKey = `${mediaNamespaceForCustomer('user_media')}/a.png`;
    await testEnv.SUPPORT_BUCKET.put(mediaKey, png, {
      httpMetadata: { contentType: 'image/png' },
    });

    const unauthorizedContext = createExecutionContext();
    const unauthorized = await worker.fetch(
      new Request(`https://example.com/media/${mediaKey}`),
      testEnv as never,
      unauthorizedContext,
    );
    await waitOnExecutionContext(unauthorizedContext);
    expect(unauthorized.status).toBe(401);

    const wrongContext = createExecutionContext();
    const wrongCustomer = await worker.fetch(
      new Request(`https://example.com/media/${mediaKey}`, {
        headers: { Authorization: await authHeader('someone_else') },
      }),
      testEnv as never,
      wrongContext,
    );
    await waitOnExecutionContext(wrongContext);
    expect(wrongCustomer.status).toBe(404);

    const allowedContext = createExecutionContext();
    const allowed = await worker.fetch(
      new Request(`https://example.com/media/${mediaKey}`, {
        headers: { Authorization: await authHeader('user_media') },
      }),
      testEnv as never,
      allowedContext,
    );
    await waitOnExecutionContext(allowedContext);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('private, no-store');
    expect(allowed.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('validates image signatures and stores uploads in isolated namespaces', async () => {
    const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const validContext = createExecutionContext();
    const valid = await worker.fetch(
      new Request('https://example.com/uploads', {
        method: 'POST',
        headers: {
          Authorization: await authHeader('a/b'),
          'Content-Type': 'image/png',
          'Content-Length': String(validPng.byteLength),
        },
        body: validPng,
      }),
      testEnv as never,
      validContext,
    );
    await waitOnExecutionContext(validContext);
    expect(valid.status).toBe(200);
    const uploaded = (await valid.json()) as { attachment: { id: string } };
    expect(uploaded.attachment.id.startsWith(`${mediaNamespaceForCustomer('a/b')}/`)).toBe(true);
    expect(uploaded.attachment.id.startsWith(`${mediaNamespaceForCustomer('a')}/`)).toBe(false);

    const spoofedContext = createExecutionContext();
    const spoofed = await worker.fetch(
      new Request('https://example.com/uploads', {
        method: 'POST',
        headers: {
          Authorization: await authHeader('spoofed_image'),
          'Content-Type': 'image/png',
          'Content-Length': '4',
        },
        body: new TextEncoder().encode('html'),
      }),
      testEnv as never,
      spoofedContext,
    );
    await waitOnExecutionContext(spoofedContext);
    expect(spoofed.status).toBe(415);
  });

  it('health reports default channelPolicy', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('https://example.com/health'),
      testEnv as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      channelPolicy: { mode: ChannelPolicyMode };
      channelPolicyDescription: string;
    };
    expect(body.channelPolicy.mode).toBe('bidirectional');
    expect(body.channelPolicyDescription.length).toBeGreaterThan(10);
  });
});
