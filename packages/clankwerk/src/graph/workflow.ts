import { Effect } from "effect"
import { Id } from "./id.js"
import { Node, type FanoutOutputs, type NodeRun, type Trigger } from "./node.js"

export const Workflow = {
  all<Branches extends Record<string, Node<unknown, unknown>>>(
    branches: Branches,
  ): Node<void, FanoutOutputs<Branches>> {
    const triggers = Object.values(branches).flatMap((branch) => branch.triggers)
    return new Node<void, FanoutOutputs<Branches>>(
      Id.node("all"),
      (_, context) =>
        Effect.all(
          Object.fromEntries(
            Object.entries(branches).map(([key, branch]) => [key, branch.execute(undefined, context)]),
          ),
          { concurrency: "unbounded" },
        ) as unknown as NodeRun<FanoutOutputs<Branches>>,
      triggers,
      false,
    )
  },

  oneOf<Output>(nodes: readonly Node<void, Output>[]): Trigger<Output> {
    const triggers = nodes.flatMap((node) => node.triggers)
    return new Node(
      Id.node("oneOf"),
      (_, context) => {
        const active = nodes.find((node) => node.triggers.some((trigger) => context?.triggerValues.has(trigger.id)))
        return active ? active.execute(undefined, context) : Effect.die(new Error("oneOf has no active input"))
      },
      triggers,
      false,
    )
  },
}
