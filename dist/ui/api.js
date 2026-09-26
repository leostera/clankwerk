import { Schema } from "effect";
import { Hono } from "hono";
import { Id } from "../core/index.js";
/** Hono API for operational workflow data. It intentionally has no authoring routes. */
export const createDashboardApi = (operations) => {
    const app = new Hono();
    app.get("/workflows", async (context) => context.json(await operations.listWorkflows()));
    app.get("/runs", async (context) => context.json(await operations.listRuns()));
    app.get("/runs/:runId", async (context) => context.json(await operations.getRun(Id.runFrom(context.req.param("runId")))));
    app.get("/runs/:runId/nodes", async (context) => context.json(await operations.getNodes(Id.runFrom(context.req.param("runId")))));
    app.get("/runs/:runId/events", async (context) => context.json(await operations.getEvents(Id.runFrom(context.req.param("runId")))));
    app.post("/runs", async (context) => {
        if (!operations.createRun)
            return context.json({ error: "Run creation is not configured" }, 501);
        try {
            const body = await Schema.decodeUnknownPromise(Schema.Struct({
                workflowDefinitionHash: Schema.String,
                triggerId: Schema.String,
                input: Schema.Unknown,
                idempotencyKey: Schema.optional(Schema.String),
            }))(await context.req.json());
            return context.json(await operations.createRun(body), 202);
        }
        catch (error) {
            return context.json({ error: "Invalid run request", details: error instanceof Error ? error.message : String(error) }, 400);
        }
    });
    app.post("/triggers/:triggerId", async (context) => {
        if (!operations.trigger)
            return context.json({ error: "Triggering is not configured" }, 501);
        return context.json(await operations.trigger(context.req.param("triggerId"), await context.req.json()));
    });
    return app;
};