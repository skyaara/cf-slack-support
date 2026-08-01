import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker';

describe('worker integration (miniflare pool)', () => {
  it('GET /health returns features and channelPolicy', async () => {
    const request = new Request('https://example.com/health');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      features: string[];
      channelPolicy: { mode: string };
      channelPolicyDescription: string;
    };
    expect(body.ok).toBe(true);
    expect(body.features).toContain('reactions');
    expect(body.features).toContain('lifecycle');
    expect(body.channelPolicy.mode).toBe('bidirectional');
    expect(body.channelPolicyDescription.length).toBeGreaterThan(10);
  });

  it('rejects slack events with bad signature', async () => {
    const request = new Request('https://example.com/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': 'v0=deadbeef',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({ type: 'event_callback', event: { type: 'message' } }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });
});
