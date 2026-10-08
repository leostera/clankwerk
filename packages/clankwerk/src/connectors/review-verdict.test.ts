import { expect, test } from "vitest"
import { parseReviewVerdict } from "./review-verdict.js"

const paths = ["src/index.ts"]
test("only an exact JSON verdict without findings can approve a reviewed diff", () => {
  expect(
    parseReviewVerdict(JSON.stringify({ verdict: "looks_good", summary: "No concrete problems", findings: [] }), paths),
  ).toMatchObject({ verdict: "looks_good" })
})

test("rejects fabricated paths, markdown and self-contradictory approvals", () => {
  const finding = { path: "src/index.ts", line: 7, comment: "This branch is incorrect" }
  expect(() =>
    parseReviewVerdict(JSON.stringify({ verdict: "looks_good", summary: "Fine", findings: [finding] }), paths),
  ).toThrow("Approval has findings")
  expect(() =>
    parseReviewVerdict(JSON.stringify({ verdict: "changes_requested", summary: "Fix", findings: [] }), paths),
  ).toThrow("Revision needs findings")
  expect(() =>
    parseReviewVerdict(
      JSON.stringify({ verdict: "changes_requested", summary: "Fix", findings: [{ ...finding, path: "README.md" }] }),
      paths,
    ),
  ).toThrow("Invalid review finding")
  expect(() => parseReviewVerdict("```json\n{}\n```", paths)).toThrow()
})
