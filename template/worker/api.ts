import { Hono, type Context } from "hono"
import { Id, createWorkflowManifest } from "@leostera/clankwerk"
import { getAgentByName } from "agents"
import { definition as researcher } from "../agents/researcher.ts"
import hello from "../workflows/hello.ts"
import { ensureIndex } from "./index.ts"
import type { Researcher, WorkflowRun } from "./main.ts"

// cf infers these namespaces as DurableObjectStub<undefined>; retain the RPC types here.
type Bindings = Omit<Cloudflare.Env, "RUNS" | "RESEARCHER"> & {
  RUNS: DurableObjectNamespace<WorkflowRun>
  RESEARCHER: DurableObjectNamespace<Researcher>
}

/** Routes every request through the host gate before the API or static asset binding. */
export function createApp(admin: string, triggers: string, project: string) {
  const app = new Hono<{ Bindings: Bindings }>()

  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname
    if (host === triggers || (host !== admin && host !== "localhost" && host !== "127.0.0.1")) return c.notFound()
    await next()
  })

  const trigger = { id: "hello-api", kind: "api", workflowId: hello.id, path: "/api/workflows/hello/runs" }
  app.get("/api/definitions", (c) =>
    c.json({
      project,
      adminHostname: admin,
      triggerHostname: triggers,
      agents: [researcher.id],
      workflows: [hello.id],
      triggers: [trigger.id],
    }),
  )
  app.get("/api/agents/:agent/calls", async (c) => {
    if (c.req.param("agent") !== researcher.id) return c.notFound()
    await ensureIndex(c.env.INDEX)
    const rows = await c.env.INDEX.prepare(
      `SELECT a.*, r.workflow_id, r.status AS run_status FROM agent_calls a
       JOIN runs r ON r.id = a.run_id WHERE a.agent_id = ? ORDER BY a.started_at DESC LIMIT 50`,
    )
      .bind(researcher.id)
      .all()
    return c.json(rows.results)
  })
  app.get("/api/triggers", (c) => c.json([trigger]))
  app.get("/api/triggers/:trigger/executions", async (c) => {
    if (c.req.param("trigger") !== trigger.id) return c.notFound()
    await ensureIndex(c.env.INDEX)
    const rows = await c.env.INDEX.prepare(
      `SELECT t.*, r.workflow_id, r.status AS run_status FROM trigger_executions t
       JOIN runs r ON r.id = t.run_id WHERE t.trigger_id = ? ORDER BY t.accepted_at DESC LIMIT 50`,
    )
      .bind(trigger.id)
      .all()
    return c.json(rows.results)
  })
  app.get("/api/workflows/:workflow/manifest", async (c) => {
    if (c.req.param("workflow") !== hello.id) return c.notFound()
    return c.json(
      await createWorkflowManifest({
        workflowId: Id.workflow(hello.id),
        tasks: hello.graph.definitions,
        triggers: hello.graph.triggers,
      }),
    )
  })
  app.get("/api/runs", async (c) => {
    await ensureIndex(c.env.INDEX)
    const rows = await c.env.INDEX.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 50").all()
    return c.json(rows.results)
  })
  app.get("/api/audit", async (c) => {
    await ensureIndex(c.env.INDEX)
    const rows = await c.env.INDEX.prepare("SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT 100").all()
    return c.json(rows.results)
  })
  app.post("/api/workflows/:workflow/runs", async (c) => {
    if (c.req.param("workflow") !== hello.id) return c.notFound()
    const request = c.req.raw
    if (Number(request.headers.get("content-length")) > 65_536) return c.text("Too large", 413)
    let input: unknown
    try {
      const reader = request.body?.getReader()
      if (!reader) throw new Error("Missing body")
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 65_536) {
          await reader.cancel()
          return c.text("Too large", 413)
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      input = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return c.text("Invalid JSON", 400)
    }
    const id = c.env.RUNS.newUniqueId()
    return c.json(await c.env.RUNS.get(id).start(hello.id, input, { triggerId: trigger.id, kind: "api" }), 202)
  })
  app.get("/api/runs/:id", async (c) => {
    const id = c.req.param("id")
    if (!/^[0-9a-f-]+$/.test(id)) return c.notFound()
    try {
      const run = await c.env.RUNS.get(c.env.RUNS.idFromString(id)).status()
      return run ? c.json(run) : c.notFound()
    } catch {
      return c.notFound()
    }
  })
  const agent = async (c: Context<{ Bindings: Bindings }>) => {
    const name = new URL(c.req.url).pathname.split("/")[3]
    if (!name || name.length > 128) return c.text("Invalid instance", 400)
    return (await getAgentByName(c.env.RESEARCHER, name)).fetch(c.req.raw)
  }
  app.all("/agents/researcher/:name", agent)
  app.all("/agents/researcher/:name/*", agent)

  app.on(["GET", "HEAD"], "*", async (c) => {
    const url = new URL(c.req.url)
    if (
      url.pathname.startsWith("/assets/") ||
      // Vite dev modules; in production the assets binding has no matching files.
      url.pathname.startsWith("/dashboard/") ||
      url.pathname.startsWith("/@vite/") ||
      url.pathname.startsWith("/@id/") ||
      url.pathname.startsWith("/@fs/") ||
      url.pathname.startsWith("/node_modules/")
    )
      return c.env.ASSETS.fetch(c.req.raw)
    if (
      url.pathname === "/" ||
      url.pathname === "/agents" ||
      /^\/agents\/[a-z][a-z0-9-]*$/.test(url.pathname) ||
      url.pathname === "/workflows" ||
      url.pathname === "/triggers" ||
      /^\/triggers\/[a-z][a-z0-9-]*$/.test(url.pathname) ||
      url.pathname === "/settings" ||
      url.pathname === "/observability/audit" ||
      /^\/workflows\/[a-z][a-z0-9-]*$/.test(url.pathname) ||
      /^\/runs\/[0-9a-f-]+$/.test(url.pathname)
    ) {
      const response = await c.env.ASSETS.fetch(new Request(new URL("/index.html", url), c.req.raw))
      const headers = new Headers(response.headers)
      headers.set("cache-control", "no-store")
      return new Response(response.body, { status: response.status, headers })
    }
    return c.notFound()
  })
  app.onError((error, c) => {
    console.error(JSON.stringify({ type: "request.failed", path: c.req.path, error: String(error) }))
    return c.json({ error: "Internal server error" }, 500)
  })
  return app
}
