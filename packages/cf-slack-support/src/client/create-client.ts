import type { ClientFrame, ServerFrame, UploadResponse } from '../protocol';
import { parseServerFrame } from '../protocol';
import type { SupportAttachment, SupportConversation, SupportMessage } from '../protocol';

export type SupportClientStatus = 'idle' | 'connecting' | 'open' | 'closed';

export type SupportClientEvents = {
  status: SupportClientStatus;
  ready: {
    customerKey: string;
    channelReady: boolean;
    conversations: SupportConversation[];
  };
  message: SupportMessage;
  messages: SupportMessage[];
  conversation: SupportConversation;
  ack: { clientId: string; messageId: string };
  error: { code: string; message: string; clientId?: string };
};

type EventKey = keyof SupportClientEvents;

export type CreateSupportClientOptions = {
  /** Base URL of the support worker, e.g. https://www.flickks.com/support-api */
  baseUrl: string;
  /** Short-lived bearer token (or any token your authenticate hook accepts). */
  getToken: () => string | Promise<string>;
  /** Path overrides - must match server `routes` / `basePath`. */
  paths?: Partial<{
    ws: string;
    uploads: string;
  }>;
  /** Reconnect with exponential backoff. Default true. */
  autoReconnect?: boolean;
  /** Initial reconnect delay ms. Default 500. */
  reconnectDelayMs?: number;
  /** Max reconnect delay ms. Default 15_000. */
  maxReconnectDelayMs?: number;
  /** Called for structured logs (optional). */
  onLog?: (level: 'debug' | 'warn' | 'error', message: string, extra?: unknown) => void;
};

function joinUrl(base: string, path: string): string {
  const origin = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${p}`;
}

function toWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}`;
  if (httpUrl.startsWith('http://')) return `ws://${httpUrl.slice('http://'.length)}`;
  return httpUrl;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Browser / isomorphic client with reconnect + catch-up and image upload helper.
 */
export function createSupportClient(options: CreateSupportClientOptions) {
  const wsPath = options.paths?.ws ?? '/ws';
  const uploadsPath = options.paths?.uploads ?? '/uploads';
  const autoReconnect = options.autoReconnect !== false;
  const listeners = new Map<EventKey, Set<(payload: never) => void>>();

  let socket: WebSocket | null = null;
  let status: SupportClientStatus = 'idle';
  let lastSeenId: string | undefined;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closedByUser = false;
  let connectGeneration = 0;

  function emit<K extends EventKey>(event: K, payload: SupportClientEvents[K]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as (p: SupportClientEvents[K]) => void)(payload);
      } catch {
        // swallow listener errors
      }
    }
  }

  function setStatus(next: SupportClientStatus): void {
    status = next;
    emit('status', next);
  }

  function log(level: 'debug' | 'warn' | 'error', message: string, extra?: unknown): void {
    options.onLog?.(level, message, extra);
  }

  function sendFrame(frame: ClientFrame): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Support client is not connected');
    }
    socket.send(JSON.stringify(frame));
  }

  function scheduleReconnect(): void {
    if (!autoReconnect || closedByUser) return;
    if (reconnectTimer) return;
    const base = options.reconnectDelayMs ?? 500;
    const max = options.maxReconnectDelayMs ?? 15_000;
    const delay = Math.min(max, base * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    log('debug', `reconnecting in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  async function connect(): Promise<void> {
    closedByUser = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const generation = ++connectGeneration;
    setStatus('connecting');

    const token = await options.getToken();
    const httpWs = joinUrl(options.baseUrl, wsPath);
    const url = new URL(toWsUrl(httpWs));
    // Browsers cannot set Authorization on WebSocket. Carry an encoded credential
    // in an offered subprotocol so it does not enter request URLs/access logs; the
    // server selects only the stable protocol and strips the credential protocol.
    const ws = new WebSocket(url.toString(), [
      'cf-slack-support.v1',
      `cf-slack-support.auth.${base64UrlEncode(token)}`,
    ]);
    socket = ws;

    ws.addEventListener('open', () => {
      if (generation !== connectGeneration) return;
      reconnectAttempt = 0;
      setStatus('open');
      sendFrame({ type: 'hello', lastSeenId });
    });

    ws.addEventListener('message', (event) => {
      if (generation !== connectGeneration) return;
      const raw = typeof event.data === 'string' ? event.data : '';
      const frame = parseServerFrame(raw);
      if (!frame) return;
      handleServerFrame(frame);
    });

    ws.addEventListener('close', () => {
      if (generation !== connectGeneration) return;
      setStatus('closed');
      socket = null;
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      log('warn', 'websocket error');
    });
  }

  function handleServerFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'ready':
        emit('ready', frame);
        break;
      case 'message':
        lastSeenId = frame.message.id;
        emit('message', frame.message);
        break;
      case 'messages':
        if (frame.messages.length) {
          lastSeenId = frame.messages[frame.messages.length - 1]!.id;
        }
        emit('messages', frame.messages);
        break;
      case 'conversation':
        emit('conversation', frame.conversation);
        break;
      case 'ack':
        emit('ack', frame);
        break;
      case 'error':
        emit('error', frame);
        break;
      case 'pong':
        break;
    }
  }

  function disconnect(): void {
    closedByUser = true;
    connectGeneration += 1;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close(1000, 'client disconnect');
    socket = null;
    setStatus('closed');
  }

  function on<K extends EventKey>(
    event: K,
    listener: (payload: SupportClientEvents[K]) => void,
  ): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => set!.delete(listener as (payload: never) => void);
  }

  async function uploadImage(file: Blob, filename?: string): Promise<SupportAttachment> {
    const token = await options.getToken();
    const form = new FormData();
    form.append('file', file, filename || 'image');
    const res = await fetch(joinUrl(options.baseUrl, uploadsPath), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as UploadResponse;
    return data.attachment;
  }

  /** Fetch protected media using the same bearer credential as uploads. */
  async function downloadAttachment(
    attachment: Pick<SupportAttachment, 'url'> | string,
  ): Promise<Blob> {
    const token = await options.getToken();
    const url = typeof attachment === 'string' ? attachment : attachment.url;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
    return res.blob();
  }

  function openConversation(title?: string): string {
    const clientId = crypto.randomUUID();
    sendFrame({ type: 'open_conversation', clientId, title });
    return clientId;
  }

  function closeConversation(conversationId: string, clientId?: string): string {
    const id = clientId || crypto.randomUUID();
    sendFrame({ type: 'close_conversation', clientId: id, conversationId });
    return id;
  }

  function reopenConversation(conversationId: string, clientId?: string): string {
    const id = clientId || crypto.randomUUID();
    sendFrame({ type: 'reopen_conversation', clientId: id, conversationId });
    return id;
  }

  function sendMessage(input: {
    body?: string;
    conversationId?: string;
    attachmentIds?: string[];
    clientId?: string;
  }): string {
    const clientId = input.clientId || crypto.randomUUID();
    sendFrame({
      type: 'send',
      clientId,
      conversationId: input.conversationId,
      body: input.body,
      attachmentIds: input.attachmentIds,
    });
    return clientId;
  }

  function ping(): void {
    sendFrame({ type: 'ping' });
  }

  return {
    connect,
    disconnect,
    on,
    uploadImage,
    downloadAttachment,
    openConversation,
    closeConversation,
    reopenConversation,
    sendMessage,
    ping,
    getStatus: () => status,
    getLastSeenId: () => lastSeenId,
    setLastSeenId: (id: string | undefined) => {
      lastSeenId = id;
    },
  };
}

export type SupportClient = ReturnType<typeof createSupportClient>;
