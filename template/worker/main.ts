import { DurableObject } from "cloudflare:workers"
import { getAgentByName } from "agents"
import { Effect } from "effect"
import { Id, createWorkflowManifest } from "@leostera/clankwerk"
import { Researcher, definition as researcher } from "../agents/researcher.ts"
import hello from "../workflows/hello.ts"
import { ensureIndex, projectRun } from "./index.ts"

export { Researcher }

interface Env {
  RESEARCHER: DurableObjectNamespace<Researcher>
  RUNS: DurableObjectNamespace<WorkflowRun>
  AI: Ai
  INDEX: D1Database
}

type Step = {
  id: string
  status: "pending" | "ready" | "running" | "completed" | "failed"
  attempts: number
  input?: unknown
  output?: unknown
  error?: string
}
type Run = {
  id: string
  workflowId: string
  definitionHash: string
  status: "running" | "completed" | "failed" | "incompatible"
  steps: Step[]
  events: { at: number; type: string; stepId?: string }[]
}

const definitions = { [hello.id]: hello } as const

async function manifest() {
  return createWorkflowManifest({
    workflowId: Id.workflow(hello.id),
    tasks: hello.graph.definitions,
    triggers: hello.graph.triggers,
  })
}

export class WorkflowRun extends DurableObject<Env> {
  private async save(run: Run): Promise<void> {
    await this.ctx.storage.put("run", run)
    // The DO state remains authoritative if the query projection is temporarily unavailable.
    try {
      await projectRun(this.env.INDEX, run)
    } catch (error) {
      console.error(JSON.stringify({ type: "projection.failed", runId: run.id, error: String(error) }))
    }
  }

  async start(workflowId: string, input: unknown): Promise<Run> {
    const existing = await this.ctx.storage.get<Run>("run")
    if (existing) return existing
    if (workflowId !== hello.id) throw new Error("Unknown workflow")
    const graph = await manifest()
    // Dynamic fan-out is deliberately rejected until it can be materialized durably.
    if (graph.tasks.some((task) => task.kind === "fanout" || task.kind === "fanout-item"))
      throw new Error("Dynamic fan-out is not yet supported")
    const tasks = graph.tasks
    const edges = graph.edges.filter((edge) => edge.kind === "dependency")
    const steps: Step[] = tasks.map((task) => ({
      id: task.stepId,
      status: edges.some((edge) => edge.to === task.stepId) ? "pending" : "ready",
      attempts: 0,
      input,
    }))
    const run: Run = {
      id: this.ctx.id.toString(),
      workflowId,
      definitionHash: graph.definitionHash,
      status: "running",
      steps,
      events: [{ at: Date.now(), type: "run.started" }],
    }
    await this.save(run)
    await this.ctx.storage.setAlarm(Date.now())
    return run
  }

  async status(): Promise<Run | undefined> {
    return this.ctx.storage.get<Run>("run")
  }

  async alarm(): Promise<void> {
    const run = await this.status()
    if (!run || run.status !== "running") return
    const graph = await manifest()
    if (run.definitionHash !== graph.definitionHash) {
      run.status = "incompatible"
      run.events.push({ at: Date.now(), type: "run.incompatible" })
      await this.save(run)
      return
    }
    // A running step means a previous invocation was interrupted. Retrying may
    // repeat external side effects: tasks must be idempotent until fencing lands.
    const step = run.steps.find((candidate) => candidate.status === "running" || candidate.status === "ready")
    if (!step) {
      if (run.steps.some((candidate) => candidate.status === "failed")) run.status = "failed"
      else if (run.steps.every((candidate) => candidate.status === "completed")) run.status = "completed"
      else {
        run.status = "failed" // invalid/cyclic graph, not a successful run
        run.events.push({ at: Date.now(), type: "run.stalled" })
      }
      run.events.push({ at: Date.now(), type: `run.${run.status}` })
      await this.save(run)
      return
    }
    const task = graph.tasks.find((candidate) => candidate.stepId === step.id)
    const implementation = hello.graph.implementations.find((candidate) => candidate.stepId === step.id)
    if (!task || !implementation) {
      run.status = "incompatible"
      run.events.push({ at: Date.now(), type: "run.incompatible", stepId: step.id })
      await this.save(run)
      return
    }
    step.status = "running"
    step.attempts++
    run.events.push({ at: Date.now(), type: "step.started", stepId: step.id })
    await this.save(run)
    await this.ctx.storage.setAlarm(Date.now() + 60_000)
    try {
      const output = await Effect.runPromise(implementation.node.execute(step.input))
      // Persist only JSON data, never source closures or unserializable outputs.
      step.output = JSON.parse(JSON.stringify(output ?? null))
      step.status = "completed"
      run.events.push({ at: Date.now(), type: "step.completed", stepId: step.id })
      for (const edge of graph.edges.filter((edge) => edge.kind === "dependency" && edge.from === step.id)) {
        const dependent = run.steps.find((candidate) => candidate.id === edge.to)
        if (!dependent || dependent.status !== "pending") continue
        const upstream = graph.edges.filter((candidate) => candidate.kind === "dependency" && candidate.to === edge.to)
        if (
          upstream.every((candidate) => run.steps.find((item) => item.id === candidate.from)?.status === "completed")
        ) {
          dependent.input =
            upstream.length === 1
              ? step.output
              : Object.fromEntries(
                  upstream.map((candidate) => [
                    candidate.from,
                    run.steps.find((item) => item.id === candidate.from)?.output,
                  ]),
                )
          dependent.status = "ready"
        }
      }
    } catch (error) {
      step.error = String(error)
      if (step.attempts < task.retry.maxAttempts) {
        step.status = "ready"
        run.events.push({ at: Date.now(), type: "step.retry", stepId: step.id })
        await this.save(run)
        await this.ctx.storage.setAlarm(Date.now() + task.retry.backoffMs)
        return
      }
      step.status = "failed"
      run.events.push({ at: Date.now(), type: "step.failed", stepId: step.id })
    }
    await this.save(run)
    await this.ctx.storage.setAlarm(Date.now())
  }
}

const admin = "__ADMIN__"
const triggers = "__TRIGGER__"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.hostname === triggers) return new Response("Not found", { status: 404 })
    if (url.hostname !== admin && !["localhost", "127.0.0.1"].includes(url.hostname))
      return new Response("Not found", { status: 404 })
    if (url.pathname === "/api/definitions" && request.method === "GET")
      return Response.json({ agents: [researcher.id], workflows: [hello.id], triggers: [] })
    if (url.pathname === "/api/runs" && request.method === "GET") {
      await ensureIndex(env.INDEX)
      const rows = await env.INDEX.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 50").all()
      return Response.json(rows.results)
    }
    if (url.pathname === "/api/audit" && request.method === "GET") {
      await ensureIndex(env.INDEX)
      const rows = await env.INDEX.prepare("SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT 100").all()
      return Response.json(rows.results)
    }
    const start = /^\/api\/workflows\/([^/]+)\/runs$/.exec(url.pathname)
    if (start && request.method === "POST") {
      if (start[1] !== hello.id) return new Response("Not found", { status: 404 })
      if (Number(request.headers.get("content-length")) > 65_536) return new Response("Too large", { status: 413 })
      let input: unknown
      try {
        const reader = request.body?.getReader()
        if (!reader) throw new Error("Missing body")
        const chunks: Uint8Array[] = []
        let size = 0
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 65_536) {
            await reader.cancel()
            return new Response("Too large", { status: 413 })
          }
          chunks.push(value)
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        input = JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        return new Response("Invalid JSON", { status: 400 })
      }
      const id = env.RUNS.newUniqueId()
      return Response.json(await env.RUNS.get(id).start(hello.id, input), { status: 202 })
    }
    const status = /^\/api\/runs\/([0-9a-f-]+)$/.exec(url.pathname)
    if (status && request.method === "GET") {
      try {
        const run = await env.RUNS.get(env.RUNS.idFromString(status[1])).status()
        return run ? Response.json(run) : new Response("Not found", { status: 404 })
      } catch {
        return new Response("Not found", { status: 404 })
      }
    }
    if (url.pathname.startsWith("/agents/researcher/") && url.pathname.split("/").length >= 4) {
      const name = url.pathname.split("/")[3]
      if (!name || name.length > 128) return new Response("Invalid instance", { status: 400 })
      return (await getAgentByName(env.RESEARCHER, name)).fetch(request)
    }
    if (url.pathname !== "/" || request.method !== "GET") return new Response("Not found", { status: 404 })
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Clankwerk</title>
      <main><h1>Clankwerk</h1><h2>Agents</h2><p>${researcher.id}</p>
      <h2>Workflows</h2><p>${hello.id}</p><p>Run via POST /api/workflows/${hello.id}/runs; inspect via GET /api/runs/:id.</p></main></html>`,
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    )
  },
}
