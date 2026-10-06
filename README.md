# Clankwerk

Code-defined agents and durable workflow graphs on Cloudflare. Scaffold a project in **your own Cloudflare account**, protect its dashboard with Cloudflare Access, and deploy it with `cf`. Clankwerk uses Workers, Durable Objects, D1, and Think; it does not use Cloudflare Workflows.

> **Early starter:** `@leostera/clankwerk` is not published yet. Public triggers, the operational dashboard, and workflow recovery guarantees are still in development. Do not use this starter for production workloads.

## Create a project

Once the package is published:

```sh
bunx @leostera/clankwerk new my-clankwerk \
  --domain myclankwerk.example.com \
  --access-policy <existing-reusable-allow-policy-uuid>
cd my-clankwerk
bun install
cf auth login
bun run setup   # provision or verify the Access application
bun run dev     # local Cloudflare runtime
bun run deploy  # verify Access, then cf deploy
```

`new` derives `triggers.myclankwerk.example.com` from the dashboard domain. You need control of the domain in your Cloudflare account and an existing reusable Access **allow** policy for authorized identities; Clankwerk does not create users or identity providers. `cf` requires Node 22.18+ (Node 24 recommended). After Access has been configured, `cf deploy` also works directly, but skips the generated deployment script's protection check.

The generated project contains a Think-backed agent definition, a typed graph workflow, and a per-run Durable Object coordinator. The dashboard hostname serves admin UI/API behind Access. The separate public trigger hostname currently returns 404 for all requests: **no webhook is enabled by default**. Runs and audit events are projected into D1; agent-instance views, signed triggers, dynamic fan-out, and stronger recovery/idempotency guarantees are not implemented yet. See the generated project's README for the exact limitations.

## Try the repository checkout

The independent [live example](examples/clankwerk-live/README.md) runs against this checkout's package source without requiring a publish. It is configured for `clankwerk.leostera.dev`; use your own scaffolded project for other domains/accounts. To work on the package:

```sh
bun install
bun run typecheck
bun run test
bun run format:check
```

The publishable `@leostera/clankwerk` package lives at the repository root (`src/` and `template/`). The [architecture RFD](docs/rfds/RFD0002-clankwerk-cloudflare-native.md) separates the intended product from the current starter.
