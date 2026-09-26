import { type Node } from "../core/index.js";
/** Minimal Run Durable Object interface required by the Worker router. */
export interface ClankerRunStub {
    fetch(request: Request): Promise<Response>;
}
export interface ClankerRunNamespace {
    idFromName(name: string): unknown;
    get(id: unknown): ClankerRunStub;
}
/** Standard binding contract for every Clanker Worker. */
export interface ClankerEnv {
    readonly WORKFLOW_RUN: ClankerRunNamespace;
}
export interface ClankerCloudflareConfig {
    /** Public status routes are rooted here. Defaults to `/runs`. */
    readonly runsPath?: string;
}
export interface ClankerOptions {
    /** Workflows are activated by triggers and therefore have no direct input. */
    readonly workflows: readonly Node<void, unknown>[];
    readonly cloudflare?: ClankerCloudflareConfig;
}
/**
 * Creates the Cloudflare Worker entrypoint for LibClank workflows.
 *
 * Workflow source code remains in the application; this router only accepts
 * triggers, assigns a run identity, and delegates durable execution to its
 * per-run Durable Object.
 */
export declare const createClanker: <Env extends ClankerEnv>(options: ClankerOptions) => {
    fetch(request: Request, env: Env): Promise<Response>;
};