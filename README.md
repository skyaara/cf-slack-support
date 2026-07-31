# cf-slack-support

[![npm version](https://img.shields.io/badge/npm-0.0.1-blue.svg)](https://www.npmjs.com/package/cf-slack-support)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Composable **Cloudflare Durable Objects + Slack** customer support bridge, split into feature packages.

**Status:** `0.0.1` (initial monorepo version; not published to npm yet).  
**Repo:** https://github.com/skyaara/cf-slack-support

Synced with Flickks (`@flickks/slack-support`) capabilities: per-customer channels, thread conversations, hibernatable WebSockets, media uploads, **reactions**, and **close lifecycle**.

## Monorepo packages

| Package | Role |
|---------|------|
| `cf-slack-support` | Facade re-exports (Worker entry convenience) |
| `@cf-slack-support/protocol` | Domain types + WS frames |
| `@cf-slack-support/core` | DO host, Hono `defineSlackSupport`, **feature plugin API** |
| `@cf-slack-support/slack` | Slack Web API + signature verify |
| `@cf-slack-support/emoji` | Standard Slack reaction → Unicode map |
| `@cf-slack-support/media` | `MediaStore` + R2 / memory |
| `@cf-slack-support/auth` | HMAC bearer mint/verify |
| `@cf-slack-support/channel-index` | channelId → customerKey (KV / memory) |
| `@cf-slack-support/client` | Browser client |
| `@cf-slack-support/reactions` | **Optional peer feature** — Slack reactions |
| `@cf-slack-support/lifecycle` | **Optional peer feature** — close / reopen |

Optional features are **peer dependencies you install and pass in**:

```ts
import { defineSlackSupport, createBearerTokenAuthenticator, /* … */ } from 'cf-slack-support';
import { reactionsFeature } from '@cf-slack-support/reactions';
import { lifecycleFeature } from '@cf-slack-support/lifecycle';

const support = defineSlackSupport({
  features: [reactionsFeature(), lifecycleFeature()],
  authenticate: /* … */,
  getRuntime: (env) => ({ /* slack, media?, channelIndex, customers, … */ }),
});

export const CustomerSupportDO = support.CustomerSupportDO;
export default { fetch: support.fetch }; // prefer fetch over app for WebSockets
```

Without `lifecycle`, `close_conversation` / `reopen_conversation` frames return `feature_not_enabled`.  
Without `reactions`, reaction events are ignored and `message.reactions` is omitted.

See [`examples/worker`](./examples/worker) for a full Flickks-style wiring.

## Install (published layout)

```bash
npm install cf-slack-support hono
# optional features:
npm install @cf-slack-support/reactions @cf-slack-support/lifecycle
```

Browser:

```ts
import { createSupportClient } from 'cf-slack-support/client';
// or: '@cf-slack-support/client'
```

## Develop

```bash
npm install
npm test                 # unit + property (fast-check) tests
npm run test:workers     # miniflare / vitest-pool-workers integration
npm run typecheck
```

## Testing stack

- **Vitest** — unit tests per package  
- **fast-check** — property / fuzzy tests (protocol, emoji, signatures, auth, parsers)  
- **@cloudflare/vitest-pool-workers** — Worker + DO integration (`packages/integration-tests`)  
- Mocks for Slack `fetch`, in-memory media store, in-memory channel index  

## Slack app

Import [`manifest.slack.yaml`](./manifest.slack.yaml) (also under `packages/cf-slack-support/`).  
Add `reaction_added` / `reaction_removed` bot events when using the reactions feature.

## License

MIT
