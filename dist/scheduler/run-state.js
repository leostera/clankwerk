export const NodeInstanceTransitions = {
    canTransition(from, to) {
        return {
            pending: ["ready", "cancelled"],
            ready: ["running", "cancelled"],
            running: ["completed", "retry_wait", "failed", "cancelled"],
            retry_wait: ["ready", "cancelled"],
            completed: [],
            failed: [],
            cancelled: [],
        }[from].includes(to);
    },
    assert(from, to) {
        if (!this.canTransition(from, to))
            throw new Error(`Invalid node instance transition: ${from} -> ${to}`);
    },
};