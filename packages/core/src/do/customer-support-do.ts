import { DurableObject } from 'cloudflare:workers';
import type {
  ClientFrame,
  SupportAttachment,
  SupportConversation,
  SupportConversationStatus,
  SupportIdentity,
  SupportMessage,
  SlackSupportRuntime,
} from '@cf-slack-support/protocol';
import { DEFAULT_ALLOWED_MIME_TYPES, parseClientFrame } from '@cf-slack-support/protocol';
import { createSlackClient, slugifyChannelName } from '@cf-slack-support/slack';
import type {
  ConversationRow,
  FeatureHost,
  MessageRow,
  SlackSupportOptions,
  SupportFeature,
} from '../feature/types';
import { applyCoreSchema } from './schema';
import {
  buildBlocks,
  clientSafeError,
  extensionForMime,
  isMissingChannelError,
  jsonAttachments,
  jsonReactions,
  newId,
  parseAttachments,
  parseReactions,
  titleFromFirstMessage,
} from './utils';

type WsAttachment = {
  customerKey: string;
  displayName?: string;
  meta?: Record<string, unknown>;
};

type SlackFile = {
  id: string;
  name?: string;
  mimetype?: string;
  url_private_download?: string;
  size?: number;
};

type SlackMessageEvent = {
  type: string;
  subtype?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: SlackFile[];
};

/**
 * Per-customer Durable Object: Slack channel + threads, SQLite history,
 * hibernatable WebSockets, and pluggable features.
 */
export type CustomerSupportDOConstructor<Env extends object = Record<string, unknown>> = {
  new (ctx: DurableObjectState, env: Env): DurableObject<Env>;
};

export function createCustomerSupportDOClass<Env extends object>(
  options: SlackSupportOptions<Env>,
): CustomerSupportDOConstructor<Env> {
  const features: SupportFeature<Env>[] = options.features ?? [];
  const featureNames = new Set(features.map((f) => f.name));

  const CustomerSupportDO = class CustomerSupportDO extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      this.ctx.blockConcurrencyWhile(async () => {
        applyCoreSchema(this.ctx.storage.sql as FeatureHost['sql'], features);
      });
    }

    private host(): FeatureHost {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      return {
        env: this.env,
        sql: this.ctx.storage.sql as FeatureHost['sql'],
        runtime: () => self.runtime(),
        slack: async () => {
          const runtime = await self.runtime();
          return createSlackClient({ botToken: runtime.slack.botToken });
        },
        metaGet: (k) => self.metaGet(k),
        metaSet: (k, v) => self.metaSet(k, v),
        metaDelete: (k) => self.metaDelete(k),
        identityFromMeta: () => self.identityFromMeta(),
        listConversations: () => self.listConversations(),
        getConversation: (id) => self.getConversation(id),
        getConversationByThread: (ts) => self.getConversationByThread(ts),
        insertConversation: (input) => self.insertConversation(input),
        setConversationStatus: (id, status, at) => self.setConversationStatus(id, status, at),
        insertMessage: (m) => self.insertMessage(m),
        findByClientId: (id) => self.findByClientId(id),
        findBySlackTs: (ts) => self.findBySlackTs(ts),
        messagesSince: (id, limit) => self.messagesSince(id, limit),
        rowToMessage: (row) => self.rowToMessage(row),
        broadcast: (frame, except) => self.broadcast(frame, except),
        send: (ws, frame) => self.send(ws, frame),
        ensureChannel: (id) => self.ensureChannel(id),
        postToSlack: (input) => self.postToSlack(input),
        resolveAttachments: (runtime, key, ids) => self.resolveAttachments(runtime, key, ids),
        newId,
        hasFeature: (name) => featureNames.has(name),
        resolveStaffDisplayName: (slack, userId) => self.resolveStaffDisplayName(slack, userId),
      };
    }

    private async runtime(): Promise<SlackSupportRuntime> {
      return options.getRuntime(this.env);
    }

    private metaGet(key: string): string | null {
      const row = this.ctx.storage.sql
        .exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)
        .toArray()[0];
      return row?.value ?? null;
    }

    private metaSet(key: string, value: string): void {
      this.ctx.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        value,
      );
    }

    private metaDelete(key: string): void {
      this.ctx.storage.sql.exec('DELETE FROM meta WHERE key = ?', key);
    }

    private clearChannelBinding(): void {
      this.metaDelete('slack_channel_id');
      this.metaDelete('slack_channel_name');
      this.metaDelete('slack_channel_topic');
    }

    private mapConversationRow(r: ConversationRow): SupportConversation {
      const status: SupportConversationStatus = r.status === 'closed' ? 'closed' : 'open';
      let conversation: SupportConversation = {
        id: r.id,
        title: r.title ?? null,
        slackThreadTs: r.slack_thread_ts ?? null,
        status,
        closedAt: status === 'closed' && typeof r.closed_at === 'number' ? r.closed_at : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
      for (const feature of features) {
        if (feature.enrichConversation) {
          conversation = feature.enrichConversation(conversation, r);
        }
      }
      return conversation;
    }

    private async resolveStaffDisplayName(
      slack: ReturnType<typeof createSlackClient>,
      userId: string,
    ): Promise<string> {
      const fallback =
        (await this.runtime()).staffDisplayNameFallback?.trim() || 'Support';
      const id = userId.trim();
      if (!id) return fallback;
      const cacheKey = `slack_user_name:${id}`;
      const cached = this.metaGet(cacheKey);
      if (cached?.trim()) return cached.trim();
      try {
        const name = await slack.getUserDisplayName(id);
        if (name?.trim()) {
          this.metaSet(cacheKey, name.trim());
          return name.trim();
        }
      } catch (err) {
        console.warn('[cf-slack-support] users.info failed', {
          userId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return fallback;
    }

    private listConversations(): SupportConversation[] {
      const rows = this.ctx.storage.sql
        .exec<ConversationRow>(
          `SELECT id, title, slack_thread_ts, status, closed_at, created_at, updated_at
           FROM conversations ORDER BY updated_at DESC`,
        )
        .toArray();
      return rows.map((r) => this.mapConversationRow(r));
    }

    private getConversation(id: string): SupportConversation | null {
      const r = this.ctx.storage.sql
        .exec<ConversationRow>(
          `SELECT id, title, slack_thread_ts, status, closed_at, created_at, updated_at
           FROM conversations WHERE id = ?`,
          id,
        )
        .toArray()[0];
      return r ? this.mapConversationRow(r) : null;
    }

    private getConversationByThread(threadTs: string): SupportConversation | null {
      const r = this.ctx.storage.sql
        .exec<ConversationRow>(
          `SELECT id, title, slack_thread_ts, status, closed_at, created_at, updated_at
           FROM conversations WHERE slack_thread_ts = ?`,
          threadTs,
        )
        .toArray()[0];
      return r ? this.mapConversationRow(r) : null;
    }

    private insertConversation(input: {
      id: string;
      title: string | null;
      slackThreadTs: string | null;
      createdAt: number;
      status?: SupportConversationStatus;
      closedAt?: number | null;
    }): SupportConversation {
      const status: SupportConversationStatus = input.status ?? 'open';
      const closedAt = status === 'closed' ? (input.closedAt ?? input.createdAt) : null;
      this.ctx.storage.sql.exec(
        `INSERT INTO conversations (
           id, title, slack_thread_ts, status, closed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.title,
        input.slackThreadTs,
        status,
        closedAt,
        input.createdAt,
        input.createdAt,
      );
      return this.mapConversationRow({
        id: input.id,
        title: input.title,
        slack_thread_ts: input.slackThreadTs,
        status,
        closed_at: closedAt,
        created_at: input.createdAt,
        updated_at: input.createdAt,
      });
    }

    private setConversationStatus(
      id: string,
      status: SupportConversationStatus,
      at: number,
    ): SupportConversation | null {
      const current = this.getConversation(id);
      if (!current) return null;
      const closedAt = status === 'closed' ? at : null;
      this.ctx.storage.sql.exec(
        `UPDATE conversations
         SET status = ?, closed_at = ?, updated_at = ?
         WHERE id = ?`,
        status,
        closedAt,
        at,
        id,
      );
      return {
        ...current,
        status,
        closedAt,
        updatedAt: at,
      };
    }

    private touchConversation(id: string, at: number, slackThreadTs?: string | null): void {
      if (slackThreadTs !== undefined) {
        this.ctx.storage.sql.exec(
          `UPDATE conversations SET updated_at = ?, slack_thread_ts = COALESCE(?, slack_thread_ts)
           WHERE id = ?`,
          at,
          slackThreadTs,
          id,
        );
      } else {
        this.ctx.storage.sql.exec(
          `UPDATE conversations SET updated_at = ? WHERE id = ?`,
          at,
          id,
        );
      }
    }

    private setConversationTitleIfEmpty(id: string, title: string): SupportConversation | null {
      const current = this.getConversation(id);
      if (!current || current.title?.trim()) return null;
      const trimmed = title.trim().slice(0, 80);
      if (!trimmed) return null;
      this.ctx.storage.sql.exec(`UPDATE conversations SET title = ? WHERE id = ?`, trimmed, id);
      return { ...current, title: trimmed };
    }

    private rowToMessage(r: MessageRow): SupportMessage {
      const role = r.author_role;
      const authorRole: SupportMessage['authorRole'] =
        role === 'customer' || role === 'staff' || role === 'system' ? role : 'system';
      let message: SupportMessage = {
        id: r.id,
        conversationId: r.conversation_id,
        body: r.body ?? null,
        attachments: parseAttachments(r.attachments_json ?? '[]'),
        authorRole,
        authorName: r.author_name?.trim() ? r.author_name.trim() : undefined,
        createdAt: r.created_at,
        clientId: r.client_id ?? undefined,
        slackTs: r.slack_ts ?? undefined,
      };
      // Core maps reactions when column present so data is not lost without feature
      // enrich; feature can further transform via enrichMessage.
      const reactions = parseReactions(r.reactions_json ?? '[]');
      if (reactions.length && featureNames.has('reactions')) {
        message.reactions = reactions;
      }
      for (const feature of features) {
        if (feature.enrichMessage) {
          message = feature.enrichMessage(message, r);
        }
      }
      return message;
    }

    private insertMessage(message: SupportMessage): SupportMessage {
      let slackTs = message.slackTs ?? null;
      if (slackTs && this.findBySlackTs(slackTs)) {
        console.warn('[cf-slack-support] slack_ts already stored; inserting without it', {
          messageId: message.id,
          slackTs,
        });
        slackTs = null;
      }

      const reactionsJson = jsonReactions(message.reactions ?? []);

      try {
        this.ctx.storage.sql.exec(
          `INSERT INTO messages (
            id, conversation_id, body, attachments_json, author_role, author_name,
            created_at, client_id, slack_ts, reactions_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          message.id,
          message.conversationId,
          message.body,
          jsonAttachments(message.attachments),
          message.authorRole,
          message.authorName ?? null,
          message.createdAt,
          message.clientId ?? null,
          slackTs,
          reactionsJson,
        );
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (slackTs && /UNIQUE constraint failed:\s*messages\.slack_ts/i.test(raw)) {
          this.ctx.storage.sql.exec(
            `INSERT INTO messages (
              id, conversation_id, body, attachments_json, author_role, author_name,
              created_at, client_id, slack_ts, reactions_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            message.id,
            message.conversationId,
            message.body,
            jsonAttachments(message.attachments),
            message.authorRole,
            message.authorName ?? null,
            message.createdAt,
            message.clientId ?? null,
            null,
            reactionsJson,
          );
          slackTs = null;
        } else {
          throw err;
        }
      }
      this.touchConversation(message.conversationId, message.createdAt);
      return {
        ...message,
        slackTs: slackTs ?? undefined,
        reactions: message.reactions?.length ? message.reactions : undefined,
      };
    }

    private findByClientId(clientId: string): SupportMessage | null {
      const r = this.ctx.storage.sql
        .exec<MessageRow>(`SELECT * FROM messages WHERE client_id = ?`, clientId)
        .toArray()[0];
      return r ? this.rowToMessage(r) : null;
    }

    private findBySlackTs(slackTs: string): SupportMessage | null {
      const r = this.ctx.storage.sql
        .exec<MessageRow>(`SELECT * FROM messages WHERE slack_ts = ?`, slackTs)
        .toArray()[0];
      return r ? this.rowToMessage(r) : null;
    }

    private messagesSince(lastSeenId: string | undefined, limit = 200): SupportMessage[] {
      if (!lastSeenId) {
        return this.ctx.storage.sql
          .exec<MessageRow>(
            `SELECT * FROM messages ORDER BY created_at ASC LIMIT ?`,
            limit,
          )
          .toArray()
          .map((r) => this.rowToMessage(r));
      }
      const anchor = this.ctx.storage.sql
        .exec<{ created_at: number }>(
          `SELECT created_at FROM messages WHERE id = ?`,
          lastSeenId,
        )
        .toArray()[0];
      if (!anchor) {
        return this.ctx.storage.sql
          .exec<MessageRow>(
            `SELECT * FROM messages ORDER BY created_at ASC LIMIT ?`,
            limit,
          )
          .toArray()
          .map((r) => this.rowToMessage(r));
      }
      return this.ctx.storage.sql
        .exec<MessageRow>(
          `SELECT * FROM messages WHERE created_at > ? ORDER BY created_at ASC LIMIT ?`,
          anchor.created_at,
          limit,
        )
        .toArray()
        .map((r) => this.rowToMessage(r));
    }

    private broadcast(frame: unknown, except?: WebSocket): void {
      const payload = JSON.stringify(frame);
      for (const ws of this.ctx.getWebSockets()) {
        if (except && ws === except) continue;
        try {
          ws.send(payload);
        } catch {
          // ignore broken sockets
        }
      }
    }

    private send(ws: WebSocket, frame: unknown): void {
      ws.send(JSON.stringify(frame));
    }

    private identityFromMeta(): SupportIdentity {
      const customerKey = this.metaGet('customer_key') || '';
      const displayName = this.metaGet('display_name') || undefined;
      let meta: Record<string, unknown> | undefined;
      const raw = this.metaGet('identity_meta');
      if (raw) {
        try {
          meta = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          meta = undefined;
        }
      }
      return { customerKey, displayName, meta };
    }

    private persistIdentity(identity: SupportIdentity): void {
      this.metaSet('customer_key', identity.customerKey);
      if (identity.displayName) this.metaSet('display_name', identity.displayName);
      if (identity.meta && Object.keys(identity.meta).length > 0) {
        this.metaSet('identity_meta', JSON.stringify(identity.meta));
      }
    }

    async ensureChannel(
      identity: SupportIdentity,
    ): Promise<{ channelId: string; created: boolean }> {
      this.persistIdentity(identity);
      const existing = this.metaGet('slack_channel_id');
      const runtime = await this.runtime();
      const slack = createSlackClient({ botToken: runtime.slack.botToken });

      if (existing) {
        try {
          const info = await slack.getChannelInfo(existing);
          if (info.isArchived) {
            throw new Error('Slack conversations.info failed: is_archived');
          }
          if (info.name) this.metaSet('slack_channel_name', info.name);
        } catch (err) {
          if (!isMissingChannelError(err)) throw err;
          console.warn('[cf-slack-support] stored channel missing; recreating', {
            customerKey: identity.customerKey,
            channelId: existing,
            error: err instanceof Error ? err.message : String(err),
          });
          this.clearChannelBinding();
        }
      }

      const bound = this.metaGet('slack_channel_id');
      if (bound) {
        await runtime.channelIndex.setCustomerKey(bound, identity.customerKey);
        await this.inviteStaff(slack, bound, runtime.staffUserIds, identity.customerKey);
        await this.maybeRenameChannel(slack, bound, identity, runtime);
        await this.maybeSetTopic(slack, bound, identity);
        return { channelId: bound, created: false };
      }

      const preferred = slugifyChannelName(runtime.channelName(identity));
      let channel: { id: string; name: string };
      try {
        channel = await slack.createChannel(preferred, runtime.channelIsPrivate);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('name_taken')) throw err;
        const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
        const fallback = slugifyChannelName(`${preferred}-${suffix}`);
        channel = await slack.createChannel(fallback, runtime.channelIsPrivate);
      }
      this.metaSet('slack_channel_id', channel.id);
      this.metaSet('slack_channel_name', channel.name);
      await runtime.channelIndex.setCustomerKey(channel.id, identity.customerKey);

      try {
        const topic = this.channelTopic(identity);
        await slack.setTopic(channel.id, topic);
        this.metaSet('slack_channel_topic', topic);
      } catch (err) {
        console.warn('[cf-slack-support] setTopic failed', {
          channelId: channel.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await this.inviteStaff(slack, channel.id, runtime.staffUserIds, identity.customerKey);
      await runtime.onChannelCreated?.({
        customerKey: identity.customerKey,
        channelId: channel.id,
        channelName: channel.name,
        identity,
      });

      return { channelId: channel.id, created: true };
    }

    private async inviteStaff(
      slack: ReturnType<typeof createSlackClient>,
      channelId: string,
      staffUserIds: string[],
      customerKey: string,
    ): Promise<void> {
      if (!staffUserIds.length) return;
      try {
        await slack.inviteUsers(channelId, staffUserIds);
      } catch (err) {
        console.warn('[cf-slack-support] inviteUsers failed', {
          channelId,
          customerKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    private customerLabel(identity: SupportIdentity): string {
      const username =
        typeof identity.meta?.username === 'string' ? identity.meta.username.trim() : '';
      if (username) return `@${username}`;
      if (identity.displayName?.trim()) return identity.displayName.trim();
      return identity.customerKey;
    }

    private channelTopic(identity: SupportIdentity): string {
      const label = this.customerLabel(identity);
      if (label === identity.customerKey) {
        return `Support for ${identity.customerKey}`;
      }
      return `Support for ${label} · user ${identity.customerKey}`;
    }

    private async maybeSetTopic(
      slack: ReturnType<typeof createSlackClient>,
      channelId: string,
      identity: SupportIdentity,
    ): Promise<void> {
      const desired = this.channelTopic(identity);
      const current = this.metaGet('slack_channel_topic');
      if (current === desired) return;
      try {
        await slack.setTopic(channelId, desired);
        this.metaSet('slack_channel_topic', desired);
      } catch {
        // best-effort
      }
    }

    private async maybeRenameChannel(
      slack: ReturnType<typeof createSlackClient>,
      channelId: string,
      identity: SupportIdentity,
      runtime: SlackSupportRuntime,
    ): Promise<void> {
      const desired = slugifyChannelName(runtime.channelName(identity));
      const current = this.metaGet('slack_channel_name');
      if (current === desired) return;
      try {
        await slack.renameChannel(channelId, desired);
        this.metaSet('slack_channel_name', desired);
      } catch {
        // best-effort
      }
    }

    private async resolveAttachments(
      runtime: SlackSupportRuntime,
      customerKey: string,
      attachmentIds: string[] | undefined,
    ): Promise<SupportAttachment[]> {
      if (!attachmentIds?.length) return [];
      if (!runtime.media?.store) {
        throw new Error('feature_not_enabled: media store is not configured');
      }
      const out: SupportAttachment[] = [];
      for (const id of attachmentIds) {
        if (!id.startsWith(`${customerKey}/`)) {
          throw new Error(`Invalid attachment id for customer: ${id}`);
        }
        const stored = await runtime.media.store.get(id);
        if (!stored) throw new Error(`Unknown attachment: ${id}`);
        out.push({
          id,
          url: runtime.media.store.publicUrl(id),
          contentType: stored.contentType,
          bytes: stored.bytes,
        });
      }
      return out;
    }

    private slackPostAs(identity: SupportIdentity): { username?: string; iconUrl?: string } {
      const username =
        typeof identity.meta?.username === 'string' ? identity.meta.username.trim() : '';
      const iconUrl =
        typeof identity.meta?.profilePhotoUrl === 'string'
          ? identity.meta.profilePhotoUrl.trim()
          : typeof identity.meta?.profile_photo_url === 'string'
            ? identity.meta.profile_photo_url.trim()
            : '';
      const display = username || identity.displayName?.trim() || undefined;
      return {
        username: display || undefined,
        iconUrl: iconUrl || undefined,
      };
    }

    private async postToSlack(input: {
      runtime: SlackSupportRuntime;
      channelId: string;
      conversation: SupportConversation;
      message: SupportMessage;
    }): Promise<{ slackTs: string; threadTs: string }> {
      const slack = createSlackClient({ botToken: input.runtime.slack.botToken });
      let threadTs = input.conversation.slackThreadTs;
      const postAs = this.slackPostAs(this.identityFromMeta());

      const imageAttachments = input.message.attachments.filter((a) =>
        a.contentType.startsWith('image/'),
      );
      const otherAttachments = input.message.attachments.filter(
        (a) => !a.contentType.startsWith('image/'),
      );
      const textParts: string[] = [];
      if (input.message.body) textParts.push(input.message.body);
      for (const a of otherAttachments) {
        textParts.push(a.url);
      }
      const text =
        textParts.join('\n') ||
        (imageAttachments.length
          ? `${postAs.username || input.message.authorName || 'Customer'} sent an image`
          : `${postAs.username || input.message.authorName || 'Customer'} sent an attachment`);

      let channelId = input.channelId;
      let isParent = !threadTs;
      const postOnce = async () =>
        slack.postMessage({
          channel: channelId,
          text:
            isParent && input.conversation.title
              ? `*${input.conversation.title}*\n${text}`
              : text,
          threadTs: isParent ? undefined : threadTs ?? undefined,
          blocks: buildBlocks(
            input.message,
            isParent ? input.conversation.title : null,
            { asCustomUsername: Boolean(postAs.username) },
          ),
          username: postAs.username,
          iconUrl: postAs.iconUrl,
        });

      let posted: Awaited<ReturnType<typeof slack.postMessage>>;
      try {
        posted = await postOnce();
      } catch (err) {
        if (!isMissingChannelError(err)) throw err;
        this.clearChannelBinding();
        threadTs = null;
        isParent = true;
        const recovered = await this.ensureChannel(this.identityFromMeta());
        channelId = recovered.channelId;
        posted = await postOnce();
      }

      const slackTs = posted.ts;
      if (isParent) {
        threadTs = posted.ts;
        this.touchConversation(input.conversation.id, Date.now(), threadTs);
      }
      return { slackTs, threadTs: threadTs! };
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/websocket') {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('Expected WebSocket', { status: 400 });
        }
        const customerKey = url.searchParams.get('customerKey');
        if (!customerKey) return new Response('Missing customerKey', { status: 400 });
        const displayName = url.searchParams.get('displayName') || undefined;
        let meta: Record<string, unknown> | undefined;
        const rawMeta = url.searchParams.get('meta');
        if (rawMeta) {
          try {
            meta = JSON.parse(rawMeta) as Record<string, unknown>;
          } catch {
            meta = undefined;
          }
        }

        this.persistIdentity({ customerKey, displayName, meta });
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ customerKey, displayName, meta } satisfies WsAttachment);
        return new Response(null, { status: 101, webSocket: client });
      }

      if (path === '/slack/event' && request.method === 'POST') {
        const event = (await request.json()) as { type?: string };
        const host = this.host();
        for (const feature of features) {
          if (!feature.onSlackEvent) continue;
          const result = await feature.onSlackEvent(host, event);
          if (result === 'handled') {
            return Response.json({ ok: true });
          }
        }
        await this.handleSlackEvent(event as SlackMessageEvent);
        return Response.json({ ok: true });
      }

      if (path === '/conversations' && request.method === 'GET') {
        return Response.json({ conversations: this.listConversations() });
      }

      if (path === '/ensure' && request.method === 'POST') {
        const identity = (await request.json()) as SupportIdentity;
        const result = await this.ensureChannel(identity);
        return Response.json(result);
      }

      return new Response('Not found', { status: 404 });
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
      const frame = parseClientFrame(raw);
      if (!frame) {
        this.send(ws, { type: 'error', code: 'bad_frame', message: 'Invalid frame' });
        return;
      }

      try {
        await this.handleClientFrame(ws, frame);
      } catch (err) {
        const errRaw = err instanceof Error ? err.message : String(err);
        console.error('[cf-slack-support] webSocketMessage handler_error', {
          frameType: frame.type,
          message: errRaw,
        });
        const clientId =
          frame.type === 'send' ||
          frame.type === 'open_conversation' ||
          frame.type === 'close_conversation' ||
          frame.type === 'reopen_conversation'
            ? frame.clientId
            : undefined;
        const safe = clientSafeError(errRaw, frame.type);
        this.send(ws, {
          type: 'error',
          code: safe.code,
          message: safe.message,
          clientId,
        });
      }
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
      ws.close(code, reason);
    }

    async webSocketError(ws: WebSocket): Promise<void> {
      ws.close(1011, 'WebSocket error');
    }

    private async handleClientFrame(ws: WebSocket, frame: ClientFrame): Promise<void> {
      const attachment = (ws.deserializeAttachment() || {}) as WsAttachment;
      const customerKey = attachment.customerKey || this.metaGet('customer_key');
      if (!customerKey) {
        this.send(ws, { type: 'error', code: 'unauthorized', message: 'Missing customer' });
        return;
      }

      if (frame.type === 'ping') {
        this.send(ws, { type: 'pong' });
        return;
      }

      if (frame.type === 'hello') {
        const channelId = this.metaGet('slack_channel_id');
        this.send(ws, {
          type: 'ready',
          customerKey,
          channelReady: Boolean(channelId),
          conversations: this.listConversations(),
        });
        const missed = this.messagesSince(frame.lastSeenId);
        if (missed.length) {
          this.send(ws, { type: 'messages', messages: missed });
        }
        return;
      }

      // Feature-owned frames (close/reopen, …) run before core send/open.
      const host = this.host();
      for (const feature of features) {
        if (!feature.onClientFrame) continue;
        const result = await feature.onClientFrame(host, ws, frame, customerKey);
        if (result === 'handled') return;
      }

      if (frame.type === 'close_conversation' || frame.type === 'reopen_conversation') {
        this.send(ws, {
          type: 'error',
          code: 'feature_not_enabled',
          message:
            frame.type === 'close_conversation'
              ? 'Conversation lifecycle is not enabled. Install @cf-slack-support/lifecycle.'
              : 'Conversation lifecycle is not enabled. Install @cf-slack-support/lifecycle.',
          clientId: frame.clientId,
        });
        return;
      }

      const runtime = await this.runtime();
      const liveIdentity: SupportIdentity = {
        customerKey,
        displayName: attachment.displayName || this.metaGet('display_name') || undefined,
        meta: attachment.meta || this.identityFromMeta().meta,
      };
      const { channelId } = await this.ensureChannel(liveIdentity);

      if (frame.type === 'open_conversation') {
        const conversation = this.insertConversation({
          id: newId('conv'),
          title: frame.title?.trim() || null,
          slackThreadTs: null,
          createdAt: Date.now(),
        });
        this.send(ws, { type: 'conversation', conversation });
        this.send(ws, { type: 'ack', clientId: frame.clientId, messageId: conversation.id });
        return;
      }

      if (frame.type === 'send') {
        const existing = this.findByClientId(frame.clientId);
        if (existing) {
          this.send(ws, { type: 'ack', clientId: frame.clientId, messageId: existing.id });
          this.send(ws, { type: 'message', message: existing });
          return;
        }

        let conversation = frame.conversationId
          ? this.getConversation(frame.conversationId)
          : null;
        if (!conversation) {
          conversation = this.insertConversation({
            id: newId('conv'),
            title: null,
            slackThreadTs: null,
            createdAt: Date.now(),
          });
          this.broadcast({ type: 'conversation', conversation });
        }

        if (conversation.status === 'closed') {
          this.send(ws, {
            type: 'error',
            code: 'conversation_closed',
            message: 'This request is closed. Start a new request to continue.',
            clientId: frame.clientId,
          });
          return;
        }

        const attachments = await this.resolveAttachments(
          runtime,
          customerKey,
          frame.attachmentIds,
        );
        const body = frame.body?.trim() || null;
        if (!body && attachments.length === 0) {
          this.send(ws, {
            type: 'error',
            code: 'empty_message',
            message: 'Message requires body or attachments',
            clientId: frame.clientId,
          });
          return;
        }

        const identity = this.identityFromMeta();
        const message: SupportMessage = {
          id: newId('msg'),
          conversationId: conversation.id,
          body,
          attachments,
          authorRole: 'customer',
          authorName:
            this.customerLabel(identity) ||
            attachment.displayName ||
            this.metaGet('display_name') ||
            undefined,
          createdAt: Date.now(),
          clientId: frame.clientId,
        };

        const { slackTs, threadTs } = await this.postToSlack({
          runtime,
          channelId,
          conversation,
          message,
        });
        message.slackTs = slackTs;
        conversation = {
          ...conversation,
          slackThreadTs: threadTs,
          updatedAt: message.createdAt,
        };

        const stored = this.insertMessage(message);
        const titled = this.setConversationTitleIfEmpty(
          conversation.id,
          titleFromFirstMessage(body, attachments.length),
        );
        if (titled) {
          conversation = {
            ...titled,
            slackThreadTs: threadTs ?? conversation.slackThreadTs,
            updatedAt: stored.createdAt,
          };
          this.broadcast({ type: 'conversation', conversation });
        }

        await runtime.onMessage?.({
          customerKey,
          message: stored,
          conversation,
          direction: 'to_slack',
        });

        this.send(ws, { type: 'ack', clientId: frame.clientId, messageId: stored.id });
        this.broadcast({ type: 'message', message: stored });
      }
    }

    private async handleSlackEvent(event: SlackMessageEvent): Promise<void> {
      if (event.type !== 'message') return;
      const allowedSubtypes = new Set(['file_share', 'thread_broadcast']);
      if (event.subtype && !allowedSubtypes.has(event.subtype)) {
        return;
      }

      const runtime = await this.runtime();
      if (event.bot_id && !event.user) return;
      if (runtime.slack.botUserId && event.user === runtime.slack.botUserId) return;
      if (event.bot_id && runtime.slack.botUserId && event.bot_id === runtime.slack.botUserId) {
        return;
      }

      if (!event.ts || !event.channel) return;
      if (this.findBySlackTs(event.ts)) return;

      const customerKey = this.metaGet('customer_key');
      if (!customerKey) return;

      const threadRoot = event.thread_ts || event.ts;
      let conversation = this.getConversationByThread(threadRoot);
      if (!conversation) {
        conversation = this.insertConversation({
          id: newId('conv'),
          title: null,
          slackThreadTs: threadRoot,
          createdAt: Date.now(),
        });
        this.broadcast({ type: 'conversation', conversation });
      }

      const slack = createSlackClient({ botToken: runtime.slack.botToken });
      const attachments: SupportAttachment[] = [];
      if (runtime.media?.store) {
        for (const file of event.files || []) {
          if (!file.url_private_download) continue;
          const allowed =
            runtime.media.allowedMimeTypes ?? [...DEFAULT_ALLOWED_MIME_TYPES];
          if (file.mimetype && !allowed.includes(file.mimetype)) continue;
          try {
            const downloaded = await slack.downloadPrivateFile(file.url_private_download);
            const ext = extensionForMime(downloaded.contentType) || 'bin';
            const key = `${customerKey}/${crypto.randomUUID()}.${ext}`;
            await runtime.media.store.put({
              key,
              body: downloaded.bytes,
              contentType: downloaded.contentType,
              customMetadata: { source: 'slack', slack_file_id: file.id },
            });
            attachments.push({
              id: key,
              url: runtime.media.store.publicUrl(key),
              contentType: downloaded.contentType,
              filename: file.name,
              bytes: file.size,
            });
          } catch (err) {
            console.warn('[cf-slack-support] slack file download failed', {
              fileId: file.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const body = (event.text || '').trim() || null;
      if (!body && attachments.length === 0) return;

      const authorName = event.user
        ? await this.resolveStaffDisplayName(slack, event.user)
        : runtime.staffDisplayNameFallback || 'Support';
      const message: SupportMessage = {
        id: newId('msg'),
        conversationId: conversation.id,
        body,
        attachments,
        authorRole: 'staff',
        authorName,
        createdAt: Date.now(),
        slackTs: event.ts,
      };
      const stored = this.insertMessage(message);

      const titled = this.setConversationTitleIfEmpty(
        conversation.id,
        titleFromFirstMessage(body, attachments.length),
      );
      if (titled) {
        conversation = { ...titled, updatedAt: stored.createdAt };
        this.broadcast({ type: 'conversation', conversation });
      }

      await runtime.onMessage?.({
        customerKey,
        message: stored,
        conversation,
        direction: 'from_slack',
      });
      this.broadcast({ type: 'message', message: stored });
    }
  };

  // Public constructor type only — private DO methods must not appear on the export.
  return CustomerSupportDO as unknown as CustomerSupportDOConstructor<Env>;
}

export type CustomerSupportDOClass<Env extends object = Record<string, unknown>> =
  CustomerSupportDOConstructor<Env>;
