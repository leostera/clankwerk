import { DurableObject } from "cloudflare:workers"
import { Effect } from "effect"
import { getAgentByName } from "agents"
import { Id, createWorkflowManifest, type NodeId, type RunId } from "@leostera/clankwerk"
import { Researcher } from "../agents/researcher.ts"
import hello from "../workflows/hello.ts"
import { projectRun } from "./index.ts"
import { invokeRecordedAgent, type AgentCall, type AgentEvent } from "./lineage.ts"
import { createApp } from "./api.ts"

export { Researcher }

type Env = Omit<Cloudflare.Env, "RESEARCHER"> & { RESEARCHER: DurableObjectNamespace<Researcher> }

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
  origin?: { triggerId: string; kind: "api" }
  agentCalls?: AgentCall[]
  events: AgentEvent[]
}

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

  async start(workflowId: string, input: unknown, origin?: Run["origin"]): Promise<Run> {
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
      ...(origin ? { origin } : {}),
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
      const output = await Effect.runPromise(
        implementation.node.execute(step.input, {
          triggerValues: new Map(),
          runId: run.id as RunId,
          nodeId: step.id as NodeId,
          callAgent: (agentId, instanceName, request) =>
            invokeRecordedAgent(
              run,
              step.id,
              agentId,
              instanceName,
              request,
              () => this.save(run),
              async (name, forwarded) => (await getAgentByName(this.env.RESEARCHER, name)).fetch(forwarded),
            ),
        }),
      )
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

export default createApp("__ADMIN__", "__TRIGGER__", "__NAME__")
