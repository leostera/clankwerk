# clankwerk-live

Deployed example for `clankwerk.leostera.dev`. Public trigger hostname: `triggers.clankwerk.leostera.dev`.

This example imports `@leostera/clankwerk` from the repository's root `src/` via TypeScript/Vite aliases to test this checkout. Its `setup` and `deploy` scripts run the root CLI source. It is **not** a separate workspace or publishable package; use `bunx @leostera/clankwerk new` to create your own project.

## Try locally

From `examples/clankwerk-live`, run `bun install` and `bun run dev`. Open the local URL printed by `cf dev`; follow the [getting-started guide](../../docs/getting-started.md) to POST `"World"` to the `hello` workflow and inspect its run and audit events. Local development does not test Access or DNS.

## Deploy (maintainer account only)

1. Install dependencies with `bun install`. `cf` currently loads `cloudflare.config.ts` with Node 22.18+ (Node 24 recommended), even when invoked from Bun.
2. Sign in with `cf auth login` and ensure both domains belong to your Cloudflare account.
3. Select an existing, reusable Access **allow** policy for authorized identities. Enter its UUID in `clankwerk.json` as `accessPolicyId` (or pass `--access-policy` when scaffolding). `bun run setup` creates a self-hosted Access application for `clankwerk.leostera.dev` using that policy if one doesn't already exist and verifies protection. `bun run deploy` verifies Access again, then calls `cf deploy`. You may also run `cf deploy` directly **after setup**, but direct CLI deployment bypasses the protection preflight. Do not create an Access bypass policy for the admin hostname.
4. Run `bun run dev` for local development (Cloudflare's local runtime), `bun run setup` to verify/provision Access, and `bun run deploy` to build and deploy via `cf deploy`. Access/DNS protection must be verified on the deployed domains; local development does not emulate Access.

The starter declares one Think-backed agent in `agents/researcher.ts` (many instance names can select independent DOs) and one simple workflow in `workflows/hello.ts`. From an Access-authenticated session on the admin hostname, `POST /api/workflows/hello/runs` with a JSON body starts a run through the protected `hello-api` entrypoint; poll `GET /api/runs/{id}` for its status. The read-only dashboard searches definitions and recent runs, shows the workflow graph, run steps/events, agent-call lineage, accepted API starts, and a scoped audit log. Its sidebar collapses on desktop; Settings provides browser-local Light/Dark/Auto appearance and read-only project details. Hono serves `/api/definitions`, `/api/agents/{agent}/calls`, `/api/triggers`, `/api/triggers/{trigger}/executions`, `/api/workflows/{workflow}/manifest`, `/api/runs`, `/api/runs/{id}`, and `/api/audit`. D1 indexes queryable run/agent-call/API-start facts while the per-run Durable Object owns authoritative run state.

Workflow tasks receive `context.callAgent(agentId, instanceName, request)` to hand requests to a named Think instance. **Only calls made through this helper** are recorded against the run and step before dispatch and updated with their HTTP outcome afterward. `hello` does not invoke `researcher`, so its runs correctly show no agent calls. Direct agent sessions, full chat/tool activity inside Think, old runs, and calls that bypass the helper have no lineage. The API-start history contains accepted requests only, from this release onward; it is not a log of rejected requests or public webhook deliveries. Settings does not change deployed project configuration. The audit index covers recorded run/step/mediated-agent transitions, not Cloudflare Access or deployment events. OpenTelemetry spans and mutation controls are not shown.

The public trigger hostname currently responds 404 to all requests: **no webhook endpoint is implemented**. Do not expose admin APIs to accept external traffic. The sample per-run coordinator executes static graph steps sequentially and retries interrupted tasks; it does not yet provide guaranteed exactly-once external effects, dynamic fan-out, deployment-safe retention of historical source bundles, or guaranteed completeness of the D1 run index. Make task side effects idempotent. This starter is not production-complete.
