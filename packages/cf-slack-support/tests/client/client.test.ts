import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSupportClient } from '../../src/client';

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  url: string;
  protocols: string[];
  private listeners = new Map<string, Set<(ev: { data?: string }) => void>>();

  constructor(url: string, protocols: string[] = []) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open', {});
    });
  }

  addEventListener(type: string, fn: (ev: { data?: string }) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  send(_data: string) {
    // no-op
  }

  close() {
    this.readyState = 3;
    this.emit('close', {});
  }

  emit(type: string, ev: { data?: string }) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

describe('createSupportClient', () => {
  const OriginalWS = globalThis.WebSocket;
  const OriginalFetch = globalThis.fetch;

  beforeEach(() => {
    MockWebSocket.instances = [];
    // @ts-expect-error mock
    globalThis.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWS;
    globalThis.fetch = OriginalFetch;
  });

  it('connects with token in a WebSocket subprotocol, not the URL', async () => {
    const client = createSupportClient({
      baseUrl: 'https://support.example.com/support-api',
      getToken: () => 'tok_abc',
      autoReconnect: false,
      paths: { ws: '/ws' },
    });

    const statuses: string[] = [];
    client.on('status', (s) => statuses.push(s));

    const ready = new Promise((resolve) => {
      client.on('ready', resolve);
    });

    await client.connect();
    // Simulate server ready
    const ws = (client as unknown as { /* private */ }).constructor
      ? // access via status
        null
      : null;
    void ws;

    // Grab socket from module by sending after open
    await vi.waitFor(() => {
      expect(client.getStatus()).toBe('open');
    });

    // Manually dispatch a server frame through a second connect path:
    // use the fact that open already fired; inject via mock instance is hard,
    // so verify status machine and URL token instead by subclassing.
    expect(statuses).toContain('connecting');
    expect(statuses).toContain('open');
    expect(MockWebSocket.instances[0]?.url).not.toContain('tok_abc');
    expect(MockWebSocket.instances[0]?.protocols[0]).toBe('cf-slack-support.v1');
    expect(MockWebSocket.instances[0]?.protocols[1]).toMatch(/^cf-slack-support\.auth\./);
    void ready;
    client.disconnect();
    expect(client.getStatus()).toBe('closed');
  });

  it('uploadImage posts multipart with bearer', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        attachment: {
          id: 'u1/a.png',
          url: 'https://x/media/u1/a.png',
          contentType: 'image/png',
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createSupportClient({
      baseUrl: 'https://support.example.com',
      getToken: async () => 'secret',
      autoReconnect: false,
    });

    const att = await client.uploadImage(new Blob(['x'], { type: 'image/png' }), 'x.png');
    expect(att.id).toBe('u1/a.png');
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/uploads');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer secret',
    });
  });

  it('downloads protected attachments with bearer authentication', async () => {
    const fetchMock = vi.fn(async () => new Response('image', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = createSupportClient({
      baseUrl: 'https://support.example.com',
      getToken: () => 'secret',
    });

    await client.downloadAttachment('https://support.example.com/media/u1/a.png');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://support.example.com/media/u1/a.png',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret' } }),
    );
  });
});
