import { existsSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { AgentTaskError } from "libclank/agent"
import { createTriggerApp } from "libclank/cloudflare"
import { Id, Task } from "libclank/core"
import { ClankerDashboard } from "libclank/ui"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))

describe("root Git distribution", () => {
  it("resolves the public runtime entry points from the built root package", () => {
    expect(Id.node()).toMatch(/^clank:node:/)
    expect(Task.fn).toBeTypeOf("function")
    expect(AgentTaskError).toBeTypeOf("function")
    expect(createTriggerApp).toBeTypeOf("function")
    expect(ClankerDashboard).toBeTypeOf("function")
  })

  it("contains the built CLI and every exported JavaScript and declaration file", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      bin: Record<string, string>
      exports: Record<string, { types: string; default: string }>
      files: string[]
      scripts: Record<string, string>
    }

    expect(manifest.files).toEqual(["dist"])
    expect(manifest.scripts.prepare).toBeUndefined()
    expect(existsSync(resolve(root, manifest.bin.libclank))).toBe(true)
    for (const entry of Object.values(manifest.exports)) {
      expect(existsSync(resolve(root, entry.types))).toBe(true)
      expect(existsSync(resolve(root, entry.default))).toBe(true)
    }
  })

  it("runs the checked-in CLI artifact without a prepare build", () => {
    const cli = resolve(root, "dist/bin/libclank.js")
    const result = spawnSync("bun", [cli, "--help"], { cwd: root, encoding: "utf8" })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LibClank")
    expect(result.stdout).toContain("libclank new")
    expect(result.stderr).toBe("")
  })

  it("typechecks consumer imports against the packaged declarations", () => {
    const result = spawnSync(
      "bun",
      [
        "run",
        "tsc",
        "--noEmit",
        "--skipLibCheck",
        "--strict",
        "--target",
        "ESNext",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--lib",
        "ESNext,DOM",
        "tests/fixtures/package-consumer.ts",
      ],
      { cwd: root, encoding: "utf8" },
    )

    expect(result.status, result.stdout + result.stderr).toBe(0)
  })
})
