import { type TriggerId } from "./id.js";
import { type Trigger } from "./node.js";
export declare const Triggers: {
    webhook<Output>(options: {
        id: TriggerId;
        path?: string;
        decode?: (request: Request) => Output | Promise<Output>;
    }): Trigger<Output>;
    manual(options: {
        id: TriggerId;
    }): Trigger<void>;
    cron<Output>(options: {
        id: TriggerId;
        schedule: string;
        value: Output;
    }): Trigger<Output>;
};