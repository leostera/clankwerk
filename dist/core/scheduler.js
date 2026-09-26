import { Effect } from "effect";
import { serializeExecutionError } from "./errors.js";
import { Id } from "./id.js";
import {} from "./node.js";
import { notify } from "./observer.js";
export const createScheduler = (options) => {
    const triggers = uniqueTriggers(options.workflows.flatMap((workflow) => workflow.triggers));
    return {
        workflows: options.workflows,
        triggers,
        async runTrigger(triggerId, value) {
            notify(() => options.observer.triggerReceived({ triggerId, payload: value }));
            const workflows = options.workflows.filter((workflow) => workflow.triggers.some((trigger) => trigger.id === triggerId));
            return Promise.all(workflows.map(async (workflow) => {
                const id = Id.run();
                notify(() => options.observer.workflowScheduled({ runId: id, workflowId: workflow.id }));
                try {
                    const output = await Effect.runPromise(workflow.execute(undefined, {
                        triggerValues: new Map([[triggerId, value]]),
                        runId: id,
                        nodeId: workflow.id,
                        observer: options.observer,
                    }));
                    const run = { id, workflowId: workflow.id, triggerId, status: "completed", output };
                    notify(() => options.observer.workflowCompleted({ runId: id, workflowId: workflow.id, status: run.status }));
                    return run;
                }
                catch (error) {
                    const run = {
                        id,
                        workflowId: workflow.id,
                        triggerId,
                        status: "failed",
                        error: serializeExecutionError(error),
                    };
                    notify(() => options.observer.workflowCompleted({ runId: id, workflowId: workflow.id, status: run.status }));
                    return run;
                }
            }));
        },
        run() {
            throw new Error("No HTTP/runtime adapter configured. Use @libclank/hono or call runTrigger().");
        },
    };
};
function uniqueTriggers(triggers) {
    return [...new Map(triggers.map((trigger) => [trigger.id, trigger])).values()];
}