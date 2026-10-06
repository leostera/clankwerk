import type { NodeId } from "./id.js"
import { Id } from "./id.js"

export class NodeExecutionError extends Error {
  readonly nodeId: NodeId

  constructor(nodeId: NodeId, cause: unknown) {
    super(`Node ${Id.name(nodeId)} failed: ${errorMessage(cause)}`, { cause: rootCause(cause) })
    this.name = "NodeExecutionError"
    this.nodeId = nodeId
  }
}

export interface ExecutionError {
  readonly name: string
  readonly message: string
  readonly nodeId?: NodeId
  readonly stack?: string
  readonly cause?: ExecutionError
}

export function findNodeExecutionError(error: unknown): NodeExecutionError | undefined {
  let current = error
  const seen = new Set<unknown>()
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof NodeExecutionError) return current
    seen.add(current)
    current = "cause" in current ? current.cause : undefined
  }
  return undefined
}

export function serializeExecutionError(error: unknown, seen = new Set<unknown>()): ExecutionError {
  if (error instanceof Error) {
    const cause = "cause" in error ? error.cause : undefined
    const details: ExecutionError = {
      name: error.name,
      message: error.message,
      ...(error instanceof NodeExecutionError ? { nodeId: error.nodeId } : {}),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    }
    if (cause !== undefined && !seen.has(cause)) {
      seen.add(error)
      return { ...details, cause: serializeExecutionError(cause, seen) }
    }
    return details
  }
  return { name: "UnknownError", message: String(error) }
}

function rootCause(error: unknown): unknown {
  let current = error
  const seen = new Set<unknown>()
  while (current instanceof Error && "cause" in current && current.cause !== undefined && !seen.has(current.cause)) {
    seen.add(current)
    current = current.cause
  }
  return current
}

function errorMessage(error: unknown): string {
  const cause = rootCause(error)
  return cause instanceof Error ? cause.message : String(cause)
}
