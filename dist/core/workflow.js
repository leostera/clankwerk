import { Effect } from "effect";
import { Id } from "./id.js";
import { Node } from "./node.js";
export const Workflow = {
    all(branches) {
        const triggers = Object.values(branches).flatMap((branch) => branch.triggers);
        return new Node(Id.node(), (_, context) => Effect.all(Object.fromEntries(Object.entries(branches).map(([key, branch]) => [key, branch.execute(undefined, context)])), { concurrency: "unbounded" }), triggers, false);
    },
    oneOf(nodes) {
        const triggers = nodes.flatMap((node) => node.triggers);
        return new Node(Id.node(), (_, context) => {
            const active = nodes.find((node) => node.triggers.some((trigger) => context?.triggerValues.has(trigger.id)));
            return active ? active.execute(undefined, context) : Effect.die(new Error("oneOf has no active input"));
        }, triggers, false);
    },
};