export type ReviewVerdict = {
  verdict: "looks_good" | "changes_requested" | "blocked"
  summary: string
  findings: { path: string; line: number; comment: string }[]
}

/** Treat model output as untrusted. Invalid or mismatched reviews never mean approval. */
export function parseReviewVerdict(text: string, paths: readonly string[]): ReviewVerdict {
  if (text.length > 10_000) throw new Error("Review exceeds limit")
  const result: unknown = JSON.parse(text)
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid review")
  const value = result as Record<string, unknown>
  if (
    !(["looks_good", "changes_requested", "blocked"] as readonly unknown[]).includes(value.verdict) ||
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    value.summary.length > 2_000 ||
    !Array.isArray(value.findings) ||
    value.findings.length > 12
  )
    throw new Error("Invalid review verdict")
  for (const finding of value.findings) {
    if (
      !finding ||
      typeof finding !== "object" ||
      typeof finding.path !== "string" ||
      !paths.includes(finding.path) ||
      !Number.isSafeInteger(finding.line) ||
      finding.line < 1 ||
      finding.line > 10_000 ||
      typeof finding.comment !== "string" ||
      !finding.comment.trim() ||
      finding.comment.length > 2_000
    )
      throw new Error("Invalid review finding")
  }
  if (value.verdict === "looks_good" && value.findings.length) throw new Error("Approval has findings")
  if (value.verdict === "changes_requested" && !value.findings.length) throw new Error("Revision needs findings")
  return value as ReviewVerdict
}
