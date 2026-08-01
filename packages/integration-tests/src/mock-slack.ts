/**
 * Install a global fetch mock for Slack Web API used by the DO in tests.
 * Returns a controller to inspect calls and restore fetch.
 */
export type SlackMockCall = {
  url: string;
  method?: string;
  body?: string;
};

export function installSlackFetchMock(options?: {
  channelId?: string;
  channelName?: string;
  postTs?: () => string;
}) {
  const channelId = options?.channelId ?? 'C_TEST';
  const channelName = options?.channelName ?? 'support-user-1';
  let postSeq = 1000;
  const postTs =
    options?.postTs ??
    (() => {
      postSeq += 1;
      return `${postSeq}.000100`;
    });

  const calls: SlackMockCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body });

    if (url.includes('slack.com/api/conversations.create')) {
      return Response.json({ ok: true, channel: { id: channelId, name: channelName } });
    }
    if (url.includes('slack.com/api/conversations.info')) {
      return Response.json({
        ok: true,
        channel: { id: channelId, name: channelName, is_archived: false },
      });
    }
    if (url.includes('slack.com/api/conversations.setTopic')) {
      return Response.json({ ok: true });
    }
    if (url.includes('slack.com/api/conversations.invite')) {
      return Response.json({ ok: true });
    }
    if (url.includes('slack.com/api/conversations.rename')) {
      return Response.json({ ok: true, channel: { id: channelId, name: channelName } });
    }
    if (url.includes('slack.com/api/chat.postMessage')) {
      const ts = postTs();
      return Response.json({ ok: true, channel: channelId, ts });
    }
    if (url.includes('slack.com/api/users.info')) {
      return Response.json({
        ok: true,
        user: {
          name: 'sam',
          real_name: 'Sam Staff',
          profile: { display_name: 'Sam', real_name: 'Sam Staff' },
        },
      });
    }
    if (url.includes('slack.com/api/auth.test')) {
      return Response.json({ ok: true, user_id: 'U_BOT' });
    }

    // Fall through for non-Slack (R2, etc.) — miniflare handles these.
    return original(input as never, init);
  }) as typeof fetch;

  return {
    calls,
    channelId,
    restore() {
      globalThis.fetch = original;
    },
  };
}
