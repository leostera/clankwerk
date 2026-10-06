# Clankwerk

Cloudflare-native, code-first agents and workflow graphs. Each scaffolded project belongs to its own Cloudflare account and deploys with Cloudflare CLI (`cf`). See [RFD0002](docs/rfds/RFD0002-clankwerk-cloudflare-native.md) for the target architecture.

## Starter (in progress)

```bash
bun install
bun packages/clankwerk/src/cli.mjs new my-clankwerk \
  --domain myclankwerk.example.com \
  --access-policy <existing-reusable-allow-policy-uuid>
cd my-clankwerk
bun install
bun run dev
# Provisions and verifies Access before the first deploy:
bun run setup
# Checks Access, then delegates to cf deploy:
bun run deploy
# Or run cf deploy directly once Access is configured.
```

Once published, use `bunx @leostera/clankwerk new` / `bunx @leostera/clankwerk deploy`. The repository also includes [`examples/clankwerk-live/`](examples/clankwerk-live/) configured for `clankwerk.leostera.dev`; its Worker, Access application, and D1 index are deployed; an authenticated `hello` run completed successfully in a live smoke test. The starter contains a Think-backed agent definition, a typed graph workflow, a per-run Durable Object coordinator for static steps, and separate admin/trigger host routing. No public webhook routes are enabled by default. Deployment checks for an existing Access application before delegating to `cf deploy`. D1 indexes runs and events for the operational API. The generated `README.md` documents its current limits; **it is not yet production-complete**.

The graph DSL and manifest builder now live directly in `packages/clankwerk`, with no `@libclank/*` dependency. Other legacy packages, examples, and manual pages remain for reference during the rewrite; they are not Clankwerk's target architecture.

## Checks

```bash
bun run typecheck
bun run test
```
