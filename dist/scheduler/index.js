export * from "./artifacts.js";
export * from "./database.js";
export * from "./deployment.js";
export * from "./dynamic.js";
export * from "./durable.js";
export * from "./execution-key.js";
export * from "./manifest.js";
export * from "./materialize.js";
export * from "./migrations.js";
export * from "./operations.js";
export * from "./run-state.js";
export * from "./sqlite-schema.js";
export * from "./trigger-scheduler.js";
import { Effect } from "effect";
export class MemoryEventStore {
    events = new Map();
    append(event) {
        return Effect.sync(() => {
            const events = this.events.get(event.runId) ?? [];
            events.push(event);
            this.events.set(event.runId, events);
        });
    }
    getRun(runId) {
        return Effect.succeed(this.events.get(runId) ?? []);
    }
}