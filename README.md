# Clankwerk

Typed, code-first agents and durable workflow graphs on Cloudflare. Define Think-backed agents and workflows in TypeScript, then run them in **your own Cloudflare account**.

```text
request → workflow graph → per-run Durable Object → run and audit index
agent definition → independently stateful agent instances
```

Clankwerk runs its own workflow graphs on Workers and Durable Objects; it does not use Cloudflare Workflows. The dashboard is protected by Cloudflare Access, while a separate hostname is reserved for public triggers.

## Define a workflow

Workflow code lives in your project. This task accepts a name and returns a greeting; Clankwerk gives each run its own Durable Object for run state:

```ts
import { Clankwerk, Id, Task } from "@leostera/clankwerk"
import { Effect } from "effect"

const greet = Task.fn({
  id: Id.node("greet"),
  run: (name: string) => Effect.succeed(`Hello, ${name}!`),
})

export default Clankwerk.defineWorkflow({ id: "hello", graph: greet })
```

Agents are defined separately from their instances. A Think-backed `researcher` definition can serve multiple independently stateful named instances:

```ts
import { Think } from "@cloudflare/think"
import { Clankwerk } from "@leostera/clankwerk"

export class Researcher extends Think<Cloudflare.Env> {
  getModel() {
    return "@cf/meta/llama-4-scout-17b-16e-instruct" as const
  }
  getSystemPrompt() {
    return "You are a helpful research assistant."
  }
}

export const definition = Clankwerk.defineAgent({ id: "researcher", agent: Researcher })
```

Both examples are included in scaffolded projects. See the [getting-started guide](docs/getting-started.md) to run `hello` locally.

## User guide

- [Getting started](docs/getting-started.md) — prerequisites, local example, scaffolding, and deployment
- [Generated project guide](template/README.md) — Access setup, API routes, and current limitations

**This is an early starter, not production-ready.** `@leostera/clankwerk` is not published yet. The dashboard is minimal, and public triggers are not enabled. See the guides before deploying.

## Try the example

```sh
cd examples/clankwerk-live
bun install
bun run dev
```

Open the local URL printed by `cf dev`. To start the workflow, send a JSON string body to `/api/workflows/hello/runs` on that URL (the response contains the run ID). The [example guide](examples/clankwerk-live/README.md) explains its Cloudflare configuration and how to inspect the run. Its deployed hostnames belong to the maintainer; do not deploy it to an account you do not control.

## Repository checks

```sh
bun install
bun run typecheck
bun run test
bun run format:check
```

## Contributor documentation

The publishable `@leostera/clankwerk` package is at the repository root (`src/` and `template/`), not in a workspace. The intended architecture and unfinished work are in [RFD0002](docs/rfds/RFD0002-clankwerk-cloudflare-native.md).
