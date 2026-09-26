#!/usr/bin/env bun
// @bun

// bin/libclank.ts
import { basename as basename2, resolve as resolve2 } from "path";

// cli/new.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
var files = {
  "README.md": `# __PROJECT_NAME__

A Bun + Cloudflare Worker application organized around LibClank agents, tasks, workflows, and triggers.

## Get started

\`\`\`sh
bun install
bun run dev
\`\`\`

The example webhook is available at \`POST /api/hello\`. The starter uses LibClank's eager in-memory scheduler: it is useful for getting started, but does not persist runs across Worker restarts. Use a durable scheduler/runtime before relying on persistent execution.

## Project layout

- \`agents/\` \u2014 application-owned AgentEndpoint adapters and agent-task helpers.
- \`tasks/\` \u2014 reusable units of work.
- \`triggers/\` \u2014 webhook, manual, and scheduled workflow inputs.
- \`workflows/\` \u2014 workflow compositions and workflow registry.
- \`worker/\` \u2014 Worker entrypoint, Wrangler config, tests, TypeScript/Vitest config, and generated binding types.

Add new files in those root-level directories, then register each workflow in \`workflows/index.ts\`.

## Commands

- \`bun run dev\` \u2014 run the Worker locally.
- \`bun run typecheck\` \u2014 check TypeScript.
- \`bun run test\` \u2014 run tests.
- \`bun run deploy\` \u2014 deploy with Wrangler.
- \`bun run libclank new <directory>\` \u2014 scaffold another project.

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
`
};
var exampleWorkflowFiles = new Set(["tasks/say-hello.ts", "triggers/hello.ts", "workflows/hello.ts"]);
var defaultScripts = {
  dev: "wrangler dev --config worker/wrangler.jsonc",
  deploy: "wrangler deploy --config worker/wrangler.jsonc",
  typecheck: "wrangler types worker/worker-configuration.d.ts --config worker/wrangler.jsonc && tsc --project worker/tsconfig.json --noEmit",
  test: "vitest run --config worker/vitest.config.ts",
  libclank: "bun ./node_modules/libclank/dist/bin/libclank.js"
};
function createProject(options) {
  const directory = resolve(options.directory);
  const name = normalizeName(options.name ?? basename(directory));
  const replacements = {
    __PROJECT_NAME__: name,
    __WORKER_NAME__: name,
    __DATE__: new Date().toISOString().slice(0, 10)
  };
  const created = [];
  const skipped = [];
  const hasWorkflowRegistry = existsSync(join(directory, "workflows/index.ts"));
  mkdirSync(directory, { recursive: true });
  for (const [relativePath, source] of Object.entries(files)) {
    const destination = join(directory, relativePath);
    if (hasWorkflowRegistry && exampleWorkflowFiles.has(relativePath) && !existsSync(destination)) {
      skipped.push(`${relativePath} (existing workflow registry)`);
      continue;
    }
    if (existsSync(destination)) {
      skipped.push(relativePath);
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, replaceTokens(source, replacements));
    created.push(relativePath);
  }
  const manifestPath = join(directory, "package.json");
  if (existsSync(manifestPath)) {
    mergePackageJson(manifestPath, name, options.version, created, skipped);
  } else {
    const manifest = createPackageJson(name, options.version);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}
`);
    created.push("package.json");
  }
  return { created, skipped };
}
function createPackageJson(name, version) {
  return {
    name,
    private: true,
    type: "module",
    packageManager: "bun@1.4.2",
    scripts: defaultScripts,
    dependencies: {
      effect: "4.0.0-rc.116",
      libclank: `git+https://github.com/leostera/libclank.git#v${version}`
    },
    devDependencies: {
      typescript: "^5.7.2",
      vitest: "^4.1.0",
      wrangler: "^4.136.0"
    }
  };
}
function mergePackageJson(manifestPath, name, version, created, skipped) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let changed = false;
  if (manifest.name === undefined) {
    manifest.name = name;
    changed = true;
  }
  if (manifest.type === undefined) {
    manifest.type = "module";
    changed = true;
  }
  if (manifest.packageManager === undefined) {
    manifest.packageManager = "bun@1.4.2";
    changed = true;
  }
  const dependencies = objectProperty(manifest, "dependencies");
  if (dependencies.libclank === undefined) {
    dependencies.libclank = `git+https://github.com/leostera/libclank.git#v${version}`;
    changed = true;
  }
  if (dependencies.effect === undefined) {
    dependencies.effect = "4.0.0-rc.116";
    changed = true;
  }
  const devDependencies = objectProperty(manifest, "devDependencies");
  for (const [key, versionRange] of Object.entries({ typescript: "^5.7.2", vitest: "^4.1.0", wrangler: "^4.136.0" })) {
    if (devDependencies[key] === undefined) {
      devDependencies[key] = versionRange;
      changed = true;
    }
  }
  const scripts = objectProperty(manifest, "scripts");
  for (const [key, command] of Object.entries(defaultScripts)) {
    if (scripts[key] === undefined) {
      scripts[key] = command;
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}
`);
    created.push("package.json (updated)");
  } else {
    skipped.push("package.json (already configured)");
  }
}
function objectProperty(parent, key) {
  const current = parent[key];
  if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) {
    throw new Error(`Cannot scaffold project: package.json ${key} must be an object`);
  }
  if (current === undefined)
    parent[key] = {};
  return parent[key];
}
function normalizeName(value) {
  const name = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name)
    throw new Error("Project name must contain at least one letter or number");
  return name;
}
function replaceTokens(source, replacements) {
  return Object.entries(replacements).reduce((result, [token, value]) => result.replaceAll(token, value), source);
}
// package.json
var version = "0.1.9";

// bin/libclank.ts
var [command, ...args] = process.argv.slice(2);
if (command === "--help" || command === "-h" || command === undefined || args.includes("--help")) {
  printHelp();
  process.exit(0);
}
if (command !== "new") {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
try {
  let directory = ".";
  let name;
  for (let index = 0;index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--name") {
      name = args[index + 1];
      if (!name || name.startsWith("--"))
        throw new Error("--name requires a project name");
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      directory = argument;
    }
  }
  const target = resolve2(directory);
  name ??= basename2(target);
  const result = createProject({ directory: target, name, version });
  console.log(`Initialized LibClank project in ${target}`);
  for (const path of result.created)
    console.log(`  + ${path}`);
  for (const path of result.skipped)
    console.log(`  - kept ${path}`);
  console.log(`
Next steps:`);
  console.log(`  cd ${target}`);
  console.log("  bun install");
  console.log("  bun run dev");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
function printHelp() {
  console.log(`LibClank ${version}

Usage:
  libclank new [directory] [--name <project-name>]

Scaffolds a Bun + Cloudflare Worker project with agents, tasks, triggers,
and workflows. Existing files are kept; only missing starter files are added.`);
}
