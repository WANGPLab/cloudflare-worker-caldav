# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start local dev server (wrangler dev) |
| `npm run deploy` | Deploy to Cloudflare |
| `npm test` | Run all vitest tests |
| `npx vitest path/to/test.spec.js` | Run a single test file |

## Architecture

This is a Cloudflare Workers project using the service-worker format (`export default { fetch }`). The worker entry point is `src/index.js`, with a simple path-based router:

- `GET /` — serves `public/index.html` (static asset, configured in `wrangler.jsonc`)
- `GET /message` — returns `Hello, World!`
- `GET /random` — returns a random UUID via `crypto.randomUUID()`
- Everything else — 404

## Testing

Tests use [Vitest](https://vitest.dev/) with the `@cloudflare/vitest-pool-workers` integration. The vitest pool is configured in `vitest.config.js` to reference `wrangler.jsonc`.

Two test styles are available in `test/index.spec.js`:

- **Unit style** — import the worker directly (`import worker from "../src"`), create an `ExecutionContext` with `createExecutionContext()`, call `worker.fetch(request, env, ctx)`, then `await waitOnExecutionContext(ctx)`.
- **Integration style** — use the `SELF` service binding (`SELF.fetch(request)`) to test against the full workers runtime.

## Configuration

- `wrangler.jsonc` uses JSONC (comments allowed). The vitest pool reads this file — keep it valid.
- Prettier is configured for tabs, single quotes, semicolons, 140-char print width.
- Compatibility flags: `nodejs_compat`, `global_fetch_strictly_public`.

## Cloudflare Docs

Always retrieve current Cloudflare Workers documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task. Base URL: `https://developers.cloudflare.com/workers/`. For limits, retrieve from the product's `/platform/limits/` page.
