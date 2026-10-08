import { expect, test } from "vitest"
import { Effect } from "effect"
import { Id, Task, createWorkflowManifest } from "./index.js"

test("graph DSL uses Clankwerk IDs and durable call-site identities", async () => {
  const first = Task.fn({ id: Id.node("first"), run: (value: number) => Effect.succeed(value + 1) })
  const next = Task.fn({ id: Id.node("next"), run: (value: number) => Effect.succeed(value * 2) })
  const graph = first.then(next)
  expect(first.id).toBe("clankwerk://node/first")
  const manifest = await createWorkflowManifest({ workflowId: Id.workflow("example"), tasks: graph.definitions })
  expect(manifest.tasks.map((task) => task.stepId)).toContain(next.id)
  expect(manifest.edges).toContainEqual({ from: first.id, to: next.id, kind: "dependency" })
  expect(await Effect.runPromise(graph.execute(2))).toBe(6)
})
