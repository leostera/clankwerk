import { type Node, type Scheduler, type SchedulerObserver } from "../core/index.js";
import type { SourceMetadata } from "./deployment.js";
import type { SchedulerDatabase } from "./database.js";
/** Scheduler facade that executes persisted workflow step instances. */
export declare const createDurableScheduler: <Input = void, Output = unknown>(options: {
    readonly workflows: readonly Node<Input, Output>[];
    readonly database: SchedulerDatabase;
    readonly observer: SchedulerObserver;
    readonly source?: SourceMetadata;
    readonly runtime?: string;
}) => Promise<Scheduler<Input, Output>>;