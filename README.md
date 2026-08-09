# cf-slack-support

[![npm version](https://img.shields.io/badge/npm-0.0.1-blue.svg)](https://www.npmjs.com/package/cf-slack-support)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

**Cloudflare Durable Objects + Slack** customer support bridge.

**Status:** `0.0.1` (not published to npm yet).  
**Repo:** https://github.com/skyaara/cf-slack-support

One install. Optional features are **subpath plugins** (tree-shake / leave out of the bundle), not a zoo of `@cf-slack-support/*` packages.

## Install

```bash
npm install cf-slack-support hono
```

```ts
import {
  defineSlackSupport,
  createBearerTokenAuthenticator,
  createKvChannelIndex,
  createR2MediaStore,
  CHANNEL_POLICY_PRESETS,
} from 'cf-slack-support';
// Optional plugins — import only what you enable:
import { reactionsFeature } from 'cf-slack-support/features/reactions';
import { lifecycleFeature } from 'cf-slack-support/features/lifecycle';

const support = defineSlackSupport({
  features: [reactionsFeature(), lifecycleFeature()],
  authenticate: /* … */,
  getRuntime: (env) => ({ /* slack, media?, channelIndex, customers, … */ }),
});

export const CustomerSupportDO = support.CustomerSupportDO;
export default { fetch: support.fetch }; // prefer fetch over app for WebSockets
```

Without `lifecycleFeature`, `close_conversation` / `reopen_conversation` frames return `feature_not_enabled`.  
Without `reactionsFeature`, reaction events are ignored and `message.reactions` is omitted.

### Browser client (separate entry — keeps DO/Slack out of the UI bundle)

```ts
import { createSupportClient } from 'cf-slack-support/client';
```

### Subpath map (bundle-conscious)

| Import | When to use |
|--------|-------------|
| `cf-slack-support` | Worker: `defineSlackSupport`, runtime helpers, types |
| `cf-slack-support/client` | Browser WebSocket client only |
| `cf-slack-support/features/reactions` | Slack reaction sync + emoji map |
| `cf-slack-support/features/lifecycle` | Close / reopen conversations |
| `cf-slack-support/auth` | Bearer mint/verify (also on main) |
| `cf-slack-support/media` | R2 / memory stores (also on main) |
| `cf-slack-support/channel-index` | KV / memory channel index (also on main) |
| `cf-slack-support/slack` | Low-level Slack client / signature verify |
| `cf-slack-support/protocol` | Frames & domain types only |
| `cf-slack-support/channel` | Channel adapter contract (Slack / agent / non-threaded topologies) |
| `cf-slack-support/emoji` | Emoji map without the reactions feature |

`sideEffects: false` — unused subpaths stay out of esbuild/Wrangler trees.

### Channel policy (staff root vs threads)

```ts
import { CHANNEL_POLICY_PRESETS, type ChannelPolicy } from 'cf-slack-support';

getRuntime: (env) => ({
  channelPolicy: CHANNEL_POLICY_PRESETS.threadsOnly,
  // or: 'bidirectional' | CHANNEL_POLICY_PRESETS.staffMainCustomerThreads
});
```

| Policy | Channel root | Thread |
|--------|--------------|--------|
| `threads_only` | Dropped (staff must reply in-thread) | → customer |
| `bidirectional` (default) | Starts a new customer conversation | → customer |
| `staff_main_customer_threads` | Staff-only (not shown to customer) | → customer |

Pure helper: `decideInboundStaffMessage(policy, { ts, thread_ts })`.  
Optional per-customer override: `identity.meta.channelPolicy`.

See [`examples/worker`](./examples/worker) for full wiring.

## Security defaults

- Set `staffUserIds` to every Slack user allowed to communicate with customers. Other
  channel members are ignored. For directory/group-backed authorization, provide
  `authorizeSlackActor`.
- Set `corsOrigins` to the exact browser origins that may open the support client.
  WebSocket upgrades validate the browser `Origin`; avoid `'*'` in production.
- The built-in bearer helper requires a secret of at least 32 non-whitespace
  characters and mints five-minute tokens by default. Browser WebSocket credentials
  are carried in an encoded subprotocol, never in the URL.
- Media reads are authenticated by default and scoped to the authenticated
  `customerKey`. Render protected images by fetching them through
  `client.downloadAttachment()` and creating a local object URL. Set
  `media.publicRead: true` only when the deployment intentionally accepts public,
  capability-URL access.
- Default uploads are limited to 8 MiB, at most 10 attachments per message, and
  JPEG/PNG/WebP/GIF content with matching image signatures.

## Repo layout

```
packages/
  cf-slack-support/     # only published package (src modules + features/)
  integration-tests/    # workerd / DO tests (private)
examples/worker/
```

Internal folders (`src/features/…`, `src/protocol/…`) are for modularity — not separate npm packages.

## Develop

```bash
npm install
npm test                 # unit + property (fast-check)
npm run test:workers     # miniflare / vitest-pool-workers
npm run typecheck
```

### Contributing / protected `main`

- **Do not push commits to `main`.** Branch from `main`, open a PR, merge via review.
- CI and reviews land on PRs; `main` stays releasable.

## Testing stack

- **Vitest** — unit tests  
- **fast-check** — property tests  
- **@cloudflare/vitest-pool-workers** — Worker + DO integration  
- **Coverage (Istanbul)** — unit + workers  

```bash
npm test
npm run test:workers
npm run test:coverage
```

**Why workers coverage is not V8 by default:** Cloudflare’s Vitest pool runs in **workerd**, which does not expose the V8 coverage profiler. See [Cloudflare known issues → Coverage](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#coverage).

## Slack app

Import [`manifest.slack.yaml`](./manifest.slack.yaml) (also under `packages/cf-slack-support/`).  
Add `reaction_added` / `reaction_removed` bot events when using the reactions feature.

## License

MIT
