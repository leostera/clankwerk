import { describe, expect, it } from "vitest"
import { listedCodexModels } from "./codex-catalog.js"

describe("connected account model catalog", () => {
  it("keeps only listed, safe and distinct model identifiers", () => {
    expect(
      listedCodexModels({
        models: [
          { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list" },
          { slug: "gpt-5.4", visibility: "list" },
          { slug: "hidden-model", visibility: "hide" },
          { slug: "unmarked", visibility: "unknown" },
          { slug: "../../secret", visibility: "list" },
          { slug: "gpt-5.4-mini", visibility: "list" },
          null,
        ],
      }),
    ).toEqual([
      { slug: "gpt-5.4", displayName: "GPT-5.4" },
      { slug: "gpt-5.4-mini", displayName: "gpt-5.4-mini" },
    ])
  })
  it("rejects malformed catalogs rather than inventing a list", () => {
    expect(() => listedCodexModels({ data: [] })).toThrow("Invalid ChatGPT model catalog")
  })
})
