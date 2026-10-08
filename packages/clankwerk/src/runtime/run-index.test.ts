import { describe, expect, it } from "vitest"
import { workflowInvocations, workflowMetrics, type IndexedRun } from "./run-index.js"

function projection(records: IndexedRun[]): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const [workflow, ...rest] = args
          if (sql.includes("GROUP BY hour")) {
            const since = rest[0] as number
            const buckets = new Map<number, number>()
            for (const row of records.filter((item) => item.workflow_id === workflow && item.started_at >= since)) {
              const hour = Math.floor(row.started_at / 3_600_000) * 3_600_000
              buckets.set(hour, (buckets.get(hour) ?? 0) + 1)
            }
            return {
              all: async () => ({
                results: [...buckets].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count })),
              }),
            }
          }
          if (sql.includes("SUM(CASE")) {
            const rows = records.filter(
              (item) => item.workflow_id === workflow && item.started_at >= (rest[0] as number),
            )
            return {
              first: async () => ({
                total: rows.length,
                completed: rows.filter((r) => r.status === "completed").length,
                failed: rows.filter((r) => r.status === "failed").length,
                running: rows.filter((r) => r.status === "running").length,
              }),
            }
          }
          const [at, , id] = sql.includes("started_at < ?") ? rest : [undefined, undefined, undefined]
          const limited = records
            .filter(
              (r) =>
                r.workflow_id === workflow &&
                (at === undefined || r.started_at < (at as number) || (r.started_at === at && r.id < (id as string))),
            )
            .sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id))
          return { all: async () => ({ results: limited.slice(0, rest.at(-1) as number) }) }
        },
      }
    },
  } as unknown as D1Database // In-memory SQL projection stub; only prepare/bind/all/first are exercised.
}

describe("workflow invocation index", () => {
  it("pages past the first 25 runs with stable same-time ordering", async () => {
    const db = projection(
      Array.from({ length: 54 }, (_, i) => ({
        id: i.toString(16).padStart(4, "0"),
        workflow_id: i % 2 ? "other" : "triage",
        status: "completed",
        started_at: 1000,
        updated_at: 1001,
      })),
    )
    const first = await workflowInvocations(db, "triage")
    expect(first.items).toHaveLength(25)
    expect(first.nextCursor).toBeTruthy()
    const last = await workflowInvocations(db, "triage", first.nextCursor!)
    expect(last.items).toHaveLength(2)
    expect(last.nextCursor).toBeNull()
    expect(new Set([...first.items, ...last.items].map((row) => row.id)).size).toBe(27)
    await expect(workflowInvocations(db, "triage", "not-a-cursor")).rejects.toThrow("Invalid cursor")
  })
  it("reports real 24-hour totals, not fabricated CPU metrics", async () => {
    const now = 100_000_000
    const db = projection([
      { id: "a", workflow_id: "triage", status: "completed", started_at: now - 1000, updated_at: now },
      { id: "b", workflow_id: "triage", status: "failed", started_at: now - 2000, updated_at: now },
      { id: "c", workflow_id: "other", status: "running", started_at: now - 1000, updated_at: now },
    ])
    const result = await workflowMetrics(db, "triage", now)
    expect(result).toMatchObject({ window: "24h", total: 2, completed: 1, failed: 1, running: 0 })
    expect(result.hourly.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2)
    expect(result.hourly.filter((bucket) => bucket.count)).toHaveLength(1)
  })
})
