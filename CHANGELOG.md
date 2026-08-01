# Changelog

## 0.0.1

- Single publishable package: `cf-slack-support`
- Optional features as **subpath plugins** (not peer packages):
  - `cf-slack-support/features/reactions`
  - `cf-slack-support/features/lifecycle`
- Bundle-conscious entries: `./client`, `./emoji`, `./protocol`, …
- Channel policies: `threads_only` | `bidirectional` | `staff_main_customer_threads`
- Vitest + fast-check + Cloudflare vitest-pool-workers DO tests
- Example Worker wiring
