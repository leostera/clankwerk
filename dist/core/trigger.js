import { Effect } from "effect";
import { Id } from "./id.js";
import { Node } from "./node.js";
export const Triggers = {
    webhook(options) {
        const nodeId = Id.node();
        const definition = {
            ...options,
            nodeId,
            kind: "webhook",
            path: options.path ?? `/hooks/${Id.name(options.id)}`,
        };
        return new Node(nodeId, (_, context) => {
            const value = context?.triggerValues.get(options.id);
            return value === undefined
                ? Effect.die(new Error(`Trigger ${options.id} has not been activated`))
                : Effect.succeed(value);
        }, [definition]);
    },
    manual(options) {
        const nodeId = Id.node();
        const definition = {
            id: options.id,
            nodeId,
            kind: "manual",
            path: `/run/${Id.name(options.id)}`,
        };
        return new Node(nodeId, () => Effect.succeed(undefined), [definition]);
    },
    cron(options) {
        const nodeId = Id.node();
        const definition = { ...options, nodeId, kind: "cron" };
        return new Node(nodeId, (_, context) => Effect.succeed((context?.triggerValues.get(options.id) ?? options.value)), [definition]);
    },
};