import type { RunRecord, RunStore } from "./scheduler.js"

export type AgentCall = {
  id: string
  agentId: string
  instanceName: string
  stepId: string
  startedAt: number
  finishedAt?: number
  status: "started" | "completed" | "failed"
  httpStatus?: number
}

export interface RecordedAgentOptions {
  store: RunStore
  runId: string
  stepId: string
  leaseToken: string
  agentId: string
  instanceName: string
  request: Request
  /** Host-controlled registry checks agent identity and request route before dispatch. */
  authorize: (agentId: string, instanceName: string, request: Request) => void
  fetchAgent: (agentId: string, instanceName: string, request: Request) => Promise<Response>
  project?: (run: RunRecord) => Promise<void>
  now?: () => number
}

/** Record intent *before* calling the agent and outcome afterward; never persist request bodies. */
export async function invokeRecordedAgent(options: RecordedAgentOptions): Promise<Response> {
  const { store, runId, stepId, leaseToken, agentId, instanceName, request } = options
  options.authorize(agentId, instanceName, request)
  const now = () => options.now?.() ?? Date.now()
  const call: AgentCall = {
    id: crypto.randomUUID(),
    agentId,
    instanceName,
    stepId,
    startedAt: now(),
    status: "started",
  }
  const append = async (type: "started" | "completed" | "failed", httpStatus?: number) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const run = await store.read()
      const step = run?.steps.find((item) => item.id === stepId)
      if (!run || run.id !== runId || step?.status !== "running" || step.leaseToken !== leaseToken)
        throw new Error("Agent call no longer belongs to the active workflow step")
      if (type === "started") (run.agentCalls ??= []).push(call)
      else {
        const current = run.agentCalls?.find((item) => item.id === call.id)
        if (!current || current.status !== "started") throw new Error("Agent call receipt is missing")
        current.status = type
        current.finishedAt = now()
        current.httpStatus = httpStatus
      }
      run.events.push({ at: now(), type: `agent.${type}`, stepId, agentId })
      const expected = run.revision
      run.revision++
      if (!(await store.compareAndWrite(expected, run))) continue
      try {
        await options.project?.(run)
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "workflow.projection.failed",
            runId,
            errorType: error instanceof Error ? error.name : "unknown",
          }),
        )
      }
      return
    }
    throw new Error("Agent call receipt could not be recorded")
  }
  await append("started")
  try {
    const response = await options.fetchAgent(agentId, instanceName, request)
    await append(response.ok ? "completed" : "failed", response.status)
    return response
  } catch (error) {
    // A failed outcome write must not append a second failure event.
    const latest = await store.read()
    if (latest?.agentCalls?.find((item) => item.id === call.id)?.status === "started") await append("failed")
    throw error
  }
}
