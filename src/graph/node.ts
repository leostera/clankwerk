import { Cause, Effect, type Schema } from "effect"
import { findNodeExecutionError, NodeExecutionError } from "./errors.js"
import { Id, type NodeId, type TriggerId } from "./id.js"
import { notify, type SchedulerObserver } from "./observer.js"

export interface ExecutionContext {
  readonly triggerValues: ReadonlyMap<TriggerId, unknown>
  readonly runId?: import("./id.js").RunId
  readonly nodeId?: NodeId
  readonly observer?: SchedulerObserver
}

export type RuntimeSchema<T> = Schema.Schema<T> & Schema.ConstraintDecoder<unknown, never>
export type NodeRun<Output> = Effect.Effect<Output, unknown, never>
export type NodeFunction<Input, Output> = (input: Input, context?: ExecutionContext) => NodeRun<Output>

/** A source-loaded executable for one workflow step; the function itself is never persisted. */
export interface StepImplementation {
  readonly stepId: NodeId
  readonly node: Node<unknown, unknown>
}

/** Source-defined metadata persisted by durable schedulers; executable closures are never persisted. */
export interface NodeDefinition {
  readonly id: NodeId
  readonly stepId: NodeId
  readonly description: string
  readonly version: string
  readonly cache: "never" | "by-input"
  readonly dependencies: readonly NodeId[]
  readonly retry: { readonly maxAttempts: number; readonly backoffMs: number }
  readonly kind?: "static" | "fanout-item" | "fanout"
  readonly fanoutTemplate?: NodeId
}

export interface TriggerDefinition<Output = unknown> {
  readonly id: TriggerId
  readonly kind: "webhook" | "cron" | "manual"
  readonly path?: string
  readonly schedule?: string
  readonly decode?: (request: Request) => Output | Promise<Output>
}

export class Node<Input, Output> {
  /** A function property intentionally makes Input contravariant and Output covariant. */
  readonly execute: (input: Input, context?: ExecutionContext) => NodeRun<Output>
  readonly definitions: readonly NodeDefinition[]
  readonly implementations: readonly StepImplementation[]
  readonly inputSchema: RuntimeSchema<Input> | undefined
  readonly outputSchema: RuntimeSchema<Output> | undefined

  constructor(
    readonly id: NodeId,
    run: NodeFunction<Input, Output>,
    readonly triggers: readonly TriggerDefinition[] = [],
    readonly observable = true,
    readonly definition: NodeDefinition = {
      id,
      stepId: id,
      description: Id.name(id),
      version: "1",
      cache: "never",
      dependencies: [],
      retry: { maxAttempts: 1, backoffMs: 1000 },
    },
    definitions: readonly NodeDefinition[] = [],
    implementations: readonly StepImplementation[] = [],
    inputSchema?: RuntimeSchema<Input>,
    outputSchema?: RuntimeSchema<Output>,
  ) {
    this.inputSchema = inputSchema
    this.outputSchema = outputSchema
    this.definitions = [definition, ...definitions]
    this.implementations =
      implementations.length > 0
        ? implementations
        : [{ stepId: definition.stepId, node: this as unknown as Node<unknown, unknown> }]
    this.execute = (input, context) => {
      const observer = context?.observer
      const execution = Effect.catchCause(run(input, context), (cause) => {
        const error = Cause.squash(cause)
        return Effect.fail(findNodeExecutionError(error) ?? new NodeExecutionError(this.id, error))
      })
      if (!observer || !this.observable) return execution
      const startedAt = Date.now()
      return Effect.tapError(
        Effect.tap(
          Effect.andThen(
            Effect.sync(() =>
              notify(() =>
                observer.nodeStarted({
                  nodeId: this.id,
                  ...(context?.runId === undefined ? {} : { runId: context.runId }),
                }),
              ),
            ),
            execution,
          ),
          (output) =>
            Effect.sync(() =>
              notify(() =>
                observer.nodeCompleted({
                  nodeId: this.id,
                  output,
                  durationMs: Date.now() - startedAt,
                  ...(context?.runId === undefined ? {} : { runId: context.runId }),
                }),
              ),
            ),
        ),
        (error) =>
          Effect.sync(() =>
            notify(() =>
              observer.nodeFailed({
                nodeId: this.id,
                error,
                durationMs: Date.now() - startedAt,
                ...(context?.runId === undefined ? {} : { runId: context.runId }),
              }),
            ),
          ),
      )
    }
  }

  then<Next>(next: Node<Output, Next>): Node<Input, Next>
  then<Next>(next: (output: Output) => NodeRun<Next> | Next): Node<Input, Next>
  then<Next>(next: Node<Output, Next> | ((output: Output) => NodeRun<Next> | Next)): Node<Input, Next> {
    return new Node(
      Id.childNode(this.id, "then"),
      (input, context) =>
        Effect.flatMap(this.execute(input, context), (output) =>
          next instanceof Node ? next.execute(output, context) : toEffect(next(output)),
        ),
      this.triggers,
      false,
      {
        ...this.definition,
        id: Id.childNode(this.id, "then"),
        stepId: Id.childNode(this.id, "then"),
        dependencies: [this.id, ...(next instanceof Node ? [next.id] : [])],
      },
      [...this.definitions, ...(next instanceof Node ? next.definitions : [])],
      [...this.implementations, ...(next instanceof Node ? next.implementations : [])],
    )
  }

  tap(effect: Node<Output, unknown>): Node<Input, Output> {
    return new Node(
      Id.childNode(this.id, "tap"),
      (input, context) =>
        Effect.flatMap(this.execute(input, context), (output) => Effect.as(effect.execute(output, context), output)),
      this.triggers,
      false,
      {
        ...this.definition,
        id: Id.childNode(this.id, "tap"),
        stepId: Id.childNode(this.id, "tap"),
        dependencies: [this.id, effect.id],
      },
      [
        ...this.definitions,
        ...effect.definitions.map((definition) => ({
          ...definition,
          stepId: Id.childNode(Id.childNode(this.id, "tap"), Id.name(definition.stepId)),
        })),
      ],
      [
        ...this.implementations,
        ...effect.implementations.map((implementation) => ({
          stepId: Id.childNode(Id.childNode(this.id, "tap"), Id.name(implementation.stepId)),
          node: implementation.node,
        })),
      ],
    )
  }

  map<Next>(transform: (output: Output) => Next): Node<Input, Next> {
    return new Node(
      Id.childNode(this.id, "map"),
      (input, context) => Effect.map(this.execute(input, context), transform),
      this.triggers,
      false,
      {
        ...this.definition,
        id: Id.childNode(this.id, "map"),
        stepId: Id.childNode(this.id, "map"),
        dependencies: [this.id],
      },
      this.definitions,
      this.implementations,
    )
  }

  mapEach<Item, Next>(this: Node<Input, readonly Item[]>, next: Node<Item, Next>): Node<Input, readonly Next[]>
  mapEach<Item, Next>(
    this: Node<Input, readonly Item[]>,
    next: (item: Item) => NodeRun<Next> | Next,
  ): Node<Input, readonly Next[]>
  mapEach<Item, Next>(
    this: Node<Input, readonly Item[]>,
    next: Node<Item, Next> | ((item: Item) => NodeRun<Next> | Next),
  ): Node<Input, readonly Next[]> {
    return new Node(
      Id.childNode(this.id, "map-each"),
      (input, context) =>
        Effect.flatMap(this.execute(input, context), (items) =>
          Effect.all(
            items.map((item) => (next instanceof Node ? next.execute(item, context) : toEffect(next(item)))),
            { concurrency: "unbounded" },
          ),
        ),
      this.triggers,
      false,
      {
        ...this.definition,
        id: Id.childNode(this.id, "map-each"),
        stepId: Id.childNode(this.id, "map-each"),
        dependencies: [this.id, ...(next instanceof Node ? [next.id] : [])],
        kind: "fanout",
        ...(next instanceof Node ? { fanoutTemplate: next.id } : {}),
      },
      [
        ...this.definitions,
        ...(next instanceof Node
          ? next.definitions.map((definition) => ({ ...definition, kind: "fanout-item" as const }))
          : []),
      ],
      [...this.implementations, ...(next instanceof Node ? next.implementations : [])],
    )
  }

  forEach<Item, Next>(
    this: Node<Input, readonly Item[]>,
    next: (item: Node<Item, Item>) => Node<unknown, Next>,
  ): Node<Input, readonly Next[]> {
    return new Node(
      Id.childNode(this.id, "forEach"),
      (input, context) =>
        Effect.flatMap(this.execute(input, context), (items) =>
          Effect.all(
            items.map((item, index) =>
              next(new Node(Id.childNode(this.id, `[${index}]`), () => Effect.succeed(item), [], false)).execute(
                item,
                context,
              ),
            ),
            { concurrency: "unbounded" },
          ),
        ),
      this.triggers,
      false,
      {
        ...this.definition,
        id: Id.childNode(this.id, "forEach"),
        stepId: Id.childNode(this.id, "forEach"),
        dependencies: [this.id],
      },
      this.definitions,
      this.implementations,
    )
  }

  fanout<Branches extends Record<string, Node<unknown, unknown>>>(
    branches: Branches,
  ): Node<Input, FanoutOutputs<Branches>> {
    return new Node<Input, FanoutOutputs<Branches>>(
      Id.childNode(this.id, "fanout"),
      (input, context) =>
        Effect.flatMap(
          this.execute(input, context),
          (output) =>
            Effect.all(
              Object.fromEntries(
                Object.entries(branches).map(([key, branch]) => [key, branch.execute(output, context)]),
              ),
              { concurrency: "unbounded" },
            ) as unknown as NodeRun<FanoutOutputs<Branches>>,
        ),
      this.triggers,
      false,
      {
        ...this.definition,
        id: Id.childNode(this.id, "fanout"),
        stepId: Id.childNode(this.id, "fanout"),
        dependencies: [this.id, ...Object.values(branches).map((branch) => branch.id)],
      },
      [...this.definitions, ...Object.values(branches).flatMap((branch) => branch.definitions)],
      [...this.implementations, ...Object.values(branches).flatMap((branch) => branch.implementations)],
    )
  }
}

export type NodeInput<N> = N extends Node<infer Input, unknown> ? Input : never
export type NodeOutput<N> = N extends Node<unknown, infer Output> ? Output : never
export type FanoutOutputs<B extends Record<string, Node<unknown, unknown>>> = { [K in keyof B]: NodeOutput<B[K]> }
export type Trigger<Output> = Node<void, Output>
export type EffectNode<Input> = Node<Input, void>

function toEffect<Output>(value: NodeRun<Output> | Output): NodeRun<Output> {
  return value && typeof value === "object" && "_tag" in value
    ? (value as NodeRun<Output>)
    : Effect.succeed(value as Output)
}
