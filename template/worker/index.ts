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
    .prepare(
      `CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, at INTEGER NOT NULL,
    type TEXT NOT NULL, step_id TEXT
  )`,
    )
    .run()
}

export async function projectRun(
  db: D1Database,
  run: {
    id: string
    workflowId: string
    status: string
    events: { at: number; type: string; stepId?: string }[]
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
  for (const [index, event] of run.events.entries())
    await db
      .prepare(`INSERT OR IGNORE INTO audit (id, run_id, at, type, step_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${run.id}:${index}`, run.id, event.at, event.type, event.stepId ?? null)
      .run()
}
