import { expect, test } from "vitest"
import { invokeRecordedAgent, type AgentCall, type AgentEvent } from "../template/worker/lineage.ts"

function fixture() {
  const run: { agentCalls?: AgentCall[]; events: AgentEvent[] } = { events: [] }
  const saves: { status: string; events: number }[] = []
  const save = async () => {
    saves.push({ status: run.agentCalls?.at(-1)?.status ?? "none", events: run.events.length })
  }
  return { run, saves, save }
}
const request = () => new Request("https://internal/agents/researcher/session-1/chat", { method: "POST" })

test("records an actual agent call before dispatch and updates the same call after response", async () => {
  const { run, saves, save } = fixture()
  const response = await invokeRecordedAgent(run, "greet", "researcher", "session-1", request(), save, async () => {
    expect(saves).toEqual([{ status: "started", events: 1 }])
    return new Response("ok")
  })
  expect(response.status).toBe(200)
  expect(saves).toEqual([
    { status: "started", events: 1 },
    { status: "completed", events: 2 },
  ])
  expect(run.agentCalls?.[0]).toMatchObject({
    agentId: "researcher",
    instanceName: "session-1",
    status: "completed",
    httpStatus: 200,
  })
  expect(run.events.map((event) => event.type)).toEqual(["agent.started", "agent.completed"])
})

test("records failed agent responses and transport failures without duplicate events", async () => {
  const first = fixture()
  await invokeRecordedAgent(
    first.run,
    "greet",
    "researcher",
    "session-1",
    request(),
    first.save,
    async () => new Response("bad", { status: 503 }),
  )
  expect(first.run.agentCalls?.[0]?.status).toBe("failed")
  expect(first.run.agentCalls?.[0]?.httpStatus).toBe(503)
  const second = fixture()
  await expect(
    invokeRecordedAgent(second.run, "greet", "researcher", "session-1", request(), second.save, async () => {
      throw new Error("offline")
    }),
  ).rejects.toThrow("offline")
  expect(second.run.events.map((event) => event.type)).toEqual(["agent.started", "agent.failed"])
})

test("refuses an unknown agent or mismatched path before recording a call", async () => {
  const { run, saves, save } = fixture()
  const fetch = async () => new Response("unreachable")
  await expect(invokeRecordedAgent(run, "greet", "unknown", "session-1", request(), save, fetch)).rejects.toThrow(
    "Unknown agent",
  )
  await expect(
    invokeRecordedAgent(run, "greet", "researcher", "session-1", new Request("https://internal/other"), save, fetch),
  ).rejects.toThrow("path mismatch")
  expect(run.agentCalls).toBeUndefined()
  expect(saves).toEqual([])
})
