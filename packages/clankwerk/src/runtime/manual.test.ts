import { expect, test } from "vitest"
import { Id } from "../graph/id.js"
import { Triggers } from "../graph/trigger.js"
import { dispatchManual } from "./manual.js"

const manual = Triggers.manual<{ package: string }>({ id: Id.trigger("release-check") })
const workflow = { id: "release-check", graph: manual }

test("manual invocation activates only declared triggers with a durable, namespaced identity", async () => {
  const activations: unknown[] = []
  expect(
    await dispatchManual(
      Id.trigger("release-check"),
      { package: "@leostera/clankwerk" },
      [workflow],
      async (event) => {
        activations.push(event)
      },
      "00000000-0000-4000-8000-000000000001",
    ),
  ).toEqual(activations)
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("release-check:00000000-0000-4000-8000-000000000001"),
    ),
  )
  const key = `release-check:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  expect(activations).toEqual([
    {
      workflowId: "release-check",
      triggerId: Id.trigger("release-check"),
      key,
      partition: key,
      value: { package: "@leostera/clankwerk" },
    },
  ])
  expect(
    await dispatchManual("trigger/other", {}, [workflow], async () => {
      throw new Error("not selected")
    }),
  ).toEqual([])
})
