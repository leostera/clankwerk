# Getting started with Clankwerk

Clankwerk puts your agent definitions, workflow graphs, and Cloudflare deployment in one project you own. A workflow run gets its own Durable Object; Think-backed agents can have multiple independently stateful instances. The current starter is **not production-ready**: signed public triggers, a full operational dashboard, and strong recovery/idempotency guarantees are still unfinished.

## Try `hello` locally (no package publish required)

Install [Bun](https://bun.sh/) and Node 22.18+ (Node 24 recommended). From this repository checkout:

```sh
cd examples/clankwerk-live
bun install
bun run dev
```

Use the local URL printed by `cf dev` for `BASE_URL` in another terminal (for example, `http://localhost:8787` if that is the printed address):

```sh
BASE_URL=http://localhost:8787
curl -sS -X POST "$BASE_URL/api/workflows/hello/runs" \
  -H 'content-type: application/json' \
  --data '"World"'
```

The response includes an `id`. Copy it to inspect the run after the alarm executes:

```sh
curl -sS "$BASE_URL/api/runs/<id>"
curl -sS "$BASE_URL/api/runs"
curl -sS "$BASE_URL/api/audit"
```

A completed run has the `Hello, World!` task output in `steps`. The local runtime is **not** a simulation of Cloudflare Access, DNS, or deployment permissions. This example's configured production hostnames belong to the maintainer; do not deploy it to a different account. See the [example README](../examples/clankwerk-live/README.md) for its configuration.

## Scaffold your own project

**`@leostera/clankwerk` has not been published yet.** The command below is the intended path after publication. Until then, use the local example above; running `new` from source creates a template whose `^0.1.0` package dependency cannot yet be installed from the registry.

```sh
bunx @leostera/clankwerk new my-clankwerk \
  --domain myclankwerk.example.com \
  --access-policy <existing-reusable-allow-policy-uuid>
cd my-clankwerk
bun install
cf auth login
bun run setup
bun run dev
bun run deploy
```

The dashboard lives at `myclankwerk.example.com` and the trigger hostname is derived as `triggers.myclankwerk.example.com`. Both must be under your Cloudflare account. You need an **existing reusable Access allow policy** that restricts access to authorized identities. Clankwerk does not create accounts, users, or identity providers. If an appropriate Access application already protects the dashboard, you can omit `--access-policy`; `setup` will verify it instead of creating one.

`bun run setup` provisions or verifies the Access application before deploying. `bun run deploy` verifies Access again and delegates to `cf deploy`. You can call `cf deploy` directly after setup, but that bypasses Clankwerk's protection check. On the deployed hostname, Cloudflare Access covers admin routes; obtain an authenticated session to use its UI or API. Local `cf dev` routes accept localhost without Access, so never treat local authorization behavior as proof that the deployed hostname is protected.

## Edit and operate

- Define a Think agent in `agents/`; each named instance has its own Durable Object state.
- Define a typed graph in `workflows/`; the starter includes `hello`, which accepts a JSON string.
- Start `hello` by POSTing to `/api/workflows/hello/runs` on the **admin** hostname. Poll `/api/runs/<id>`; `/api/runs` and `/api/audit` expose D1-backed lists.
- The separate **public trigger** hostname returns 404 for every request. Do not route unauthenticated webhooks to the admin API or assume a signature verifier exists yet.

The generated [project README](../template/README.md) documents the current operational limits. The [architecture RFD](rfds/RFD0002-clankwerk-cloudflare-native.md) describes the intended product, not a promise that every feature is implemented.
