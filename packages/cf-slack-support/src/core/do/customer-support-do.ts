import { DurableObject } from 'cloudflare:workers';
import type {
  ClientFrame,
  ConversationExternalBinding,
  MessageExternalRef,
  SupportAttachment,
  SupportConversation,
  SupportConversationStatus,
  SupportIdentity,
  SupportMessage,
  SlackSupportRuntime,
} from '../../protocol';
import type { ChannelPolicyInput } from '../../protocol';
import {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_IMAGE_BYTES,
  CLIENT_FRAME_LIMITS,
  decideInboundStaffMessage,
  parseClientFrame,
  resolveChannelPolicy,
  resolveConversationExternal,
  resolveMessageExternal,
  slackBindingFromLegacy,
  slackMessageRef,
  slackThreadTsFromExternal,
  slackTsFromExternal,
} from '../../protocol';
import { createSlackChannelAdapter } from '../../channel';
import { mediaKeyBelongsToCustomer, mediaNamespaceForCustomer } from '../../media';
import { createSlackClient, slugifyChannelName } from '../../slack';
import type {
  ConversationRow,
  FeatureHost,
  InsertConversationInput,
  MessageRow,
  SlackSupportOptions,
  SupportFeature,
} from '../feature/types';
import { applyCoreSchema } from './schema';
import {
  buildBlocks,
  clientSafeError,
  escapeSlackMrkdwn,
  extensionForMime,
  hasExpectedImageSignature,
  isSafeInlineImageMime,
  isMissingChannelError,
  jsonAttachments,
  jsonReactions,
  newId,
  parseAttachments,
  parseReactions,
  titleFromFirstMessage,
} from './utils';

const CONVERSATION_SELECT = `id, title, slack_thread_ts, status, closed_at, created_at, updated_at,
  external_adapter_id, external_inbox_id, external_location_id`;

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

type SlackActorEvent = {
  type?: string;
  user?: string;
  channel?: string;
  item?: { channel?: string };
};

/**
 * Per-customer Durable Object: channel adapters + SQLite history,
 * hibernatable WebSockets, and pluggable features.
 *
 * Conversations are durable units bound to external locations via
 * {@link ConversationExternalBinding} (Slack threads today; agents / other
 * apps later). Nested threads are a Slack capability, not the core model.
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
        getConversationByBinding: (b) => self.getConversationByBinding(b),
        insertConversation: (input) => self.insertConversation(input),
        bindConversation: (id, binding) => self.bindConversation(id, binding),
        setConversationStatus: (id, status, at) => self.setConversationStatus(id, status, at),
        insertMessage: (m) => self.insertMessage(m),
        findByClientId: (id) => self.findByClientId(id),
        findBySlackTs: (ts) => self.findBySlackTs(ts),
        findMessageByExternalRef: (ref) => self.findMessageByExternalRef(ref),
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

    private externalFromConversationRow(r: ConversationRow): ConversationExternalBinding | null {
      if (r.external_adapter_id && r.external_location_id) {
        return {
          adapterId: r.external_adapter_id,
          ...(r.external_inbox_id ? { inboxId: r.external_inbox_id } : {}),
          locationId: r.external_location_id,
        };
      }
      return slackBindingFromLegacy({
        channelId: this.metaGet('slack_channel_id'),
        slackThreadTs: r.slack_thread_ts,
      });
    }

    private mapConversationRow(r: ConversationRow): SupportConversation {
      const status: SupportConversationStatus = r.status === 'closed' ? 'closed' : 'open';
      const external = this.externalFromConversationRow(r);
      let conversation: SupportConversation = {
        id: r.id,
        title: r.title ?? null,
        external,
        slackThreadTs:
          r.slack_thread_ts ?? slackThreadTsFromExternal(external) ?? null,
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

    private async isAuthorizedSlackActor(event: SlackActorEvent): Promise<boolean> {
      const userId = event.user?.trim();
      const channelId = event.channel?.trim() || event.item?.channel?.trim();
      const eventType = event.type?.trim();
      if (!userId || !channelId || !eventType) return false;
      const runtime = await this.runtime();
      if (runtime.authorizeSlackActor) {
        return Boolean(await runtime.authorizeSlackActor({ userId, channelId, eventType }));
      }
      return runtime.staffUserIds.includes(userId);
    }

    private listConversations(): SupportConversation[] {
      const rows = this.ctx.storage.sql
        .exec<ConversationRow>(
          `SELECT ${CONVERSATION_SELECT}
           FROM conversations ORDER BY updated_at DESC`,
        )
        .toArray();
      return rows.map((r) => this.mapConversationRow(r));
    }

    private getConversation(id: string): SupportConversation | null {
      const r = this.ctx.storage.sql
        .exec<ConversationRow>(
          `SELECT ${CONVERSATION_SELECT}
           FROM conversations WHERE id = ?`,
          id,
        )
        .toArray()[0];
      return r ? this.mapConversationRow(r) : null;
    }

    private getConversationByThread(threadTs: string): SupportConversation | null {
      return this.getConversationByBinding({ adapterId: 'slack', locationId: threadTs });
    }

    private getConversationByBinding(
      binding: Pick<ConversationExternalBinding, 'adapterId' | 'locationId'>,
    ): SupportConversation | null {
      const byExternal = this.ctx.storage.sql
        .exec<ConversationRow>(
          `SELECT ${CONVERSATION_SELECT}
           FROM conversations
           WHERE external_adapter_id = ? AND external_location_id = ?`,
          binding.adapterId,
          binding.locationId,
        )
        .toArray()[0];
      if (byExternal) return this.mapConversationRow(byExternal);

      // Legacy Slack rows before external_* backfill / dual-write.
      if (binding.adapterId === 'slack') {
        const bySlack = this.ctx.storage.sql
          .exec<ConversationRow>(
            `SELECT ${CONVERSATION_SELECT}
             FROM conversations WHERE slack_thread_ts = ?`,
            binding.locationId,
          )
          .toArray()[0];
        return bySlack ? this.mapConversationRow(bySlack) : null;
      }
      return null;
    }

    private insertConversation(input: InsertConversationInput): SupportConversation {
      const status: SupportConversationStatus = input.status ?? 'open';
      const closedAt = status === 'closed' ? (input.closedAt ?? input.createdAt) : null;
      const external = resolveConversationExternal({
        external: input.external,
        slackThreadTs: input.slackThreadTs,
        channelId: this.metaGet('slack_channel_id'),
      });
      const slackThreadTs =
        input.slackThreadTs ?? slackThreadTsFromExternal(external) ?? null;

      this.ctx.storage.sql.exec(
        `INSERT INTO conversations (
           id, title, slack_thread_ts, status, closed_at, created_at, updated_at,
           external_adapter_id, external_inbox_id, external_location_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.title,
        slackThreadTs,
        status,
        closedAt,
        input.createdAt,
        input.createdAt,
        external?.adapterId ?? null,
        external?.inboxId ?? null,
        external?.locationId ?? null,
      );
      return this.mapConversationRow({
        id: input.id,
        title: input.title,
        slack_thread_ts: slackThreadTs,
        status,
        closed_at: closedAt,
        created_at: input.createdAt,
        updated_at: input.createdAt,
        external_adapter_id: external?.adapterId ?? null,
        external_inbox_id: external?.inboxId ?? null,
        external_location_id: external?.locationId ?? null,
      });
    }

    private bindConversation(
      conversationId: string,
      binding: ConversationExternalBinding,
    ): void {
      const at = Date.now();
      const slackThreadTs =
        binding.adapterId === 'slack' ? binding.locationId : null;
      this.ctx.storage.sql.exec(
        `UPDATE conversations SET
           updated_at = ?,
           external_adapter_id = ?,
           external_inbox_id = ?,
           external_location_id = ?,
           slack_thread_ts = COALESCE(?, slack_thread_ts)
         WHERE id = ?`,
        at,
        binding.adapterId,
        binding.inboxId ?? null,
        binding.locationId,
        slackThreadTs,
        conversationId,
      );
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

    private touchConversation(
      id: string,
      at: number,
      bindingOrSlackThread?: ConversationExternalBinding | string | null,
    ): void {
      if (bindingOrSlackThread && typeof bindingOrSlackThread === 'object') {
        this.bindConversation(id, bindingOrSlackThread);
        this.ctx.storage.sql.exec(
          `UPDATE conversations SET updated_at = ? WHERE id = ?`,
          at,
          id,
        );
        return;
      }
      if (bindingOrSlackThread !== undefined) {
        const slackThreadTs = bindingOrSlackThread;
        this.ctx.storage.sql.exec(
          `UPDATE conversations SET
             updated_at = ?,
             slack_thread_ts = COALESCE(?, slack_thread_ts),
             external_adapter_id = COALESCE(external_adapter_id, 'slack'),
             external_location_id = COALESCE(?, external_location_id),
             external_inbox_id = COALESCE(external_inbox_id, ?)
           WHERE id = ?`,
          at,
          slackThreadTs,
          slackThreadTs,
          this.metaGet('slack_channel_id'),
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
        role === 'customer' ||
        role === 'staff' ||
        role === 'agent' ||
        role === 'system'
          ? role
          : 'system';
      const external = resolveMessageExternal({
        external:
          r.external_adapter_id && r.external_message_id
            ? { adapterId: r.external_adapter_id, messageId: r.external_message_id }
            : null,
        slackTs: r.slack_ts,
      });
      let message: SupportMessage = {
        id: r.id,
        conversationId: r.conversation_id,
        body: r.body ?? null,
        attachments: parseAttachments(r.attachments_json ?? '[]'),
        authorRole,
        authorName: r.author_name?.trim() ? r.author_name.trim() : undefined,
        createdAt: r.created_at,
        clientId: r.client_id ?? undefined,
        external,
        slackTs: r.slack_ts ?? slackTsFromExternal(external) ?? undefined,
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
      const external = resolveMessageExternal({
        external: message.external,
        slackTs: message.slackTs,
      });
      let externalMessageId = external?.messageId ?? null;
      const externalAdapterId = external?.adapterId ?? null;
      let slackTs =
        message.slackTs ??
        (externalAdapterId === 'slack' ? externalMessageId : null) ??
        null;

      if (external && this.findMessageByExternalRef(external)) {
        console.warn('[cf-slack-support] external message ref already stored; inserting without it', {
          messageId: message.id,
          external,
        });
        externalMessageId = null;
        if (external.adapterId === 'slack') slackTs = null;
      } else if (slackTs && this.findBySlackTs(slackTs)) {
        console.warn('[cf-slack-support] slack_ts already stored; inserting without it', {
          messageId: message.id,
          slackTs,
        });
        slackTs = null;
        if (externalAdapterId === 'slack') externalMessageId = null;
      }

      const reactionsJson = jsonReactions(message.reactions ?? []);
      const storedExternal =
        externalAdapterId && externalMessageId
          ? { adapterId: externalAdapterId, messageId: externalMessageId }
          : null;

      try {
        this.ctx.storage.sql.exec(
          `INSERT INTO messages (
            id, conversation_id, body, attachments_json, author_role, author_name,
            created_at, client_id, slack_ts, reactions_json,
            external_adapter_id, external_message_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          storedExternal?.adapterId ?? null,
          storedExternal?.messageId ?? null,
        );
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const uniqueHit =
          /UNIQUE constraint failed:\s*messages\.(slack_ts|external_message_id)/i.test(raw) ||
          /UNIQUE constraint failed:\s*messages_external_ref/i.test(raw);
        if ((slackTs || storedExternal) && uniqueHit) {
          this.ctx.storage.sql.exec(
            `INSERT INTO messages (
              id, conversation_id, body, attachments_json, author_role, author_name,
              created_at, client_id, slack_ts, reactions_json,
              external_adapter_id, external_message_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            null,
            null,
          );
          slackTs = null;
        } else {
          throw err;
        }
      }
      this.touchConversation(message.conversationId, message.createdAt);
      const finalExternal =
        storedExternal ?? (slackTs ? slackMessageRef(slackTs) : null);
      return {
        ...message,
        external: finalExternal,
        slackTs: slackTs ?? slackTsFromExternal(finalExternal) ?? undefined,
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
      return this.findMessageByExternalRef({ adapterId: 'slack', messageId: slackTs });
    }

    private findMessageByExternalRef(ref: MessageExternalRef): SupportMessage | null {
      const byExternal = this.ctx.storage.sql
        .exec<MessageRow>(
          `SELECT * FROM messages
           WHERE external_adapter_id = ? AND external_message_id = ?`,
          ref.adapterId,
          ref.messageId,
        )
        .toArray()[0];
      if (byExternal) return this.rowToMessage(byExternal);

      if (ref.adapterId === 'slack') {
        const bySlack = this.ctx.storage.sql
          .exec<MessageRow>(`SELECT * FROM messages WHERE slack_ts = ?`, ref.messageId)
          .toArray()[0];
        return bySlack ? this.rowToMessage(bySlack) : null;
      }
      return null;
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
        // Optional per-customer override: meta.channelPolicy = 'threads_only' | …
        const policy = identity.meta.channelPolicy ?? identity.meta.channel_policy;
        if (typeof policy === 'string' && policy.trim()) {
          this.metaSet('channel_policy', policy.trim());
        }
      }
    }

    /** Runtime policy, with optional per-customer override stored in DO meta. */
    private async effectiveChannelPolicy(
      runtime: SlackSupportRuntime,
    ): Promise<ChannelPolicyInput> {
      const override = this.metaGet('channel_policy');
      if (override) return resolveChannelPolicy(override as ChannelPolicyInput);
      return runtime.channelPolicy;
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
        if (!mediaKeyBelongsToCustomer(id, customerKey)) {
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

    private async postToSlack(input: {
      runtime: SlackSupportRuntime;
      channelId: string;
      conversation: SupportConversation;
      message: SupportMessage;
    }): Promise<{ slackTs: string; threadTs: string }> {
      const policy = resolveChannelPolicy(
        await this.effectiveChannelPolicy(input.runtime),
      );
      const identity = this.identityFromMeta();

      const adapter = createSlackChannelAdapter({
        inboxRouting: policy.mode,
        ensureInbox: async (id) => {
          const ensured = await this.ensureChannel(id);
          return { inboxId: ensured.channelId, created: ensured.created };
        },
        postMessage: async (postInput) => {
          const slack = createSlackClient({ botToken: input.runtime.slack.botToken });
          const textParts: string[] = [];
          if (postInput.message.body) textParts.push(escapeSlackMrkdwn(postInput.message.body));
          const text =
            textParts.join('\n') ||
            `${escapeSlackMrkdwn(postInput.message.authorName || 'Customer')} sent an attachment`;

          let channelId = postInput.inboxId;
          let threadTs = postInput.threadTs;
          let isParent = !threadTs;
          const postOnce = async () =>
            slack.postMessage({
              channel: channelId,
              text:
                isParent && postInput.conversation.title
                  ? `*${escapeSlackMrkdwn(postInput.conversation.title)}*\n${text}`
                  : text,
              threadTs: isParent ? undefined : threadTs ?? undefined,
              blocks: buildBlocks(
                { ...postInput.message, attachments: [] },
                isParent ? postInput.conversation.title : null,
              ),
            });

          const uploadAttachments = async (threadRootTs: string) => {
            if (!input.runtime.media?.store) return;
            for (const attachment of postInput.message.attachments) {
              try {
                const stored = await input.runtime.media.store.get(attachment.id);
                if (!stored) continue;
                const bytes = await new Response(stored.body).arrayBuffer();
                await slack.uploadFile({
                  channelId,
                  threadTs: threadRootTs,
                  filename:
                    attachment.filename?.replace(/[\\/\r\n]/g, '_').slice(0, 180) ||
                    `attachment.${extensionForMime(stored.contentType) || 'bin'}`,
                  contentType: stored.contentType,
                  bytes,
                  title: attachment.filename?.slice(0, 180),
                });
              } catch (err) {
                console.warn('[cf-slack-support] native Slack attachment upload failed', {
                  attachmentId: attachment.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          };

          try {
            const posted = await postOnce();
            const threadRootTs = isParent ? posted.ts : threadTs!;
            await uploadAttachments(threadRootTs);
            return { messageTs: posted.ts, threadRootTs };
          } catch (err) {
            if (!isMissingChannelError(err)) throw err;
            this.clearChannelBinding();
            threadTs = null;
            isParent = true;
            const recovered = await this.ensureChannel(this.identityFromMeta());
            channelId = recovered.channelId;
            const posted = await postOnce();
            await uploadAttachments(posted.ts);
            return { messageTs: posted.ts, threadRootTs: posted.ts };
          }
        },
      });

      const existingBinding =
        input.conversation.external ??
        slackBindingFromLegacy({
          channelId: input.channelId,
          slackThreadTs: input.conversation.slackThreadTs,
        });

      const result = await adapter.post({
        identity,
        conversation: input.conversation,
        message: input.message,
        binding: existingBinding,
        inboxId: input.channelId,
      });

      this.bindConversation(input.conversation.id, result.binding);

      return {
        slackTs: result.messageRef.messageId,
        threadTs: result.binding.locationId,
      };
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
        const headers = new Headers();
        if (request.headers.get('Sec-WebSocket-Protocol') === 'cf-slack-support.v1') {
          headers.set('Sec-WebSocket-Protocol', 'cf-slack-support.v1');
        }
        return new Response(null, { status: 101, webSocket: client, headers });
      }

      if (path === '/slack/event' && request.method === 'POST') {
        const event = (await request.json()) as { type?: string };
        if (!(await this.isAuthorizedSlackActor(event as SlackActorEvent))) {
          return Response.json({ ok: true, ignored: 'unauthorized_actor' });
        }
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
      const byteLength =
        typeof message === 'string'
          ? new TextEncoder().encode(message).byteLength
          : message.byteLength;
      if (byteLength > CLIENT_FRAME_LIMITS.maxBytes) {
        this.send(ws, { type: 'error', code: 'frame_too_large', message: 'Frame too large' });
        ws.close(1009, 'Frame too large');
        return;
      }
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
              ? 'Conversation lifecycle is not enabled. Pass lifecycleFeature() in features.'
              : 'Conversation lifecycle is not enabled. Pass lifecycleFeature() in features.',
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
        const external = slackMessageRef(slackTs);
        const binding = slackBindingFromLegacy({ channelId, slackThreadTs: threadTs });
        message.slackTs = slackTs;
        message.external = external;
        conversation = {
          ...conversation,
          external: binding,
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
            external: binding ?? titled.external,
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
          adapterId: 'slack',
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

      const channelPolicy = await this.effectiveChannelPolicy(runtime);
      const routing = decideInboundStaffMessage(channelPolicy, event);
      if (routing.action === 'drop') {
        console.log('[cf-slack-support] drop staff message per channelPolicy', {
          reason: routing.reason,
          ts: event.ts,
          threadTs: event.thread_ts,
          policy: resolveChannelPolicy(channelPolicy).mode,
        });
        return;
      }

      const { threadRoot } = routing;
      let conversation = this.getConversationByBinding({
        adapterId: 'slack',
        locationId: threadRoot,
      });
      if (!conversation) {
        conversation = this.insertConversation({
          id: newId('conv'),
          title: null,
          external: slackBindingFromLegacy({
            channelId: event.channel,
            slackThreadTs: threadRoot,
          }),
          slackThreadTs: threadRoot,
          createdAt: Date.now(),
        });
        this.broadcast({ type: 'conversation', conversation });
      }

      const slack = createSlackClient({ botToken: runtime.slack.botToken });
      const attachments: SupportAttachment[] = [];
      if (runtime.media?.store) {
        const maxImageBytes = runtime.media.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
        for (const file of event.files || []) {
          if (!file.url_private_download) continue;
          const allowed =
            runtime.media.allowedMimeTypes ?? [...DEFAULT_ALLOWED_MIME_TYPES];
          if (file.mimetype && !allowed.includes(file.mimetype)) continue;
          if (file.size != null && file.size > maxImageBytes) continue;
          try {
            const downloaded = await slack.downloadPrivateFile(
              file.url_private_download,
              maxImageBytes,
            );
            if (!allowed.includes(downloaded.contentType)) continue;
            if (
              isSafeInlineImageMime(downloaded.contentType) &&
              !hasExpectedImageSignature(downloaded.bytes, downloaded.contentType)
            ) {
              continue;
            }
            const ext = extensionForMime(downloaded.contentType) || 'bin';
            const key = `${mediaNamespaceForCustomer(customerKey)}/${crypto.randomUUID()}.${ext}`;
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
        external: slackMessageRef(event.ts),
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
        adapterId: 'slack',
      });
      this.broadcast({ type: 'message', message: stored });
    }
  };

  // Public constructor type only — private DO methods must not appear on the export.
  return CustomerSupportDO as unknown as CustomerSupportDOConstructor<Env>;
}

export type CustomerSupportDOClass<Env extends object = Record<string, unknown>> =
  CustomerSupportDOConstructor<Env>;
