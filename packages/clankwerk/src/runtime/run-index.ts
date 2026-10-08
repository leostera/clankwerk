export type IndexedRun = {
  id: string
  workflow_id: string
  status: string
  started_at: number
  updated_at: number
}
export type InvocationPage = { items: IndexedRun[]; nextCursor: string | null }
export type WorkflowMetrics = {
  window: "24h"
  since: number
  total: number
  completed: number
  failed: number
  running: number
  hourly: { hour: number; count: number }[]
}

const pageSize = 25
const cursorPattern = /^([0-9]{1,16}):([0-9a-f-]{1,80})$/
function parseCursor(cursor: string): { at: number; id: string } {
  if (cursor.length > 160) throw new Error("Invalid cursor")
  let decoded: string
  try {
    decoded = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))
  } catch {
    throw new Error("Invalid cursor")
  }
  const match = cursorPattern.exec(decoded)
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Invalid cursor")
  return { at: Number(match[1]), id: match[2]! }
}
function encodeCursor(run: IndexedRun): string {
  return btoa(`${run.started_at}:${run.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Query the D1 projection, not all runs in the worker process or the browser. */
export async function workflowInvocations(
  db: D1Database,
  workflowId: string,
  cursor?: string,
): Promise<InvocationPage> {
  if (!/^[a-z][a-z0-9-]*$/.test(workflowId)) throw new Error("Invalid workflow")
  const after = cursor ? parseCursor(cursor) : null
  const sql = `SELECT id, workflow_id, status, started_at, updated_at FROM runs
    WHERE workflow_id = ? ${after ? "AND (started_at < ? OR (started_at = ? AND id < ?))" : ""}
    ORDER BY started_at DESC, id DESC LIMIT ?`
  const stmt = db.prepare(sql)
  const rows = await (
    after ? stmt.bind(workflowId, after.at, after.at, after.id, pageSize + 1) : stmt.bind(workflowId, pageSize + 1)
  ).all<IndexedRun>()
  const items = rows.results.slice(0, pageSize)
  return { items, nextCursor: rows.results.length > pageSize ? encodeCursor(items[items.length - 1]!) : null }
}

/** Real indexed starts by hour. Does not claim CPU time, durations, or all edge requests. */
export async function workflowMetrics(db: D1Database, workflowId: string, now = Date.now()): Promise<WorkflowMetrics> {
  if (!/^[a-z][a-z0-9-]*$/.test(workflowId)) throw new Error("Invalid workflow")
  const since = now - 24 * 60 * 60_000
  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
    COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running
    FROM runs WHERE workflow_id = ? AND started_at >= ?`,
    )
    .bind(workflowId, since)
    .first<{ total: number; completed: number; failed: number; running: number }>()
  const rows = await db
    .prepare(
      `SELECT CAST(started_at / 3600000 AS INTEGER) * 3600000 AS hour,
    COUNT(*) AS count FROM runs WHERE workflow_id = ? AND started_at >= ?
    GROUP BY hour ORDER BY hour`,
    )
    .bind(workflowId, since)
    .all<{ hour: number; count: number }>()
  const counts = new Map(rows.results.map((row) => [row.hour, row.count]))
  const firstHour = Math.floor(since / 3_600_000) * 3_600_000
  const lastHour = Math.floor(now / 3_600_000) * 3_600_000
  const hourly = Array.from({ length: (lastHour - firstHour) / 3_600_000 + 1 }, (_, i) => {
    const hour = firstHour + i * 3_600_000
    return { hour, count: counts.get(hour) ?? 0 }
  })
  return {
    window: "24h",
    since,
    total: totals?.total ?? 0,
    completed: totals?.completed ?? 0,
    failed: totals?.failed ?? 0,
    running: totals?.running ?? 0,
    hourly,
  }
}
