import { Effect } from "effect"
import { Id, type NodeId, type RunId, type TriggerId } from "../graph/id.js"
import { createWorkflowManifest, type WorkflowManifest } from "../graph/manifest.js"
import type { ExecutionContext, NodeDefinition, StepImplementation, TriggerDefinition } from "../graph/node.js"
import type { AgentCall } from "./lineage.js"

export interface WorkflowSource {
  readonly id: string
  readonly partition?: (triggerId: string, value: unknown) => string
  readonly graph: {
    readonly definitions: readonly NodeDefinition[]
    readonly implementations: readonly StepImplementation[]
    readonly triggers: readonly TriggerDefinition[]
  }
}

export type StepRecord = {
  id: string
  status: "pending" | "ready" | "running" | "completed" | "failed"
  attempts: number
  input?: unknown
  output?: unknown
  error?: string
  /** Prevents a delayed alarm from running the same live attempt twice. */
  leaseUntil?: number
  /** An interrupted attempt cannot overwrite the result of a subsequent attempt. */
  leaseToken?: string
  readyAt?: number
}

export type RunRecord = {
  id: string
  workflowId: string
  definitionHash: string
  revision: number
  status: "running" | "completed" | "failed" | "incompatible"
  steps: StepRecord[]
  events: { at: number; type: string; stepId?: string; agentId?: string }[]
  trigger?: { id: string; key: string; value: unknown; kind?: "api" | "manual" | "webhook" | "cron" }
  agentCalls?: AgentCall[]
}

/** Atomic writes are required; run state is never coordinated by the query projection. */
export interface RunStore {
  read(): Promise<RunRecord | undefined>
  createIfAbsent(run: RunRecord): Promise<RunRecord>
  compareAndWrite(expectedRevision: number, run: RunRecord): Promise<boolean>
  schedule(at: number): Promise<void>
}

export interface SchedulerOptions {
  readonly id: string
  readonly workflows: Readonly<Record<string, WorkflowSource>>
  readonly store: RunStore
  /** Called for each step, not persisted. Credentials and bindings stay in the host. */
  readonly context?: (run: RunRecord, step: StepRecord) => Partial<ExecutionContext>
  /** Hosts may override the manifest for shared triggers or migrations. */
  readonly manifest?: (workflow: WorkflowSource) => Promise<WorkflowManifest>
  /** Query-only projection: errors must never cause a durable task to repeat. */
  readonly project?: (run: RunRecord) => Promise<void>
  readonly now?: () => number
  readonly leaseMs?: number
}

/** Executes source-defined Clankwerk tasks; the host supplies storage and capabilities, not transitions. */
export class WorkflowScheduler {
  constructor(private readonly options: SchedulerOptions) {}

  private async manifest(workflow: WorkflowSource): Promise<WorkflowManifest> {
    return (
      this.options.manifest?.(workflow) ??
      createWorkflowManifest({
        workflowId: Id.workflow(workflow.id),
        tasks: workflow.graph.definitions,
        triggers: workflow.graph.triggers,
      })
    )
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private async project(run: RunRecord): Promise<void> {
    try {
      await this.options.project?.(run)
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "workflow.projection.failed",
          runId: run.id,
          errorType: error instanceof Error ? error.name : "unknown",
        }),
      )
    }
  }

  private async update(run: RunRecord): Promise<boolean> {
    const revision = run.revision
    run.revision++
    if (!(await this.options.store.compareAndWrite(revision, run))) return false
    await this.project(run)
    return true
  }

  async start(workflowId: string, input: unknown, trigger?: RunRecord["trigger"]): Promise<RunRecord> {
    const existing = await this.options.store.read()
    if (existing) {
      // The host must use a distinct durable run ID for every event key.
      if (
        existing.workflowId !== workflowId ||
        existing.trigger?.id !== trigger?.id ||
        existing.trigger?.key !== trigger?.key
      )
        throw new Error("Run ID already belongs to a different workflow or trigger")
      return existing
    }
    const workflow = this.options.workflows[workflowId]
    if (!workflow) throw new Error("Unknown workflow")
    if (
      trigger &&
      (!workflow.graph.triggers.some((source) => source.id === trigger.id) ||
        !workflow.graph.implementations.some(
          (step) =>
            step.stepId === Id.nodeFromTrigger(trigger.id as TriggerId) ||
            (step.node.definition.kind === "trigger-selector" &&
              step.node.definition.triggerIds?.includes(trigger.id as TriggerId)),
        ))
    )
      throw new Error("Activation is not a declared executable workflow trigger")
    const graph = await this.manifest(workflow)
    if (graph.tasks.some((task) => task.kind === "fanout" || task.kind === "fanout-item"))
      throw new Error("Dynamic fan-out is not yet supported")
    const edges = graph.edges.filter((edge) => edge.kind === "dependency")
    const run: RunRecord = {
      id: this.options.id,
      workflowId,
      definitionHash: graph.definitionHash,
      revision: 0,
      status: "running",
      steps: graph.tasks.map((task) => ({
        id: task.stepId,
        status: edges.some((edge) => edge.to === task.stepId) ? "pending" : "ready",
        attempts: 0,
        input,
      })),
      events: [{ at: this.now(), type: "run.started" }],
      ...(trigger ? { trigger } : {}),
    }
    const claimed = await this.options.store.createIfAbsent(run)
    if (
      claimed.workflowId !== workflowId ||
      claimed.trigger?.id !== trigger?.id ||
      claimed.trigger?.key !== trigger?.key
    )
      throw new Error("Run ID already belongs to a different workflow or trigger")
    if (claimed === run || claimed.revision === 0) await this.project(claimed)
    await this.options.store.schedule(this.now())
    return claimed
  }

  status(): Promise<RunRecord | undefined> {
    return this.options.store.read()
  }

  async alarm(): Promise<void> {
    const run = await this.status()
    if (!run || run.status !== "running") return
    const workflow = this.options.workflows[run.workflowId]
    if (!workflow) {
      run.status = "incompatible"
      run.events.push({ at: this.now(), type: "run.incompatible" })
      await this.update(run)
      return
    }
    const graph = await this.manifest(workflow)
    if (run.definitionHash !== graph.definitionHash) {
      run.status = "incompatible"
      run.events.push({ at: this.now(), type: "run.incompatible" })
      await this.update(run)
      return
    }
    const step = run.steps.find((candidate) => candidate.status === "running" || candidate.status === "ready")
    if (!step) {
      if (run.steps.some((candidate) => candidate.status === "failed")) run.status = "failed"
      else if (run.steps.every((candidate) => candidate.status === "completed")) run.status = "completed"
      else {
        run.status = "failed"
        run.events.push({ at: this.now(), type: "run.stalled" })
      }
      run.events.push({ at: this.now(), type: `run.${run.status}` })
      await this.update(run)
      return
    }
    const task = graph.tasks.find((candidate) => candidate.stepId === step.id)
    const implementation = workflow.graph.implementations.find((candidate) => candidate.stepId === step.id)
    if (!task || !implementation) {
      run.status = "incompatible"
      run.events.push({ at: this.now(), type: "run.incompatible", stepId: step.id })
      await this.update(run)
      return
    }
    const now = this.now()
    if (step.status === "running" && step.leaseUntil && step.leaseUntil > now) {
      await this.options.store.schedule(step.leaseUntil)
      return
    }
    if (step.status === "ready" && step.readyAt && step.readyAt > now) {
      await this.options.store.schedule(step.readyAt)
      return
    }
    const token = crypto.randomUUID()
    step.status = "running"
    step.readyAt = undefined
    step.attempts++
    step.leaseUntil = now + (this.options.leaseMs ?? 120_000)
    step.leaseToken = token
    run.events.push({ at: now, type: "step.started", stepId: step.id })
    if (!(await this.update(run))) {
      await this.options.store.schedule(this.now())
      return
    }
    await this.options.store.schedule(step.leaseUntil)
    let output: unknown
    let errorName: string | undefined
    try {
      const context: ExecutionContext = {
        triggerValues: run.trigger ? new Map([[run.trigger.id as TriggerId, run.trigger.value]]) : new Map(),
        runId: run.id as RunId,
        nodeId: step.id as NodeId,
        ...this.options.context?.(run, step),
      }
      const json = JSON.stringify((await Effect.runPromise(implementation.node.execute(step.input, context))) ?? null)
      if (new TextEncoder().encode(json).byteLength > 64_000) throw new Error("Step output exceeds durable limit")
      output = JSON.parse(json)
    } catch (error) {
      // Never persist arbitrary error objects (which can contain tokens or prompts).
      errorName = error instanceof Error ? error.name : "UnknownError"
    }
    const latest = await this.status()
    const current = latest?.steps.find((candidate) => candidate.id === step.id)
    if (!latest || latest.status !== "running" || current?.status !== "running" || current.leaseToken !== token) return // A newer attempt owns this step; never overwrite it with a stale result.
    current.leaseToken = undefined
    current.leaseUntil = undefined
    if (errorName) {
      current.error = errorName
      if (current.attempts < task.retry.maxAttempts) {
        current.status = "ready"
        current.readyAt = this.now() + task.retry.backoffMs
        latest.events.push({ at: this.now(), type: "step.retry", stepId: step.id })
        if (!(await this.update(latest))) {
          await this.options.store.schedule(this.now())
          return
        }
        await this.options.store.schedule(current.readyAt)
        return
      }
      current.status = "failed"
      latest.events.push({ at: this.now(), type: "step.failed", stepId: step.id })
    } else {
      current.output = output
      current.status = "completed"
      latest.events.push({ at: this.now(), type: "step.completed", stepId: step.id })
      for (const edge of graph.edges.filter((edge) => edge.kind === "dependency" && edge.from === step.id)) {
        const dependent = latest.steps.find((candidate) => candidate.id === edge.to)
        if (!dependent || dependent.status !== "pending") continue
        const upstream = graph.edges.filter((candidate) => candidate.kind === "dependency" && candidate.to === edge.to)
        if (
          upstream.every((candidate) => latest.steps.find((item) => item.id === candidate.from)?.status === "completed")
        ) {
          dependent.input =
            upstream.length === 1
              ? current.output
              : Object.fromEntries(
                  upstream.map((candidate) => [
                    candidate.from,
                    latest.steps.find((item) => item.id === candidate.from)?.output,
                  ]),
                )
          dependent.status = "ready"
        }
      }
    }
    if (!(await this.update(latest))) {
      await this.options.store.schedule(this.now())
      return
    }
    await this.options.store.schedule(this.now())
  }
}
