import { Effect } from "effect"
import { Id, type TriggerId } from "./id.js"
import { Node, type Trigger, type TriggerDefinition } from "./node.js"

export const Triggers = {
  webhook<Output>(options: {
    id: TriggerId
    path?: string
    decode?: (request: Request) => Output | Promise<Output>
  }): Trigger<Output> {
    const definition: TriggerDefinition<Output> = {
      ...options,
      kind: "webhook",
      path: options.path ?? `/hooks/${Id.name(options.id)}`,
    }
    return new Node(
      Id.nodeFromTrigger(options.id),
      (_, context) => {
        const value = context?.triggerValues.get(options.id)
        return value === undefined
          ? Effect.die(new Error(`Trigger ${options.id} has not been activated`))
          : Effect.succeed(value as Output)
      },
      [definition],
    )
  },

  manual(options: { id: TriggerId }): Trigger<void> {
    const definition: TriggerDefinition<void> = { id: options.id, kind: "manual", path: `/run/${Id.name(options.id)}` }
    return new Node(Id.nodeFromTrigger(options.id), () => Effect.succeed(undefined), [definition])
  },

  cron<Output>(options: { id: TriggerId; schedule: string; value: Output }): Trigger<Output> {
    const definition: TriggerDefinition<Output> = { ...options, kind: "cron" }
    return new Node(
      Id.nodeFromTrigger(options.id),
      (_, context) => Effect.succeed((context?.triggerValues.get(options.id) ?? options.value) as Output),
      [definition],
    )
  },
}
