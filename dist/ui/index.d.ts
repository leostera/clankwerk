export { createDashboardApi } from "./api.js";
export { createDashboardAssetHandler } from "./server.js";
export { Dashboard, type DashboardProps } from "./Dashboard.js";
export { RunGraph, type RunGraphProps } from "./RunGraph.js";
export { ClankerDashboard, type ClankerDashboardProps } from "./ClankerDashboard.js";
/** HTML shell for the bundled React dashboard client. */
export declare const reactDashboardHtml: (scriptPath?: string) => string;
import type { SchedulerOperations } from "../scheduler/index.js";
/** Read-only operational dashboard handler. Workflow authoring is intentionally absent. */
export declare const createDashboardHandler: (operations: SchedulerOperations, basePath?: string) => (request: Request) => Promise<Response>;
export declare const dashboardHtml: (apiPath?: string) => string;