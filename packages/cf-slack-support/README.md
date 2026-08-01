# cf-slack-support

Cloudflare Durable Objects + Slack customer support bridge.

**Install one package.** Optional behavior is drop-in via subpath imports (not separate npm packages), so unused plugins stay out of your Worker/browser bundles.

```bash
npm install cf-slack-support hono
```

```ts
import { defineSlackSupport, createBearerTokenAuthenticator } from 'cf-slack-support';
import { reactionsFeature } from 'cf-slack-support/features/reactions';
import { lifecycleFeature } from 'cf-slack-support/features/lifecycle';
```

Browser:

```ts
import { createSupportClient } from 'cf-slack-support/client';
```

See the [repository root README](../../README.md) for full docs.
