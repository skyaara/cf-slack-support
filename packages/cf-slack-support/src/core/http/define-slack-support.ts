import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type {
  SlackSupportRuntime,
  SupportAttachment,
  SupportIdentity,
} from '../../protocol';
import {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_ROUTES,
  describeChannelPolicy,
  resolveChannelPolicy,
} from '../../protocol';
import { mediaKeyFromPath } from '../../media';
import { verifySlackSignature } from '../../slack';
import { createCustomerSupportDOClass } from '../do/customer-support-do';
import type { HttpFeatureContext, SlackSupportOptions } from '../feature/types';
import { extensionForMimeOrBin } from '../do/utils';

type AppVariables = {
  runtime: SlackSupportRuntime;
};

export type SlackSupportHonoEnv<Env extends object = Record<string, unknown>> = {
  Bindings: Env;
  Variables: AppVariables;
};

export type SlackSupportApp<Env extends object = Record<string, unknown>> = {
  CustomerSupportDO: import('../do/customer-support-do').CustomerSupportDOConstructor<Env>;
  app: Hono<SlackSupportHonoEnv<Env>>;
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  features: string[];
};

function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath || basePath === '/') return '';
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

function routeSegment(
  basePath: string | undefined,
  override: string | undefined,
  fallback: string,
): string {
  const base = normalizeBasePath(basePath);
  const segment = override ?? fallback;
  const path = segment.startsWith('/') ? segment : `/${segment}`;
  return `${base}${path}` || '/';
}

function corsOriginOption(allowed: string[] | '*') {
  if (allowed === '*') return '*';
  return (origin: string) => (allowed.includes(origin) ? origin : '');
}

async function resolveIdentity<Env extends object>(
  options: SlackSupportOptions<Env>,
  request: Request,
  env: Env,
): Promise<SupportIdentity | Response> {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token');
  const req =
    !request.headers.get('Authorization') && queryToken
      ? (() => {
          const headers = new Headers(request.headers);
          headers.set('Authorization', `Bearer ${queryToken}`);
          return new Request(request.url, {
            method: request.method,
            headers,
          });
        })()
      : request;

  const result = await options.authenticate(req, env);
  if (result instanceof Response) return result;
  if (!result) return new Response('Unauthorized', { status: 401 });
  return result;
}

/**
 * Define a configurable Slack support Worker + Durable Object pair on Hono.
 * Pass feature plugins from peer packages (reactions, lifecycle, uploads, …).
 */
export function defineSlackSupport<Env extends object>(
  options: SlackSupportOptions<Env>,
): SlackSupportApp<Env> {
  const features = options.features ?? [];
  const CustomerSupportDO = createCustomerSupportDOClass(options);

  const health = routeSegment(options.basePath, options.routes?.health, DEFAULT_ROUTES.health);
  const ws = routeSegment(options.basePath, options.routes?.ws, DEFAULT_ROUTES.ws);
  const uploads = routeSegment(options.basePath, options.routes?.uploads, DEFAULT_ROUTES.uploads);
  const media = routeSegment(options.basePath, options.routes?.media, DEFAULT_ROUTES.media);
  const conversations = routeSegment(
    options.basePath,
    options.routes?.conversations,
    DEFAULT_ROUTES.conversations,
  );
  const slackEvents = routeSegment(
    options.basePath,
    options.routes?.slackEvents,
    DEFAULT_ROUTES.slackEvents,
  );

  const httpCtx: HttpFeatureContext<Env> = {
    basePath: normalizeBasePath(options.basePath),
    routes: { health, ws, uploads, media, conversations, slackEvents },
    getRuntime: options.getRuntime,
    resolveIdentity: (request, env) => resolveIdentity(options, request, env),
    mediaConfig: (runtime) => runtime.media,
  };

  const app = new Hono<SlackSupportHonoEnv<Env>>();

  app.use('*', async (c, next) => {
    const runtime = await options.getRuntime(c.env);
    c.set('runtime', runtime);

    if (c.req.header('Upgrade')?.toLowerCase() === 'websocket') {
      return next();
    }

    const corsMiddleware = cors({
      origin: corsOriginOption(runtime.corsOrigins),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'X-Filename'],
      maxAge: 86400,
    });
    return corsMiddleware(c, next);
  });

  app.get(health, (c) => {
    const runtime = c.get('runtime');
    const channelPolicy = resolveChannelPolicy(runtime.channelPolicy);
    return c.json({
      ok: true,
      features: features.map((f) => f.name),
      channelPolicy,
      channelPolicyDescription: describeChannelPolicy(channelPolicy),
    });
  });

  app.get(`${media}/*`, async (c) => {
    const runtime = c.get('runtime');
    if (!runtime.media?.store) return c.text('Not found', 404);
    const key = mediaKeyFromPath(new URL(c.req.url).pathname, media);
    if (!key) return c.text('Not found', 404);
    const object = await runtime.media.store.get(key);
    if (!object) return c.text('Not found', 404);
    const headers = new Headers({
      'Content-Type': object.contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    if (object.etag) headers.set('ETag', object.etag);
    if (object.bytes != null) headers.set('Content-Length', String(object.bytes));
    return new Response(object.body, { headers });
  });

  app.post(slackEvents, async (c) => {
    const runtime = c.get('runtime');
    const rawBody = await c.req.text();
    const valid = await verifySlackSignature({
      signingSecret: runtime.slack.signingSecret,
      signature: c.req.header('x-slack-signature') ?? null,
      timestamp: c.req.header('x-slack-request-timestamp') ?? null,
      rawBody,
    });
    if (!valid) {
      return c.text('Invalid signature', 401);
    }

    const payload = JSON.parse(rawBody) as {
      type?: string;
      challenge?: string;
      event?: {
        type?: string;
        channel?: string;
        channel_type?: string;
        user?: string;
        bot_id?: string;
        subtype?: string;
        text?: string;
        ts?: string;
        thread_ts?: string;
        reaction?: string;
        item?: { type?: string; channel?: string; ts?: string };
      };
    };

    if (payload.type === 'url_verification' && payload.challenge) {
      return c.text(payload.challenge);
    }

    if (payload.type === 'event_callback' && payload.event) {
      const event = payload.event;
      const eventType = event.type;
      const channelId =
        eventType === 'reaction_added' || eventType === 'reaction_removed'
          ? event.item?.channel
          : event.channel;

      if (
        eventType !== 'message' &&
        eventType !== 'reaction_added' &&
        eventType !== 'reaction_removed'
      ) {
        return c.json({ ok: true });
      }

      if (channelId) {
        const customerKey = await runtime.channelIndex.getCustomerKey(channelId);
        if (customerKey) {
          const stub = runtime.customers.get(runtime.customers.idFromName(customerKey));
          await stub.fetch('https://do/slack/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
          });
        }
      }
    }

    return c.json({ ok: true });
  });

  app.get(ws, async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() === 'websocket') {
      return upgradeWebSocket(options, c.req.raw, c.env, c.get('runtime'));
    }
    return c.text('Expected WebSocket upgrade', 426);
  });

  // Core always provides uploads when media is configured (also overridable by feature).
  app.post(uploads, async (c) => {
    const auth = await resolveIdentity(options, c.req.raw, c.env);
    if (auth instanceof Response) return auth;

    const runtime = c.get('runtime');
    if (!runtime.media?.store) {
      return c.json(
        {
          error:
            'Media store is not configured. Set runtime.media and optionally install uploads feature packages.',
        },
        501,
      );
    }

    const maxImageBytes = runtime.media.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    const allowedMimeTypes =
      runtime.media.allowedMimeTypes ?? [...DEFAULT_ALLOWED_MIME_TYPES];

    const contentType = c.req.header('content-type') || '';
    let bytes: ArrayBuffer;
    let mime: string;
    let filename: string | undefined;

    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return c.json({ error: 'Expected multipart field "file"' }, 400);
      }
      mime = file.type || 'application/octet-stream';
      filename = file.name;
      bytes = await file.arrayBuffer();
    } else {
      mime = contentType.split(';')[0]?.trim() || 'application/octet-stream';
      filename = c.req.header('x-filename') || undefined;
      bytes = await c.req.arrayBuffer();
    }

    if (!allowedMimeTypes.includes(mime)) {
      return c.json({ error: `Unsupported content type: ${mime}` }, 415);
    }
    if (bytes.byteLength > maxImageBytes) {
      return c.json({ error: `File too large (max ${maxImageBytes} bytes)` }, 413);
    }

    const key = `${auth.customerKey}/${crypto.randomUUID()}.${extensionForMimeOrBin(mime)}`;
    await runtime.media.store.put({
      key,
      body: bytes,
      contentType: mime,
      customMetadata: {
        customer_key: auth.customerKey,
        filename: filename || '',
      },
    });

    const attachment: SupportAttachment = {
      id: key,
      url: runtime.media.store.publicUrl(key),
      contentType: mime,
      filename,
      bytes: bytes.byteLength,
    };

    const stub = runtime.customers.get(runtime.customers.idFromName(auth.customerKey));
    await stub.fetch('https://do/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(auth),
    });

    return c.json({ attachment });
  });

  app.get(conversations, async (c) => {
    const auth = await resolveIdentity(options, c.req.raw, c.env);
    if (auth instanceof Response) return auth;
    const runtime = c.get('runtime');
    const stub = runtime.customers.get(runtime.customers.idFromName(auth.customerKey));
    return stub.fetch('https://do/conversations');
  });

  for (const feature of features) {
    feature.registerHttp?.(app, httpCtx);
  }

  const fetchHandler = async (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.pathname === ws &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
      try {
        const runtime = await options.getRuntime(env);
        return await upgradeWebSocket(options, request, env, runtime);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'WebSocket upgrade failed';
        console.error('[cf-slack-support] websocket upgrade failed', message);
        return new Response(message, { status: 500 });
      }
    }
    return app.fetch(request, env, ctx);
  };

  return {
    CustomerSupportDO,
    app,
    fetch: fetchHandler,
    features: features.map((f) => f.name),
  };
}

async function upgradeWebSocket<Env extends object>(
  options: SlackSupportOptions<Env>,
  request: Request,
  env: Env,
  runtime: SlackSupportRuntime,
): Promise<Response> {
  const auth = await resolveIdentity(options, request, env);
  if (auth instanceof Response) return auth;

  const stub = runtime.customers.get(runtime.customers.idFromName(auth.customerKey));
  const doUrl = new URL('https://do/websocket');
  doUrl.searchParams.set('customerKey', auth.customerKey);
  if (auth.displayName) doUrl.searchParams.set('displayName', auth.displayName);
  if (auth.meta && Object.keys(auth.meta).length > 0) {
    doUrl.searchParams.set('meta', JSON.stringify(auth.meta));
  }
  return stub.fetch(doUrl.toString(), request);
}
