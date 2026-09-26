import { Hono } from "hono";
import type { SchedulerOperations } from "../scheduler/index.js";
/** Hono API for operational workflow data. It intentionally has no authoring routes. */
export declare const createDashboardApi: (operations: SchedulerOperations) => Hono;