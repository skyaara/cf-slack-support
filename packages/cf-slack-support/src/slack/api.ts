export type SlackApiError = {
  ok: false;
  error: string;
};

export type SlackChannel = {
  id: string;
  name: string;
};

export type SlackPostMessageResult = {
  ok: true;
  channel: string;
  ts: string;
  message?: { text?: string; ts?: string };
};

export type SlackUploadExternalResult = {
  ok: true;
  files: Array<{ id: string; title?: string; permalink?: string }>;
};

type SlackClientOptions = {
  botToken: string;
  fetch?: typeof fetch;
};

async function slackFetch<T>(
  method: string,
  options: SlackClientOptions,
  body?: Record<string, unknown>,
): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) {
    throw new Error(`Slack ${method} failed: ${(data as SlackApiError).error || res.status}`);
  }
  return data;
}

/** Slack Web API helpers used by the support bridge. */
export function createSlackClient(options: SlackClientOptions) {
  return {
    async createChannel(name: string, isPrivate: boolean): Promise<SlackChannel> {
      const data = await slackFetch<{ channel: SlackChannel }>('conversations.create', options, {
        name,
        is_private: isPrivate,
      });
      return data.channel;
    },

    /**
     * Returns channel metadata when the bot can see the channel.
     * Throws with Slack error string on failure (channel_not_found, not_in_channel, …).
     *
     * Note: conversations.info does not accept application/json bodies (Slack returns
     * invalid_arguments / "missing required field: channel"). Use form-urlencoded.
     */
    async getChannelInfo(channelId: string): Promise<SlackChannel & { isArchived?: boolean }> {
      const doFetch = options.fetch ?? fetch;
      const res = await doFetch('https://slack.com/api/conversations.info', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.botToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ channel: channelId }).toString(),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        channel?: SlackChannel & { is_archived?: boolean };
      };
      if (!data.ok || !data.channel) {
        throw new Error(
          `Slack conversations.info failed: ${data.error || res.status}`,
        );
      }
      return {
        id: data.channel.id,
        name: data.channel.name,
        isArchived: Boolean(data.channel.is_archived),
      };
    },

    async inviteUsers(channelId: string, userIds: string[]): Promise<void> {
      if (userIds.length === 0) return;
      const doFetch = options.fetch ?? fetch;
      const res = await doFetch('https://slack.com/api/conversations.invite', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: channelId,
          users: userIds.join(','),
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        errors?: Array<{ user?: string; error?: string }>;
      };
      if (data.ok) return;
      // Re-inviting is idempotent enough: treat pure already_in_channel as success.
      const errs = data.errors?.map((e) => e.error).filter(Boolean) ?? [];
      if (
        data.error === 'already_in_channel' ||
        (errs.length > 0 && errs.every((e) => e === 'already_in_channel'))
      ) {
        return;
      }
      throw new Error(`Slack conversations.invite failed: ${data.error || res.status}`);
    },

    async setTopic(channelId: string, topic: string): Promise<void> {
      await slackFetch('conversations.setTopic', options, {
        channel: channelId,
        topic,
      });
    },

    async renameChannel(channelId: string, name: string): Promise<SlackChannel> {
      const data = await slackFetch<{ channel: SlackChannel }>(
        'conversations.rename',
        options,
        { channel: channelId, name },
      );
      return data.channel;
    },

    async postMessage(input: {
      channel: string;
      text: string;
      threadTs?: string;
      blocks?: unknown[];
      /**
       * Requires `chat:write.customize`. Shows this as the message author name
       * instead of the bot's default display name (e.g. "Flickks Support").
       */
      username?: string;
      /** Optional avatar URL when using `username` customize. */
      iconUrl?: string;
    }): Promise<SlackPostMessageResult> {
      return slackFetch<SlackPostMessageResult>('chat.postMessage', options, {
        channel: input.channel,
        text: input.text,
        thread_ts: input.threadTs,
        blocks: input.blocks,
        unfurl_links: false,
        unfurl_media: true,
        ...(input.username
          ? {
              username: input.username,
              ...(input.iconUrl ? { icon_url: input.iconUrl } : {}),
            }
          : {}),
      });
    },

    /**
     * Upload a file into a channel/thread via the external upload flow
     * so images render natively in Slack.
     */
    async uploadFile(input: {
      channelId: string;
      threadTs?: string;
      filename: string;
      contentType: string;
      bytes: ArrayBuffer;
      title?: string;
      initialComment?: string;
    }): Promise<SlackUploadExternalResult> {
      const doFetch = options.fetch ?? fetch;
      const getUrl = await slackFetch<{
        upload_url: string;
        file_id: string;
      }>('files.getUploadURLExternal', options, {
        filename: input.filename,
        length: input.bytes.byteLength,
      });

      const putRes = await doFetch(getUrl.upload_url, {
        method: 'POST',
        headers: { 'Content-Type': input.contentType },
        body: input.bytes,
      });
      if (!putRes.ok) {
        throw new Error(`Slack file PUT failed: ${putRes.status}`);
      }

      return slackFetch<SlackUploadExternalResult>('files.completeUploadExternal', options, {
        files: [
          {
            id: getUrl.file_id,
            title: input.title || input.filename,
          },
        ],
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        initial_comment: input.initialComment,
      });
    },

    async downloadPrivateFile(urlPrivateDownload: string): Promise<{
      bytes: ArrayBuffer;
      contentType: string;
    }> {
      const doFetch = options.fetch ?? fetch;
      const res = await doFetch(urlPrivateDownload, {
        headers: { Authorization: `Bearer ${options.botToken}` },
      });
      if (!res.ok) {
        throw new Error(`Slack file download failed: ${res.status}`);
      }
      return {
        bytes: await res.arrayBuffer(),
        contentType: res.headers.get('content-type') || 'application/octet-stream',
      };
    },

    async authTest(): Promise<{ user_id: string; bot_id?: string }> {
      return slackFetch('auth.test', options);
    },

    /**
     * Resolve a human display name for a workspace member.
     * Requires `users:read`. Prefer real_name → display_name → name.
     */
    async getUserDisplayName(userId: string): Promise<string | null> {
      const id = userId.trim();
      if (!id) return null;
      const doFetch = options.fetch ?? fetch;
      // users.info expects form body (JSON often yields invalid_arguments).
      const res = await doFetch('https://slack.com/api/users.info', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.botToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ user: id }).toString(),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        user?: {
          name?: string;
          real_name?: string;
          profile?: {
            display_name?: string;
            real_name?: string;
          };
        };
      };
      if (!data.ok || !data.user) {
        throw new Error(`Slack users.info failed: ${data.error || res.status}`);
      }
      const profile = data.user.profile;
      const candidates = [
        profile?.display_name,
        profile?.real_name,
        data.user.real_name,
        data.user.name,
      ];
      for (const value of candidates) {
        const trimmed = value?.trim();
        if (trimmed) return trimmed;
      }
      return null;
    },
  };
}

export type SlackClient = ReturnType<typeof createSlackClient>;

/** Slack-safe channel name: lowercase, max 80, [a-z0-9-_]. */
export function slugifyChannelName(input: string, maxLen = 80): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const trimmed = slug.slice(0, maxLen).replace(/-$/, '');
  return trimmed || 'support';
}
