import { useEffect, useState } from "react"

type GitHubStatus = {
  connected: boolean
  login?: string
  expired?: boolean
  expiresAt?: number
  authKind?: "app" | "user"
  installationUrl?: string
}
type Repo = { fullName: string; private: boolean }

/** Render only for instances that declare the GitHub connection and implement its API. */
export function GitHubConnectionSettings() {
  const [status, setStatus] = useState<GitHubStatus | null>(null)
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/connections/github", { signal: controller.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load GitHub status")
        return r.json() as Promise<GitHubStatus>
      })
      .then(setStatus)
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load status")
      })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!status?.connected || status.expired) return
    const controller = new AbortController()
    fetch("/api/connections/github/repos", { signal: controller.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not list repositories. Check your App installation.")
        return r.json() as Promise<Repo[]>
      })
      .then(setRepos)
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not list repositories")
      })
    return () => controller.abort()
  }, [status])
  async function connect() {
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/connections/github/start", { method: "POST" })
      if (!response.ok) throw new Error("Could not begin GitHub authorization")
      const result = (await response.json()) as { authorize?: string }
      if (!result.authorize?.startsWith("https://github.com/login/oauth/authorize?"))
        throw new Error("Unexpected authorization URL")
      location.assign(result.authorize)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect")
      setBusy(false)
    }
  }
  async function disconnect() {
    if (!confirm("Disconnect GitHub from this project? Existing local workspace changes remain.")) return
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/connections/github", { method: "DELETE" })
      if (!response.ok) throw new Error("Could not disconnect")
      setStatus({ connected: false })
      setRepos(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect")
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="plain-section connector-section">
      <div className="section-heading">
        <h2>GitHub</h2>
        <span className="muted">Repositories</span>
      </div>
      <p>
        {status?.authKind === "app"
          ? "This instance uses its own GitHub App. Installation credentials stay in the private Worker, never in the agent’s workspace."
          : "Authorize the GitHub App to see selected repositories. Credentials stay in the private Worker, not the agent’s code workspace."}
      </p>
      <p className="codex-state" role="status">
        <span
          className={`status-dot ${status?.connected && !status.expired ? "codex-dot--connected" : ""}`}
          aria-hidden="true"
        />
        {status
          ? status.connected
            ? `${status.login ?? "GitHub"} · ${status.expired ? "Connection expired" : "Connected"}`
            : "Not connected"
          : "Checking connection…"}
      </p>
      <div className="connector-actions">
        {status?.authKind === "app" && status.installationUrl?.startsWith("https://github.com/apps/") && (
          <a href={status.installationUrl} target="_blank" rel="noopener noreferrer">
            Manage App installation
          </a>
        )}
        {status?.authKind !== "app" && (!status?.connected || status.expired) && (
          <button type="button" disabled={!status || busy} onClick={connect}>
            {busy ? "Opening GitHub…" : status?.expired ? "Reconnect GitHub" : "Connect GitHub"}
          </button>
        )}
        {status?.authKind !== "app" && status?.connected && (
          <button type="button" disabled={busy} onClick={disconnect}>
            Disconnect
          </button>
        )}
      </div>
      {error && (
        <p className="codex-notice--error" role="alert">
          {error}
        </p>
      )}
      {repos && (
        <div className="connector-repositories">
          <h3>Available repositories</h3>
          {repos.length ? (
            <ul>
              {repos.map((repo) => (
                <li key={repo.fullName}>
                  {repo.fullName}
                  {repo.private && <span className="muted"> · Private</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No repositories are available. Install the App on selected repositories in GitHub.</p>
          )}
        </div>
      )}
      <p className="scope-note">
        Connecting does not start Coder or authorize a push or pull request. Those actions require separate review.
      </p>
    </section>
  )
}
