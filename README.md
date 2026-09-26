# LibClank

Typed, code-first agentic workflows with durable local execution and an operational dashboard.

Define workflows in TypeScript with Effect. LibClank persists runs, task instances, dependencies, attempts, outputs, artifacts, leases, and events—not JavaScript closures.

```text
webhook
  → fetch source
    → analyze topic
    → analyze style
    → analyze confidence
```

## User manual

Start with the [LibClank Manual](manual/README.md):

- [Getting started](manual/01-getting-started.md)
- [Authoring workflows](manual/03-authoring-workflows.md)
- [Local durable runtime](manual/04-local-durable-runtime.md)
- [Agent tasks and artifacts](manual/05-agent-tasks-and-artifacts.md)
- [Dashboard and operations](manual/06-dashboard-and-operations.md)
- [Testing your workflows](manual/07-testing.md)
- [Cloudflare and deployment](manual/08-cloudflare-and-deployment.md)
- [Reference and limitations](manual/10-reference-and-limitations.md)

## What LibClank code looks like

A workflow is ordinary typed TypeScript. A trigger produces input, named tasks transform it, and composition describes the graph:

```ts
import { Effect } from "effect"
import { Id, Task, Triggers } from "@libclank/core"

const urlReceived = Triggers.webhook<{ url: string }>({
  id: Id.trigger("url-received"),
  path: "/hooks/url",
})

const fetchTitle = Task.fn<{ url: string }, { title: string }>({
  id: Id.task("fetch-title"),
  run: ({ url }) => Effect.succeed({ title: `Title for ${url}` }),
})

const workflow = urlReceived.then(fetchTitle).fanout({
  summary: Task.fn({
    id: Id.task("write-summary"),
    run: ({ title }: { title: string }) => Effect.succeed(title.toLowerCase()),
  }),
  keywords: Task.fn({
    id: Id.task("extract-keywords"),
    run: ({ title }: { title: string }) => Effect.succeed(title.split(" ")),
  }),
})
```

Run that same workflow durably with local SQLite and a Hono trigger app:

```ts
import { createTriggerApp } from "@libclank/cloudflare"
import { SchedulerObservers } from "@libclank/core"
import { createLocalSchedulerDatabase } from "@libclank/local"
import { createDurableScheduler } from "@libclank/scheduler"

const scheduler = await createDurableScheduler({
  workflows: [workflow],
  database: createLocalSchedulerDatabase(),
  observer: SchedulerObservers.noop,
})

Bun.serve({ port: 8789, fetch: createTriggerApp(scheduler).fetch })
```

The scheduler persists workflow metadata, node instances, inputs, outputs, attempts, and events in `.clank/scheduler.sqlite`. See [Getting started](manual/01-getting-started.md) for schemas, validation, and a complete executable example.

## Install LibClank from GitHub

LibClank is available as a built Bun package directly from its public GitHub repository. Add a versioned tag over HTTPS:

```bash
bun add "git+https://github.com/leostera/libclank.git#v0.1.9"
```

Import the supported package entry points explicitly:

```ts
import { Id, Task, Triggers } from "libclank/core"
import { createTriggerApp } from "libclank/cloudflare"
```

The repository tracks its built CLI, JavaScript API, declarations, and dashboard under root `dist/`, so Git installs do not need a lifecycle build or registry access. Keep consumer lockfiles committed so deployments stay pinned to the resolved commit behind the tag. React and React DOM are peer dependencies for `libclank/ui`; install them in apps that use that entry point.

LibClank requires Bun 1.4.2 or newer. For contributors developing both repositories, a local `file:../libclank` dependency remains useful; applications intended to install independently should use a version tag as above.

## Scaffold an application

From an existing LibClank application, use the installed CLI:

```bash
bun run libclank new ../my-worker
```

Or run the CLI directly from the public GitHub repository without adding LibClank to the current project:

```bash
bunx https://github.com/leostera/libclank.git new ../my-worker
```

The command adds missing files without replacing existing application code. It creates root-level `agents/`, `tasks/`, `triggers/`, and `workflows/` directories, including an Agent task factory that accepts an application-owned `AgentEndpoint`, plus a `worker/` directory for the Worker entrypoint, Wrangler/Vitest/TypeScript config, tests, and Bun scripts. The example uses the eager in-memory scheduler; choose a durable runtime before relying on persisted runs.

## Try an example

LibClank uses Bun 1.4.2 (declared in `package.json` and locked by `bun.lock`).

```bash
bun install --frozen-lockfile
bun run example:parallel-analyses
```

Then open <http://localhost:8789/>.

The parallel-analysis example uses local SQLite, Pi-backed agent tasks, a run graph, and persisted logs. It requires Pi to be installed and authenticated.

## Repository checks

```bash
bun run format:check
bun run typecheck
bun run build
bun run test
```

## Deploy the example applications

```bash
bun run --filter @libclank/app-agent exec wrangler deploy
bun run --filter @libclank/app-scheduler exec wrangler deploy
```

## Contributor documentation

Architecture, implementation rationale, and roadmap material live in [`docs/rfds/`](docs/rfds/), beginning with [RFD0001](docs/rfds/RFD0001-libclank-design.md).
