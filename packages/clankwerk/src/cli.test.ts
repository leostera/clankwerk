import { test, expect } from "vitest"
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scaffold, deploy, setup, check, accessApplicationFromResponse } from "./cli.mjs"

const admin = "admin.example.com"
const trigger = `triggers.${admin}`
const policyId = "d9836d7c-02f2-4e5b-b0b2-9e0c384b24de"
const app = { id: "app-1", domain: admin, type: "self_hosted" }
const protectedApp = {
  ...app,
  policies: [{ decision: "allow", include: [{ email_domain: { domain: "example.com" } }] }],
}

async function project(policy = "") {
  const cwd = mkdtempSync(join(tmpdir(), "clankwerk-"))
  const path = await scaffold({ cwd, name: "example", domain: admin, policy })
  return { cwd, path }
}

test("scaffold distinct hosts and refuse overwrite", async () => {
  const { cwd, path } = await project()
  try {
    expect(JSON.parse(readFileSync(join(path, "clankwerk.json"), "utf8"))).toEqual({
      adminHostname: admin,
      triggerHostname: trigger,
      accessPolicyId: "",
    })
    const config = readFileSync(join(path, "cloudflare.config.ts"), "utf8")
    expect(config).toContain("workersDev: false")
    expect(config).toContain("runWorkerFirst: true")
    const entry = readFileSync(join(path, "worker/main.ts"), "utf8")
    expect(entry).toContain(`createApp("${admin}", "${trigger}", "example")`)
    const api = readFileSync(join(path, "worker/api.ts"), "utf8")
    expect(api).toContain("new Hono<{ Bindings: Bindings }>()")
    expect(api).toContain('app.get("/api/workflows/:workflow/manifest"')
    expect(api).toContain('app.get("/api/agents/:agent/calls"')
    expect(api).toContain('app.get("/api/triggers/:trigger/executions"')
    expect(api).toContain('url.pathname === "/settings"')
    expect(api).toContain('url.pathname === "/agents"')
    expect(api).toContain("if (host === triggers")
    expect(readFileSync(join(path, "index.html"), "utf8")).toContain("/dashboard/main.tsx")
    const dashboard = readFileSync(join(path, "dashboard/main.tsx"), "utf8")
    expect(dashboard).toContain("Audit log")
    expect(dashboard).toContain("WorkflowGraph")
    expect(dashboard).toContain("Quick search")
    expect(dashboard).toContain("Results for")
    expect(dashboard).toContain("clankwerk.theme")
    expect(dashboard).toContain("Collapse sidebar")
    expect(entry).toContain('from "@leostera/clankwerk/runtime"')
    expect(readFileSync(join(path, "triggers/manual.ts"), "utf8")).toContain("Triggers.manual")
    const dependencies = JSON.parse(readFileSync(join(path, "package.json"), "utf8")).dependencies
    expect(dependencies).toHaveProperty("hono")
    expect(dependencies).toHaveProperty("react")
    await expect(scaffold({ cwd, name: "example", domain: admin, policy: "" })).rejects.toThrow("overwrite")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("deploy requires exact Access application with a non-public policy", async () => {
  const { cwd, path } = await project()
  try {
    const commands: string[][] = []
    deploy(path, (args) => {
      commands.push(args)
      return JSON.stringify(args.includes("get") ? protectedApp : [app])
    })
    expect(commands.at(-1)).toEqual(["deploy"])
    expect(() => deploy(path, (args) => JSON.stringify(args.includes("get") ? app : [app]))).toThrow(
      "No verifiable Access",
    )
    expect(
      accessApplicationFromResponse(
        [{ ...protectedApp, policies: [{ decision: "allow", include: [{ everyone: {} }] }] }],
        admin,
      ),
    ).toBeUndefined()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("deploy provisions an Access app using only an existing reusable allow policy", async () => {
  const { cwd, path } = await project(policyId)
  try {
    const commands: string[][] = []
    deploy(path, (args) => {
      commands.push(args)
      if (args.includes("list") && args.includes("applications")) return "[]"
      if (args.includes("list") && args.includes("policies"))
        return JSON.stringify([
          { id: policyId, decision: "allow", reusable: true, include: [{ email: { email: "owner@example.com" } }] },
        ])
      if (args.includes("create")) return JSON.stringify(app)
      if (args.includes("get")) return JSON.stringify(protectedApp)
      return ""
    })
    const body = JSON.parse(commands.find((args) => args.includes("create"))!.at(-1)!)
    expect(body).toMatchObject({ domain: admin, policies: [{ id: policyId }] })
    expect(commands.at(-1)).toEqual(["deploy"])
    commands.length = 0
    setup(path, (args) => {
      commands.push(args)
      if (args.includes("list") && args.includes("applications")) return "[]"
      if (args.includes("list") && args.includes("policies"))
        return JSON.stringify([
          { id: policyId, decision: "allow", reusable: true, include: [{ email: { email: "owner@example.com" } }] },
        ])
      return JSON.stringify(args.includes("create") ? app : protectedApp)
    })
    expect(commands.some((args) => args.includes("deploy"))).toBe(false)
    expect(() => check(path, (args) => JSON.stringify(args.includes("list") ? [] : protectedApp))).toThrow(
      "No verifiable Access",
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("packaged executable runs through a symlink", () => {
  const cwd = mkdtempSync(join(tmpdir(), "clankwerk-bin-"))
  try {
    const link = join(cwd, "clankwerk")
    symlinkSync(fileURLToPath(new URL("./cli.mjs", import.meta.url)), link)
    const result = spawnSync(
      process.execPath,
      [link, "new", "demo", "--domain", "admin.example.com", "--access-policy", policyId],
      { cwd, encoding: "utf8" },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Created")
    expect(JSON.parse(readFileSync(join(cwd, "demo", "clankwerk.json"), "utf8")).triggerHostname).toBe(
      "triggers.admin.example.com",
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("reject invalid dashboard domain", async () => {
  await expect(scaffold({ name: "example", domain: "not-a-domain", policy: "" })).rejects.toThrow(
    "valid dashboard domain",
  )
})
