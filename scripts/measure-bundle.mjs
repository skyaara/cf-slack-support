import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const monorepo = join(dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = require(join(monorepo, 'node_modules/esbuild'));
// Prefer wrangler's esbuild if needed - root may have vite's
let build;
try {
  ({ build } = await import(join(monorepo, 'node_modules/esbuild/lib/main.js')));
} catch {
  // CJS
  build = esbuild.build;
}
if (!build) build = esbuild.build;

const outDir = join(monorepo, '.bundle-measure');
mkdirSync(outDir, { recursive: true });
const pkg = join(monorepo, 'packages/cf-slack-support');

const cloudflareStub = `
export class DurableObject {
  constructor(state, env) { this.ctx = state; this.env = env; }
}
`;
writeFileSync(join(outDir, 'cloudflare-workers-stub.js'), cloudflareStub);

const fixtures = {
  'worker-core-only': `
    import {
      defineSlackSupport,
      createBearerTokenAuthenticator,
      createKvChannelIndex,
      createR2MediaStore,
      slugifyChannelName,
      CHANNEL_POLICY_PRESETS,
    } from '${pkg}/src/index.ts';
    export default defineSlackSupport({
      features: [],
      authenticate: createBearerTokenAuthenticator({ getSecret: () => 'x' }),
      getRuntime: (env) => ({
        slack: { botToken: 't', signingSecret: 's' },
        channelIndex: createKvChannelIndex(env.INDEX),
        media: { store: createR2MediaStore({ bucket: env.B, publicBaseUrl: 'https://x' }), publicBaseUrl: 'https://x' },
        customers: env.DO,
        channelName: (id) => slugifyChannelName('s-' + id.customerKey),
        channelPolicy: CHANNEL_POLICY_PRESETS.bidirectional,
      }),
    });
  `,
  'worker-full-features': `
    import {
      defineSlackSupport,
      createBearerTokenAuthenticator,
      createKvChannelIndex,
      createR2MediaStore,
      slugifyChannelName,
    } from '${pkg}/src/index.ts';
    import { reactionsFeature } from '${pkg}/src/features/reactions/index.ts';
    import { lifecycleFeature } from '${pkg}/src/features/lifecycle/index.ts';
    export default defineSlackSupport({
      features: [reactionsFeature(), lifecycleFeature()],
      authenticate: createBearerTokenAuthenticator({ getSecret: () => 'x' }),
      getRuntime: (env) => ({
        slack: { botToken: 't', signingSecret: 's' },
        channelIndex: createKvChannelIndex(env.INDEX),
        media: { store: createR2MediaStore({ bucket: env.B, publicBaseUrl: 'https://x' }), publicBaseUrl: 'https://x' },
        customers: env.DO,
        channelName: (id) => slugifyChannelName('s-' + id.customerKey),
      }),
    });
  `,
  'browser-client': `
    import { createSupportClient } from '${pkg}/src/client/index.ts';
    export { createSupportClient };
  `,
  'reactions-plugin-only': `
    import { reactionsFeature } from '${pkg}/src/features/reactions/index.ts';
    export { reactionsFeature };
  `,
  'lifecycle-plugin-only': `
    import { lifecycleFeature } from '${pkg}/src/features/lifecycle/index.ts';
    export { lifecycleFeature };
  `,
  'emoji-only': `
    import { slackReactionToUnicode } from '${pkg}/src/emoji/index.ts';
    export { slackReactionToUnicode };
  `,
  'protocol-only': `
    import { parseClientFrame, CHANNEL_POLICY_PRESETS } from '${pkg}/src/protocol/index.ts';
    export { parseClientFrame, CHANNEL_POLICY_PRESETS };
  `,
  'auth-only': `
    import { createBearerTokenAuthenticator, mintSupportBearerToken } from '${pkg}/src/auth/index.ts';
    export { createBearerTokenAuthenticator, mintSupportBearerToken };
  `,
};

function kb(n) {
  return (n / 1024).toFixed(2) + ' KB';
}

const results = [];

for (const [name, code] of Object.entries(fixtures)) {
  const entry = join(outDir, `entry-${name}.ts`);
  writeFileSync(entry, code);
  const outfile = join(outDir, `${name}.js`);
  const isBrowser = name.startsWith('browser');
  const isSmall = /plugin-only|emoji-only|protocol-only|auth-only/.test(name);

  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: true,
      outfile,
      format: 'esm',
      platform: isBrowser || isSmall ? 'browser' : 'neutral',
      target: 'es2022',
      minify: true,
      treeShaking: true,
      external: isBrowser || isSmall ? [] : [],
      alias: {
        'cloudflare:workers': join(outDir, 'cloudflare-workers-stub.js'),
      },
      logLevel: 'silent',
      metafile: true,
    });

    const raw = readFileSync(outfile);
    const gzip = gzipSync(raw, { level: 9 });
    const brotli = brotliCompressSync(raw);

    const inputs = result.metafile?.inputs ?? {};
    const contrib = Object.entries(inputs)
      .map(([path, info]) => ({
        path: path.replace(monorepo + '/', ''),
        bytes: info.bytes,
      }))
      .filter(
        (x) =>
          x.path.includes('packages/cf-slack-support') ||
          x.path.includes('node_modules/hono'),
      )
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 10);

    results.push({ name, raw: raw.length, gzip: gzip.length, brotli: brotli.length, top: contrib });
  } catch (err) {
    results.push({ name, error: String(err?.errors?.[0]?.text || err?.message || err).slice(0, 500) });
  }
}

// lib-only (hono external)
for (const name of ['worker-core-only', 'worker-full-features']) {
  const entry = join(outDir, `entry-${name}.ts`);
  const outfile = join(outDir, `${name}-lib-only.js`);
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      write: true,
      outfile,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      minify: true,
      treeShaking: true,
      external: ['hono', 'hono/*'],
      alias: { 'cloudflare:workers': join(outDir, 'cloudflare-workers-stub.js') },
      logLevel: 'silent',
    });
    const raw = readFileSync(outfile);
    results.push({
      name: name + ' (lib only, hono external)',
      raw: raw.length,
      gzip: gzipSync(raw, { level: 9 }).length,
      brotli: brotliCompressSync(raw).length,
    });
  } catch (err) {
    results.push({ name: name + ' (lib only)', error: String(err?.message || err).slice(0, 300) });
  }
}

console.log('\n=== Bundle sizes (esbuild minify) ===\n');
console.log('Scenario'.padEnd(44), 'raw'.padStart(12), 'gzip'.padStart(12), 'brotli'.padStart(12));
console.log('-'.repeat(82));
for (const r of results) {
  if (r.error) {
    console.log(r.name.padEnd(44), 'ERROR:', r.error);
    continue;
  }
  console.log(r.name.padEnd(44), kb(r.raw).padStart(12), kb(r.gzip).padStart(12), kb(r.brotli).padStart(12));
}

for (const label of ['worker-full-features', 'browser-client', 'worker-core-only', 'reactions-plugin-only']) {
  const r = results.find((x) => x.name === label);
  if (!r?.top) continue;
  console.log(`\n=== Top inputs: ${label} ===\n`);
  for (const t of r.top) console.log(kb(t.bytes).padStart(10), t.path);
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}
const srcFiles = walk(join(pkg, 'src'));
let totalSrc = 0;
const byDir = {};
for (const f of srcFiles) {
  const n = statSync(f).size;
  totalSrc += n;
  const top = f.replace(join(pkg, 'src') + '/', '').split('/')[0];
  byDir[top] = (byDir[top] || 0) + n;
}
console.log('\n=== Unminified TS source on disk ===\n');
console.log('Total:', kb(totalSrc));
for (const [k, v] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) {
  console.log(kb(v).padStart(10), k);
}
