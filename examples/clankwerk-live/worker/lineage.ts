// A workflow-to-agent link exists only when this mediated call actually runs.
// Persist the intent before dispatch and its outcome afterward in the run DO.
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
export type AgentEvent = { at: number; type: string; stepId?: string; agentId?: string }

export async function invokeRecordedAgent(
  run: { agentCalls?: AgentCall[]; events: AgentEvent[] },
  stepId: string,
  agentId: string,
  instanceName: string,
  request: Request,
  save: () => Promise<void>,
  fetchAgent: (name: string, request: Request) => Promise<Response>,
): Promise<Response> {
  if (agentId !== "researcher" || !instanceName || instanceName.length > 128)
    throw new Error("Unknown agent or invalid instance")
  const route = `/agents/researcher/${encodeURIComponent(instanceName)}`
  const path = new URL(request.url).pathname
  if (path !== route && !path.startsWith(`${route}/`)) throw new Error("Agent request path mismatch")
  const call: AgentCall = {
    id: crypto.randomUUID(),
    agentId,
    instanceName,
    stepId,
    startedAt: Date.now(),
    status: "started",
  }
  run.agentCalls ??= []
  run.agentCalls.push(call)
  run.events.push({ at: call.startedAt, type: "agent.started", stepId, agentId })
  await save()
  try {
    const response = await fetchAgent(instanceName, request)
    call.status = response.ok ? "completed" : "failed"
    call.httpStatus = response.status
    call.finishedAt = Date.now()
    run.events.push({ at: call.finishedAt, type: `agent.${call.status}`, stepId, agentId })
    await save()
    return response
  } catch (error) {
    // A failed projection save must not produce duplicate failure events.
    if (call.status === "started") {
      call.status = "failed"
      call.finishedAt = Date.now()
      run.events.push({ at: call.finishedAt, type: "agent.failed", stepId, agentId })
      await save()
    }
    throw error
  }
}
