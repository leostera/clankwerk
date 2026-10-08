import { useCallback, useEffect, useRef, useState } from "react"
import { CodexModelPicker } from "./codex-model-picker.tsx"

type Connection = { connected: boolean; hostId: string; email?: string }
type Notice = { text: string; kind: "error" | "success" | "info" }

/** Optional connection card: shown only when the instance declares the Codex connector. */
export function CodexConnectionSettings() {
  const [connection, setConnection] = useState<Connection | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const popup = useRef<Window | null>(null)

  const refresh = useCallback(async () => {
    const response = await fetch("/api/settings/codex", { cache: "no-store" })
    if (!response.ok) throw new Error("Could not load connection status")
    setConnection((await response.json()) as Connection)
  }, [])

  useEffect(() => {
    refresh().catch((error: Error) => setNotice({ text: error.message, kind: "error" }))
  }, [refresh])

  useEffect(() => {
    async function onMessage(event: MessageEvent) {
      if (
        event.origin !== "http://127.0.0.1:1455" ||
        event.source !== popup.current ||
        event.data?.type !== "clankwerk-codex-connection" ||
        !event.data.connection
      )
        return
      popup.current = null
      setBusy(true)
      setNotice({ text: "Securing your connection…", kind: "info" })
      try {
        const response = await fetch("/api/settings/codex", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event.data.connection),
        })
        const result = (await response.json()) as { error?: string }
        if (!response.ok) throw new Error(result.error || "Connection failed")
        await refresh()
        setNotice({
          text: "ChatGPT connected. Choose an available default model below; an actual agent turn still needs testing.",
          kind: "success",
        })
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : "Connection failed", kind: "error" })
      } finally {
        setBusy(false)
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [refresh])

  function connect() {
    if (!connection) return
    popup.current = window.open(
      `http://127.0.0.1:1455/start?host=${encodeURIComponent(connection.hostId)}`,
      "clankwerk-codex",
      "popup,width=580,height=720",
    )
    setNotice(
      popup.current
        ? {
            text: "Complete authorization in the new window. If it cannot connect, run the local helper first.",
            kind: "info",
          }
        : { text: "Allow pop-ups for this site and try again.", kind: "error" },
    )
  }

  async function disconnect() {
    if (!window.confirm("Disconnect ChatGPT from Clankwerk? Coder turns will stop until you reconnect.")) return
    setBusy(true)
    try {
      const response = await fetch("/api/settings/codex", { method: "DELETE" })
      if (!response.ok) throw new Error("Could not disconnect")
      await refresh()
      setNotice({ text: "Disconnected.", kind: "success" })
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Could not disconnect", kind: "error" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section codex-settings">
      <h2>ChatGPT plan</h2>
      <p>
        Authorize on your own computer. This private instance uses your ChatGPT plan for direct Codex inference; its
        code workspace never receives credentials.
      </p>
      <p className="codex-state" role="status">
        <span className={`status-dot ${connection?.connected ? "codex-dot--connected" : ""}`} aria-hidden="true" />
        {connection ? (
          connection.connected ? (
            <>Connected{connection.email ? <> · {connection.email}</> : null}</>
          ) : (
            "Not connected"
          )
        ) : (
          "Checking connection…"
        )}
      </p>
      {!connection?.connected && (
        <p>
          On your computer, run <code>bun run connect:codex</code> from your project. Then select Connect. Sign-in
          completes locally and returns to this page.
        </p>
      )}
      <div className="codex-actions">
        {!connection?.connected && (
          <button type="button" onClick={connect} disabled={!connection || busy}>
            Connect ChatGPT
          </button>
        )}
        {connection?.connected && (
          <button type="button" onClick={disconnect} disabled={busy}>
            Disconnect
          </button>
        )}
      </div>
      <p className={`codex-notice codex-notice--${notice?.kind ?? "info"}`} role="status" aria-live="polite">
        {notice?.text}
      </p>
      {connection?.connected && <CodexModelPicker />}
      <p className="codex-footnote">
        Credentials are encrypted at rest in this Worker. Disconnect removes them here; you can also revoke access in
        ChatGPT Settings.
      </p>
    </section>
  )
}
