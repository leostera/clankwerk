import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProject } from "../cli/new.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("libclank new", () => {
  it("creates a Cloudflare project with agent, task, trigger, and workflow entry points", () => {
    const directory = temporaryDirectory()
    const result = createProject({ directory, name: "My Example", version: "0.1.10" })
    const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))

    expect(result.created).toContain("agents/index.ts")
    expect(result.created).toContain("agents/assistant.ts")
    expect(result.created).toContain("tasks/say-hello.ts")
    expect(result.created).toContain("triggers/hello.ts")
    expect(result.created).toContain("workflows/hello.ts")
    expect(result.created).toContain("worker/index.ts")
    expect(result.created).toContain("worker/worker.test.ts")
    expect(result.created).toContain("worker/wrangler.jsonc")
    expect(result.created).toContain("worker/tsconfig.json")
    expect(result.created).toContain("worker/vitest.config.ts")
    expect(packageJson.name).toBe("my-example")
    expect(packageJson.devDependencies["@types/node"]).toBe("^22.10.2")
    expect(packageJson.dependencies.libclank).toBe("git+https://github.com/leostera/libclank.git#v0.1.10")
    expect(packageJson.trustedDependencies).toBeUndefined()
    expect(packageJson.scripts.dev).toContain("worker/wrangler.jsonc")
    expect(packageJson.scripts.typecheck).toContain("worker/tsconfig.json")
    expect(packageJson.scripts.test).toContain("worker/vitest.config.ts")
    expect(readFileSync(join(directory, "worker/wrangler.jsonc"), "utf8")).toContain('"main": "index.ts"')
    expect(readFileSync(join(directory, "workflows/index.ts"), "utf8")).toContain("helloWorkflow")
  })

  it("does not add an unregistered hello example to a project with its own workflow registry", () => {
    const directory = temporaryDirectory()
    const registryPath = join(directory, "workflows/index.ts")
    mkdirSync(join(directory, "workflows"), { recursive: true })
    writeFileSync(registryPath, "export const workflows = [] as const\n")

    const result = createProject({ directory, name: "existing-app", version: "0.1.10" })

    expect(readFileSync(registryPath, "utf8")).toBe("export const workflows = [] as const\n")
    expect(result.skipped).toContain("tasks/say-hello.ts (existing workflow registry)")
    expect(result.skipped).toContain("triggers/hello.ts (existing workflow registry)")
    expect(result.skipped).toContain("workflows/hello.ts (existing workflow registry)")
  })

  it("keeps existing application files and merges the manifest without replacing app configuration", () => {
    const directory = temporaryDirectory()
    mkdirSync(join(directory, "worker"), { recursive: true })
    writeFileSync(join(directory, "worker/index.ts"), "// existing worker\n")
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "existing-app",
        scripts: { dev: "vite dev" },
        dependencies: { libclank: "file:../libclank", vite: "^8.0.0" },
      }),
    )

    const result = createProject({ directory, name: "ignored-name", version: "0.1.10" })
    const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))

    expect(readFileSync(join(directory, "worker/index.ts"), "utf8")).toBe("// existing worker\n")
    expect(result.skipped).toContain("worker/index.ts")
    expect(packageJson.name).toBe("existing-app")
    expect(packageJson.dependencies.libclank).toBe("file:../libclank")
    expect(packageJson.dependencies.vite).toBe("^8.0.0")
    expect(packageJson.scripts.dev).toBe("vite dev")
    expect(packageJson.scripts.libclank).toContain("node_modules/libclank/dist/bin/libclank.js")
    expect(packageJson.trustedDependencies).toBeUndefined()
  })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "libclank-new-"))
  temporaryDirectories.push(directory)
  return directory
}
