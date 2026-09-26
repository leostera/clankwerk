import { Id } from "./id.js";
export class NodeExecutionError extends Error {
    nodeId;
    constructor(nodeId, cause) {
        super(`Node ${Id.name(nodeId)} failed: ${errorMessage(cause)}`, { cause: rootCause(cause) });
        this.name = "NodeExecutionError";
        this.nodeId = nodeId;
    }
}
/** A typed task failure that instructs durable schedulers whether another attempt is useful. */
export class ExecutionFailure extends Error {
    retryability;
    constructor(message, retryability, options) {
        super(message, options);
        this.retryability = retryability;
        this.name = "ExecutionFailure";
    }
}
export class RetryableExecutionError extends ExecutionFailure {
    constructor(message, options) {
        super(message, "retryable", options);
        this.name = "RetryableExecutionError";
    }
}
export class PermanentExecutionError extends ExecutionFailure {
    constructor(message, options) {
        super(message, "permanent", options);
        this.name = "PermanentExecutionError";
    }
}
export function findNodeExecutionError(error) {
    let current = error;
    const seen = new Set();
    while (current instanceof Error && !seen.has(current)) {
        if (current instanceof NodeExecutionError)
            return current;
        seen.add(current);
        current = "cause" in current ? current.cause : undefined;
    }
    return undefined;
}
/** Returns the nearest explicit classification in an Error cause chain. */
export function retryabilityOf(error) {
    let current = error;
    const seen = new Set();
    while (current instanceof Error && !seen.has(current)) {
        if (current instanceof ExecutionFailure)
            return current.retryability;
        seen.add(current);
        current = "cause" in current ? current.cause : undefined;
    }
    return "unknown";
}
export function serializeExecutionError(error, seen = new Set()) {
    if (error instanceof Error) {
        const cause = "cause" in error ? error.cause : undefined;
        const details = {
            name: error.name,
            message: error.message,
            ...(retryabilityOf(error) === "retryable"
                ? { retryability: "retryable" }
                : retryabilityOf(error) === "permanent"
                    ? { retryability: "permanent" }
                    : {}),
            ...(error instanceof NodeExecutionError ? { nodeId: error.nodeId } : {}),
            ...(error.stack === undefined ? {} : { stack: error.stack }),
        };
        if (cause !== undefined && !seen.has(cause)) {
            seen.add(error);
            return { ...details, cause: serializeExecutionError(cause, seen) };
        }
        return details;
    }
    return { name: "UnknownError", message: String(error) };
}
function rootCause(error) {
    let current = error;
    const seen = new Set();
    while (current instanceof Error && "cause" in current && current.cause !== undefined && !seen.has(current.cause)) {
        seen.add(current);
        current = current.cause;
    }
    return current;
}
function errorMessage(error) {
    const cause = rootCause(error);
    return cause instanceof Error ? cause.message : String(cause);
}