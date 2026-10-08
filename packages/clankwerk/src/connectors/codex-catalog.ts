export type ListedModel = { slug: string; displayName: string }

/** Accept only selectable, well-formed slugs from the connected account's catalog. */
export function listedCodexModels(value: unknown): ListedModel[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { models?: unknown }).models))
    throw new Error("Invalid ChatGPT model catalog")
  const items = (value as { models: unknown[] }).models
  const seen = new Set<string>()
  const result: ListedModel[] = []
  for (const item of items) {
    if (!item || typeof item !== "object") continue
    const model = item as { slug?: unknown; display_name?: unknown; visibility?: unknown }
    if (
      model.visibility !== "list" ||
      typeof model.slug !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(model.slug) ||
      seen.has(model.slug)
    )
      continue
    seen.add(model.slug)
    result.push({
      slug: model.slug,
      displayName:
        typeof model.display_name === "string" && model.display_name.trim()
          ? model.display_name.slice(0, 120)
          : model.slug,
    })
  }
  return result
}
