import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

export interface NewProjectOptions {
  readonly directory: string
  readonly name?: string
  readonly version: string
}

export interface NewProjectResult {
  readonly created: readonly string[]
  readonly skipped: readonly string[]
}

const files: Readonly<Record<string, string>> = {
  "README.md": `# __PROJECT_NAME__

A Bun + Cloudflare Worker application organized around LibClank agents, tasks, workflows, and triggers.

## Get started

\`\`\`sh
bun install
bun run dev
\`\`\`

The example webhook is available at \`POST /api/hello\`. The starter uses LibClank's eager in-memory scheduler: it is useful for getting started, but does not persist runs across Worker restarts. Use a durable scheduler/runtime before relying on persistent execution.

## Project layout

- \`agents/\` — application-owned AgentEndpoint adapters and agent-task helpers.
- \`tasks/\` — reusable units of work.
- \`triggers/\` — webhook, manual, and scheduled workflow inputs.
- \`workflows/\` — workflow compositions and workflow registry.
- \`worker/\` — Worker entrypoint, Wrangler config, tests, TypeScript/Vitest config, and generated binding types.

Add new files in those root-level directories, then register each workflow in \`workflows/index.ts\`.

## Commands

- \`bun run dev\` — run the Worker locally.
- \`bun run typecheck\` — check TypeScript.
- \`bun run test\` — run tests.
- \`bun run deploy\` — deploy with Wrangler.
- \`bun run libclank new <directory>\` — scaffold another project.

Keep credentials in Worker secrets or bindings, not in source control. External side effects may be retried; make them idempotent where needed.
`,
  "agents/index.ts": `/** Application-owned agent adapters and helpers live in this directory. */
export type { AgentEndpoint, AgentTaskRequest, AgentTaskResponse } from "libclank/agent"
`,
  "agents/assistant.ts": `import { Task, type AgentEndpoint } from "libclank/agent"
import { Id } from "libclank/core"

export interface AssistantInput {
  readonly prompt: string
}

export interface AssistantOutput {
  readonly response: string
}

/** Supply a provider-backed endpoint from your app's bindings or configuration. */
export const createAssistantTask = (endpoint: AgentEndpoint) =>
  Task.agent<AssistantInput, AssistantOutput>({
    id: Id.node(),
    instructions: "Answer the user's prompt clearly and concisely.",
    endpoint,
  })
`,
  "tasks/say-hello.ts": `import { Effect } from "effect"
import { Id, Task } from "libclank/core"
import type { HelloInput } from "../triggers/hello.js"

export interface HelloOutput {
  readonly message: string
}

export const sayHello = Task.fn<HelloInput, HelloOutput>({
  id: Id.task("say-hello"),
  description: "Create a friendly greeting",
  run: ({ name }) => Effect.succeed({ message: \`Hello, \${name?.trim() || "friend"}!\` }),
})
`,
  "triggers/hello.ts": `import { Id, Triggers } from "libclank/core"

export interface HelloInput {
  readonly name?: string
}

export const helloReceived = Triggers.webhook<HelloInput>({
  id: Id.trigger("hello"),
  path: "/api/hello",
  decode: async (request) => (await request.json()) as HelloInput,
})
`,
  "workflows/hello.ts": `import { sayHello } from "../tasks/say-hello.js"
import { helloReceived } from "../triggers/hello.js"

export const helloWorkflow = helloReceived.then(sayHello)
`,
  "workflows/index.ts": `import { helloWorkflow } from "./hello.js"

export const workflows = [helloWorkflow] as const
`,
  "worker/index.ts": `import { createTriggerApp } from "libclank/cloudflare"
import { createScheduler, SchedulerObservers } from "libclank/core"
import { workflows } from "../workflows/index.js"

const api = createTriggerApp(
  createScheduler({
    workflows,
    observer: SchedulerObservers.noop,
  }),
)

export default {
  async fetch(request: Request): Promise<Response> {
    return api.fetch(request)
  },
}
`,
  "worker/worker.test.ts": `import { describe, expect, it } from "vitest"
import worker from "./index.js"

describe("Worker", () => {
  it("runs the hello workflow", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/hello", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      runs: [{ status: "completed", output: { message: "Hello, Ada!" } }],
    })
  })
})
`,
  "worker/vitest.config.ts": `import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["**/*.test.ts"],
  },
})
`,
  "worker/tsconfig.json": `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext", "DOM"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["../agents/**/*.ts", "../tasks/**/*.ts", "../triggers/**/*.ts", "../workflows/**/*.ts", "**/*.ts"]
}
`,
  "worker/wrangler.jsonc": `{
  "$schema": "../node_modules/wrangler/config-schema.json",
  "name": "__WORKER_NAME__",
  "main": "index.ts",
  "compatibility_date": "__DATE__",
  "workers_dev": true,
  "observability": {
    "enabled": true,
    "logs": { "enabled": true, "head_sampling_rate": 1 },
    "traces": { "enabled": true, "head_sampling_rate": 0.1 }
  }
}
`,
}

const exampleWorkflowFiles = new Set(["tasks/say-hello.ts", "triggers/hello.ts", "workflows/hello.ts"])

const defaultScripts = {
  dev: "wrangler dev --config worker/wrangler.jsonc",
  deploy: "wrangler deploy --config worker/wrangler.jsonc",
  typecheck:
    "wrangler types worker/worker-configuration.d.ts --config worker/wrangler.jsonc && tsc --project worker/tsconfig.json --noEmit",
  test: "vitest run --config worker/vitest.config.ts",
  libclank: "bun ./node_modules/libclank/dist/bin/libclank.js",
}

export function createProject(options: NewProjectOptions): NewProjectResult {
  const directory = resolve(options.directory)
  const name = normalizeName(options.name ?? basename(directory))
  const replacements: Record<string, string> = {
    __PROJECT_NAME__: name,
    __WORKER_NAME__: name,
    __DATE__: new Date().toISOString().slice(0, 10),
  }
  const created: string[] = []
  const skipped: string[] = []
  const hasWorkflowRegistry = existsSync(join(directory, "workflows/index.ts"))

  mkdirSync(directory, { recursive: true })

  for (const [relativePath, source] of Object.entries(files)) {
    const destination = join(directory, relativePath)
    if (hasWorkflowRegistry && exampleWorkflowFiles.has(relativePath) && !existsSync(destination)) {
      skipped.push(`${relativePath} (existing workflow registry)`)
      continue
    }
    if (existsSync(destination)) {
      skipped.push(relativePath)
      continue
    }
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, replaceTokens(source, replacements))
    created.push(relativePath)
  }

  const manifestPath = join(directory, "package.json")
  if (existsSync(manifestPath)) {
    mergePackageJson(manifestPath, name, options.version, created, skipped)
  } else {
    const manifest = createPackageJson(name, options.version)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    created.push("package.json")
  }

  return { created, skipped }
}

function createPackageJson(name: string, version: string) {
  return {
    name,
    private: true,
    type: "module",
    packageManager: "bun@1.4.2",
    scripts: defaultScripts,
    dependencies: {
      effect: "4.0.0-rc.116",
      libclank: `git+https://github.com/leostera/libclank.git#v${version}`,
    },
    devDependencies: {
      "@types/node": "^22.10.2",
      typescript: "^5.7.2",
      vitest: "^4.1.0",
      wrangler: "^4.136.0",
    },
  }
}

function mergePackageJson(
  manifestPath: string,
  name: string,
  version: string,
  created: string[],
  skipped: string[],
): void {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  let changed = false

  if (manifest.name === undefined) {
    manifest.name = name
    changed = true
  }
  if (manifest.type === undefined) {
    manifest.type = "module"
    changed = true
  }
  if (manifest.packageManager === undefined) {
    manifest.packageManager = "bun@1.4.2"
    changed = true
  }

  const dependencies = objectProperty(manifest, "dependencies")
  if (dependencies.libclank === undefined) {
    dependencies.libclank = `git+https://github.com/leostera/libclank.git#v${version}`
    changed = true
  }
  if (dependencies.effect === undefined) {
    dependencies.effect = "4.0.0-rc.116"
    changed = true
  }

  const devDependencies = objectProperty(manifest, "devDependencies")
  for (const [key, versionRange] of Object.entries({
    "@types/node": "^22.10.2",
    typescript: "^5.7.2",
    vitest: "^4.1.0",
    wrangler: "^4.136.0",
  })) {
    if (devDependencies[key] === undefined) {
      devDependencies[key] = versionRange
      changed = true
    }
  }

  const scripts = objectProperty(manifest, "scripts")
  for (const [key, command] of Object.entries(defaultScripts)) {
    if (scripts[key] === undefined) {
      scripts[key] = command
      changed = true
    }
  }

  if (changed) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    created.push("package.json (updated)")
  } else {
    skipped.push("package.json (already configured)")
  }
}

function objectProperty(parent: Record<string, unknown>, key: string): Record<string, string> {
  const current = parent[key]
  if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) {
    throw new Error(`Cannot scaffold project: package.json ${key} must be an object`)
  }
  if (current === undefined) parent[key] = {}
  return parent[key] as Record<string, string>
}

function normalizeName(value: string): string {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!name) throw new Error("Project name must contain at least one letter or number")
  return name
}

function replaceTokens(source: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce((result, [token, value]) => result.replaceAll(token, value), source)
}
