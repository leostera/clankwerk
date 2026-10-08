import { expect, test } from "vitest"
import { coderWorkspaceSource } from "./coder-workspace-config.js"

const env = { CODER_OWNER: "leostera", CODER_REPO: "r4", CODER_BASE: "main" }

test("Coder workspace scope is configured by the host, never an issue body", () => {
  expect(coderWorkspaceSource(env)).toEqual({
    owner: "leostera",
    repo: "r4",
    base: "main",
    url: "https://github.com/leostera/r4.git",
  })
  expect(coderWorkspaceSource({ ...env, CODER_REPO: "another-repo" }).url).toBe(
    "https://github.com/leostera/another-repo.git",
  )
  for (const invalid of ["../main", "refs/../main", "", "@{main}"])
    expect(() => coderWorkspaceSource({ ...env, CODER_BASE: invalid })).toThrow("configuration")
})
