#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline/promises"

const template = resolve(dirname(fileURLToPath(import.meta.url)), "../template")
const hostname = (value) => /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(value)
const projectName = (value) => /^[a-z][a-z0-9-]*$/.test(value)

export async function scaffold({ name, domain, policy, cwd = process.cwd(), ask } = {}) {
  let reader
  const prompt =
    ask ??
    (async (question) => {
      reader ??= createInterface({ input: process.stdin, output: process.stdout })
      return (await reader.question(question)).trim()
    })
  try {
    name ??= await prompt("Project name (kebab-case): ")
    domain ??= await prompt("Dashboard domain (behind Cloudflare Access): ")
    policy ??= await prompt("Existing reusable Access allow policy ID (optional; required for automated setup): ")
  } finally {
    reader?.close()
  }
  if (!projectName(name)) throw new Error("Project name must be kebab-case")
  if (!hostname(domain)) throw new Error("Provide a valid dashboard domain")
  const trigger = `triggers.${domain}`
  if (policy && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(policy))
    throw new Error("Invalid Access policy ID")
  const target = resolve(cwd, name)
  if (existsSync(target)) throw new Error(`Refusing to overwrite ${target}`)
  const replacements = { __NAME__: name, __ADMIN__: domain, __TRIGGER__: trigger, __POLICY__: policy ?? "" }
  function copy(from, to) {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(join(from, entry.name), join(to, entry.name))
      else {
        const text = readFileSync(join(from, entry.name), "utf8")
        writeFileSync(
          join(to, entry.name),
          text.replace(/__(NAME|ADMIN|TRIGGER|POLICY)__/g, (key) => replacements[key]),
        )
      }
    }
  }
  copy(template, target)
  return target
}

function runCf(args, cwd) {
  const result = spawnSync("cf", args, { cwd, encoding: "utf8", stdio: args[0] === "deploy" ? "inherit" : "pipe" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`cf ${args.join(" ")} failed: ${result.stderr || "see output above"}`)
  return result.stdout
}

export function accessApplicationFromResponse(response, domain) {
  const data = typeof response === "string" ? JSON.parse(response) : response
  const apps = Array.isArray(data) ? data : Array.isArray(data?.result) ? data.result : []
  return apps.find(
    (app) =>
      app?.domain === domain &&
      app?.type === "self_hosted" &&
      Array.isArray(app.policies) &&
      !app.policies.some((policy) => policy.decision === "bypass") &&
      app.policies.some(
        (policy) =>
          policy.decision === "allow" &&
          Array.isArray(policy.include) &&
          policy.include.length > 0 &&
          policy.include.every((selector) => !Object.hasOwn(selector, "everyone")),
      ),
  )
}

export function setup(cwd = process.cwd(), exec = runCf, create = true) {
  const config = JSON.parse(readFileSync(join(cwd, "clankwerk.json"), "utf8"))
  // An existing self-hosted application with an explicit allow policy is required.
  // Inconclusive API responses fail closed; never publish admin on a guess.
  const output = exec(
    ["zero-trust", "access", "applications", "list", "--domain", config.adminHostname, "--exact"],
    cwd,
  )
  const data = JSON.parse(output)
  const candidates = Array.isArray(data) ? data : Array.isArray(data?.result) ? data.result : []
  let matched = candidates.filter(
    (app) => app?.domain === config.adminHostname && app?.type === "self_hosted" && typeof app.id === "string",
  )
  if (!matched.length && config.accessPolicyId && create) {
    const policiesData = JSON.parse(exec(["zero-trust", "access", "policies", "list"], cwd))
    const policies = Array.isArray(policiesData) ? policiesData : (policiesData?.result ?? [])
    const policy = policies.find(
      (item) =>
        item.id === config.accessPolicyId &&
        item.reusable === true &&
        item.decision === "allow" &&
        Array.isArray(item.include) &&
        item.include.length > 0 &&
        item.include.every((selector) => !Object.hasOwn(selector, "everyone")),
    )
    if (!policy)
      throw new Error("Selected reusable Access policy is missing or does not restrict access to existing identities")
    const response = JSON.parse(
      exec(
        [
          "zero-trust",
          "access",
          "applications",
          "create",
          "--body",
          JSON.stringify({
            name: `clankwerk-${config.adminHostname}`,
            type: "self_hosted",
            domain: config.adminHostname,
            policies: [{ id: policy.id }],
          }),
        ],
        cwd,
      ),
    )
    const app = response?.result ?? response
    if (app?.id) matched = [app]
  }
  const verified = matched.some((app) => {
    const detail = JSON.parse(exec(["zero-trust", "access", "applications", "get", app.id], cwd))
    return accessApplicationFromResponse([detail?.result ?? detail], config.adminHostname)
  })
  if (!verified)
    throw new Error(
      `No verifiable Access-protected application with an explicit, non-public allow policy for ${config.adminHostname}. Configure Access before deploying.`,
    )
  return config.adminHostname
}

export function check(cwd = process.cwd(), exec = runCf) {
  return setup(cwd, exec, false)
}
export function deploy(cwd = process.cwd(), exec = runCf) {
  setup(cwd, exec)
  exec(["deploy"], cwd)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  const name = args[0]?.startsWith("--") ? undefined : args[0]
  const flag = (key) => {
    const index = args.indexOf(key)
    return index < 0 ? undefined : args[index + 1]
  }
  try {
    if (command === "new")
      console.log(`Created ${await scaffold({ name, domain: flag("--domain"), policy: flag("--access-policy") })}`)
    else if (command === "setup") console.log(`Access configured for ${setup()}`)
    else if (command === "check") console.log(`Access verified for ${check()}`)
    else if (command === "deploy") deploy()
    else {
      console.error("Usage: clankwerk new [name] [--domain hostname] [--access-policy id] | setup | check | deploy")
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
