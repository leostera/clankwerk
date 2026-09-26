export const SchedulerObservers = {
    noop: {
        triggerReceived: () => { },
        workflowScheduled: () => { },
        nodeStarted: () => { },
        nodeCompleted: () => { },
        nodeFailed: () => { },
        workflowCompleted: () => { },
    },
};
/** Observer failures are non-fatal: observability must never stop scheduling. */
export function notify(callback) {
    try {
        callback();
    }
    catch {
        /* intentionally ignored */
    }
}