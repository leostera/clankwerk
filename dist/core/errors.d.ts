import type { NodeId } from "./id.js";
export declare class NodeExecutionError extends Error {
    readonly nodeId: NodeId;
    constructor(nodeId: NodeId, cause: unknown);
}
export type Retryability = "retryable" | "permanent" | "unknown";
/** A typed task failure that instructs durable schedulers whether another attempt is useful. */
export declare class ExecutionFailure extends Error {
    readonly retryability: Exclude<Retryability, "unknown">;
    constructor(message: string, retryability: Exclude<Retryability, "unknown">, options?: ErrorOptions);
}
export declare class RetryableExecutionError extends ExecutionFailure {
    constructor(message: string, options?: ErrorOptions);
}
export declare class PermanentExecutionError extends ExecutionFailure {
    constructor(message: string, options?: ErrorOptions);
}
export interface ExecutionError {
    readonly name: string;
    readonly message: string;
    readonly retryability?: Exclude<Retryability, "unknown">;
    readonly nodeId?: NodeId;
    readonly stack?: string;
    readonly cause?: ExecutionError;
}
export declare function findNodeExecutionError(error: unknown): NodeExecutionError | undefined;
/** Returns the nearest explicit classification in an Error cause chain. */
export declare function retryabilityOf(error: unknown): Retryability;
export declare function serializeExecutionError(error: unknown, seen?: Set<unknown>): ExecutionError;