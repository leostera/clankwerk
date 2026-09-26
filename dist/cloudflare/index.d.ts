export * from "./durable-scheduler.js";
export * from "./clanker.js";
export * from "./dashboard.js";
import { Hono } from "hono";
import { type AgentEndpoint } from "../agent/index.js";
import type { Scheduler } from "../core/index.js";
export interface CloudflareEndpointTarget {
    fetch(request: Request): Promise<Response>;
}
/** Connects Task.agent to a team-owned AgentRuntime deployed as an Agents SDK DO or Worker. */
export declare const createAgentEndpoint: (target: CloudflareEndpointTarget, path?: string, identity?: unknown) => AgentEndpoint;
export declare const createTriggerApp: (scheduler: Scheduler) => Hono;