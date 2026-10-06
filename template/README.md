# **NAME**

Clankwerk project for `__ADMIN__`. Its public trigger hostname is `__TRIGGER__`. Both hostnames must belong to your Cloudflare account. The dashboard uses Cloudflare Access; the trigger hostname does **not** expose admin APIs.

## Setup

1. Install dependencies with `bun install`. `cf` currently loads `cloudflare.config.ts` with Node 22.18+ (Node 24 recommended), even when invoked from Bun.
2. Sign in with `cf auth login` and ensure both domains belong to your Cloudflare account.
3. Select an existing, reusable Access **allow** policy for authorized identities. Enter its UUID in `clankwerk.json` as `accessPolicyId` (or pass `--access-policy` when scaffolding). `bun run setup` creates a self-hosted Access application for `__ADMIN__` using that policy if one doesn't already exist and verifies protection. `bun run deploy` verifies Access again, then calls `cf deploy`. You may also run `cf deploy` directly **after setup**, but direct CLI deployment bypasses the protection preflight. Do not create an Access bypass policy for the admin hostname.
4. Run `bun run dev` for local development (Cloudflare's local runtime), `bun run setup` to verify/provision Access, and `bun run deploy` to build and deploy via `cf deploy`. Access/DNS protection must be verified on the deployed domains; local development does not emulate Access.

The starter declares one Think-backed agent in `agents/researcher.ts` (many instance names can select independent DOs) and one simple workflow in `workflows/hello.ts`. From an Access-authenticated session on the admin hostname, `POST /api/workflows/hello/runs` with a JSON body starts a run; poll `GET /api/runs/{id}` for its status. The dashboard currently shows registered definitions; `/api/runs` and `/api/audit` provide indexed run and event lists backed by D1, but the dashboard's interactive views and agent-instance index are not yet implemented.

The public trigger hostname currently responds 404 to all requests: **no webhook endpoint is implemented**. Do not expose admin APIs to accept external traffic. The sample per-run coordinator executes static graph steps sequentially and retries interrupted tasks; it does not yet provide guaranteed exactly-once external effects, dynamic fan-out, deployment-safe retention of historical source bundles, or guaranteed completeness of the D1 run index. Make task side effects idempotent. This starter is not production-complete.
