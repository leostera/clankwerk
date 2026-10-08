import { Id } from "../graph/id.js"

// D1 is a query projection, not the authoritative per-run store.
export async function ensureIndex(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
    started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
    )
    .run()
  await db
    .prepare("CREATE INDEX IF NOT EXISTS runs_by_workflow_start ON runs (workflow_id, started_at DESC, id DESC)")
    .run()
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, at INTEGER NOT NULL,
    type TEXT NOT NULL, step_id TEXT
  )`,
    )
    .run()
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS trigger_executions (
    run_id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, kind TEXT NOT NULL, accepted_at INTEGER NOT NULL
  )`,
    )
    .run()
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS trigger_executions_by_trigger ON trigger_executions (trigger_id, accepted_at DESC)`,
    )
    .run()
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS agent_calls (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    instance_name TEXT NOT NULL, step_id TEXT NOT NULL, started_at INTEGER NOT NULL,
    finished_at INTEGER, status TEXT NOT NULL, http_status INTEGER
  )`,
    )
    .run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS agent_calls_by_agent ON agent_calls (agent_id, started_at DESC)`).run()
}

export async function projectRun(
  db: D1Database,
  run: {
    id: string
    workflowId: string
    status: string
    events: { at: number; type: string; stepId?: string }[]
    trigger?: { id: string; kind?: "api" | "manual" | "webhook" | "cron" }
    agentCalls?: {
      id: string
      agentId: string
      instanceName: string
      stepId: string
      startedAt: number
      finishedAt?: number
      status: string
      httpStatus?: number
    }[]
  },
) {
  await ensureIndex(db)
  const started = run.events[0]?.at ?? Date.now()
  const updated = run.events.at(-1)?.at ?? started
  // Multiple processes may write the same projection after a retry: event IDs are deterministic.
  await db
    .prepare(
      `INSERT INTO runs (id, workflow_id, status, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`,
    )
    .bind(run.id, run.workflowId, run.status, started, updated)
    .run()
  if (run.trigger)
    await db
      .prepare(`INSERT OR IGNORE INTO trigger_executions (run_id, trigger_id, kind, accepted_at) VALUES (?, ?, ?, ?)`)
      .bind(run.id, Id.name(run.trigger.id as ReturnType<typeof Id.trigger>), run.trigger.kind ?? "manual", started)
      .run()
  for (const call of run.agentCalls ?? [])
    await db
      .prepare(
        `INSERT INTO agent_calls (id, run_id, agent_id, instance_name, step_id, started_at, finished_at, status, http_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at, status=excluded.status, http_status=excluded.http_status`,
      )
      .bind(
        call.id,
        run.id,
        call.agentId,
        call.instanceName,
        call.stepId,
        call.startedAt,
        call.finishedAt ?? null,
        call.status,
        call.httpStatus ?? null,
      )
      .run()
  for (const [index, event] of run.events.entries())
    await db
      .prepare(`INSERT OR IGNORE INTO audit (id, run_id, at, type, step_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${run.id}:${index}`, run.id, event.at, event.type, event.stepId ?? null)
      .run()
}
