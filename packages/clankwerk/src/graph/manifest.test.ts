import { expect, test } from "vitest"
import { Effect } from "effect"
import { Id } from "./id.js"
import { Task } from "./task.js"
import { Triggers } from "./trigger.js"
import { createWorkflowManifest } from "./manifest.js"

test("a static three-branch fanout joins only after all branch outputs", async () => {
  const received = Task.fn({ id: Id.node("received"), run: (n: number) => Effect.succeed(n) })
  const branches = {
    usability: Task.fn({ id: Id.node("usability"), run: (n: number) => Effect.succeed(n + 1) }),
    correctness: Task.fn({ id: Id.node("correctness"), run: (n: number) => Effect.succeed(n + 2) }),
    performance: Task.fn({ id: Id.node("performance"), run: (n: number) => Effect.succeed(n + 3) }),
  }
  const join = Task.fn({
    id: Id.node("join"),
    run: (data: { usability: number; correctness: number; performance: number }) => Effect.succeed(data),
  })
  const graph = Triggers.manual<number>({ id: Id.trigger("review") })
    .then(received)
    .fanout(branches)
    .then(join)
  const manifest = await createWorkflowManifest({
    workflowId: Id.workflow("review"),
    tasks: graph.definitions,
    triggers: graph.triggers,
  })
  const edges = manifest.edges.filter((edge) => edge.kind === "dependency")
  for (const [name, branch] of Object.entries(branches)) {
    expect(edges).toContainEqual({ from: received.id, to: branch.id, kind: "dependency" })
    expect(edges).toContainEqual({ from: branch.id, to: join.id, kind: "dependency", as: name })
  }
  expect(edges).not.toContainEqual(expect.objectContaining({ from: Id.node("review/then/fanout") }))
  expect(manifest.tasks.map((task) => task.stepId)).toEqual(
    expect.arrayContaining([received.id, join.id, ...Object.values(branches).map((branch) => branch.id)]),
  )
})
