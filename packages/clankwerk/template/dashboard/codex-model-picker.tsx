import { useEffect, useState } from "react"

type Catalog = {
  models: { slug: string; displayName: string }[]
  defaultModel: string | null
  override?: string | null
}

/** Reusable default/per-agent model selector. The server validates against this account's live catalog. */
export function CodexModelPicker({ agentId }: { agentId?: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [selection, setSelection] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [saving, setSaving] = useState(false)
  const path = agentId ? `/api/agents/${encodeURIComponent(agentId)}/model` : "/api/settings/codex/models"

  useEffect(() => {
    const controller = new AbortController()
    setCatalog(null)
    setError("")
    fetch(path, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 409 ? "Connect ChatGPT in Settings first." : "Could not load available models.",
          )
        return response.json() as Promise<Catalog>
      })
      .then((result) => {
        setCatalog(result)
        setSelection(agentId ? (result.override ?? "") : (result.defaultModel ?? ""))
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load models.")
      })
    return () => controller.abort()
  }, [agentId, path])

  async function save() {
    if (!catalog) return
    setSaving(true)
    setError("")
    setNotice("")
    try {
      const response = await fetch(path, {
        method: selection ? "PUT" : "DELETE",
        ...(selection
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ model: selection }) }
          : {}),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? "Could not save model choice.")
      }
      setCatalog({ ...catalog, ...(agentId ? { override: selection || null } : { defaultModel: selection || null }) })
      setNotice(
        agentId
          ? selection
            ? "Agent override saved."
            : "Agent now uses the default model."
          : selection
            ? "Default model saved."
            : "Default cleared. Agents without overrides use their built-in model, if any.",
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save model choice.")
    } finally {
      setSaving(false)
    }
  }

  const current = agentId ? (catalog?.override ?? "") : (catalog?.defaultModel ?? "")
  const unavailable = Boolean(current && catalog && !catalog.models.some((item) => item.slug === current))
  return (
    <div className="codex-model-choice">
      <h3>{agentId ? "Agent model" : "Default model"}</h3>
      <p>
        {agentId
          ? "Choose a model for this agent, or inherit the project default. Changes apply to new turns."
          : "Used by agents without an override. Changes apply to new turns; they don't test inference."}
      </p>
      {catalog && (
        <div className="codex-model-form">
          <label htmlFor={agentId ? `model-${agentId}` : "model-default"}>Model</label>
          <div className="codex-model-controls">
            <select
              id={agentId ? `model-${agentId}` : "model-default"}
              value={selection}
              onChange={(event) => {
                setSelection(event.target.value)
                setNotice("")
              }}
              disabled={saving || !catalog.models.length}
            >
              <option value="">
                {agentId
                  ? `Use default${catalog.defaultModel ? ` (${catalog.defaultModel})` : " (none set)"}`
                  : "No default model"}
              </option>
              {unavailable && (
                <option value={current} disabled>
                  {current} — no longer listed
                </option>
              )}
              {catalog.models.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.displayName === item.slug ? item.slug : `${item.displayName} (${item.slug})`}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={save}
              disabled={
                saving ||
                selection === current ||
                Boolean(selection && !catalog.models.some((item) => item.slug === selection))
              }
            >
              {saving ? "Saving…" : "Save model"}
            </button>
          </div>
          {unavailable && (
            <p className="codex-notice codex-notice--error">
              The saved model is no longer listed for this account. Select another.
            </p>
          )}
          {!catalog.models.length && (
            <p className="codex-notice codex-notice--error">No selectable models were returned for this account.</p>
          )}
          {agentId && !catalog.defaultModel && !catalog.override && (
            <p className="codex-footnote">
              No project default is set. This agent uses its built-in model, if configured.
            </p>
          )}
        </div>
      )}
      {!catalog && !error && (
        <p role="status" className="muted">
          Loading available models…
        </p>
      )}
      {error && (
        <p role="alert" className="codex-notice codex-notice--error">
          {error} {error.includes("Connect ChatGPT") && <a href="/settings">Open Settings</a>}
        </p>
      )}
      {notice && (
        <p role="status" className="codex-notice codex-notice--success">
          {notice}
        </p>
      )}
    </div>
  )
}
