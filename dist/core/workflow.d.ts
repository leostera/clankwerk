import { Node, type FanoutOutputs, type Trigger } from "./node.js";
export declare const Workflow: {
    all<Branches extends Record<string, Node<unknown, unknown>>>(branches: Branches): Node<void, FanoutOutputs<Branches>>;
    oneOf<Output>(nodes: readonly Node<void, Output>[]): Trigger<Output>;
};