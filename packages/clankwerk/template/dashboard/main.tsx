import { createRoot } from "react-dom/client"
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronDown,
  Cog,
  GitBranch,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings2,
  Webhook,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import "./style.css"
import { CodexConnectionSettings } from "./codex-connection.tsx"
import { CodexModelPicker } from "./codex-model-picker.tsx"
import { GitHubConnectionSettings } from "./github-connection.tsx"

type Definitions = {
  project: string
  adminHostname: string
  triggerHostname: string
  agents: string[]
  workflows: string[]
  triggers: string[]
  connections?: string[]
  modelConfigurableAgents?: string[]
}
type AgentCallRow = {
  id: string
  run_id: string
  agent_id: string
  instance_name: string
  step_id: string
  started_at: number
  status: string
  http_status: number | null
  workflow_id: string
  run_status: string
}
type TriggerDef = { id: string; kind: "api"; workflowId: string; path: string }
type TriggerExecution = {
  run_id: string
  trigger_id: string
  kind: string
  accepted_at: number
  workflow_id: string
  run_status: string
}
type Theme = "light" | "dark" | "auto"
type RunRow = { id: string; workflow_id: string; status: string; started_at: number; updated_at: number }
type AuditRow = { id: string; run_id: string; type: string; at: number; step_id: string | null }
type Step = { id: string; status: string; attempts: number; output?: unknown; error?: string }
type Run = {
  id: string
  workflowId: string
  definitionHash: string
  status: string
  steps: Step[]
  origin?: { triggerId: string; kind: string }
  agentCalls?: {
    id: string
    agentId: string
    instanceName: string
    stepId: string
    startedAt: number
    status: string
    httpStatus?: number
  }[]
  events: { at: number; type: string; stepId?: string; agentId?: string }[]
}
type Manifest = {
  definitionHash: string
  tasks: { id: string; stepId: string; description: string; kind?: string }[]
  edges: { from: string; to: string; kind: "dependency" | "trigger" }[]
  triggers: { id: string; kind: string }[]
}
type InvocationPage = { items: RunRow[]; nextCursor: string | null }
type WorkflowMetrics = {
  window: "24h"
  total: number
  completed: number
  failed: number
  running: number
  hourly: { hour: number; count: number }[]
}
type Result<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; message: string }

function useApi<T>(path: string | null): Result<T> {
  const [value, setValue] = useState<Result<T>>({ state: "loading" })
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    fetch(path, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Request failed (${response.status}).`)
        if (!response.headers.get("content-type")?.includes("application/json"))
          throw new Error("The API did not return project data. Your Access session may have expired.")
        return response.json() as Promise<T>
      })
      .then((data) => setValue({ state: "ready", data }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setValue({ state: "error", message: error instanceof Error ? error.message : "Request failed." })
      })
    return () => controller.abort()
  }, [path])
  return value
}

const date = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(ms)
const short = (id: string) => (id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-5)}` : id)
const label = (id: string) => id.split("/").at(-1) ?? id
const eventTime = (ms: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).format(ms)
const plural = (n: number, singular: string) => `${n} ${singular}${n === 1 ? "" : "s"}`
function stored(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
const nav = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/workflows", label: "Workflows", icon: GitBranch },
  { href: "/triggers", label: "Triggers", icon: Webhook },
  { href: "/connectors", label: "Connectors", icon: Settings2 },
  { href: "/observability/audit", label: "Audit log", icon: Activity },
]
function activeRoute(path: string) {
  if (path.startsWith("/agents")) return "/agents"
  if (path.startsWith("/workflows") || path.startsWith("/runs/")) return "/workflows"
  if (path.startsWith("/triggers")) return "/triggers"
  if (path === "/connectors") return "/connectors"
  if (path.startsWith("/observability")) return "/observability/audit"
  if (path === "/settings") return "/settings"
  return "/"
}
function Status({ value }: { value: string }) {
  return (
    <span
      className={`status status--${["completed", "running", "ready", "pending", "failed"].includes(value) ? value : "unknown"}`}
    >
      <span className="status-dot" aria-hidden="true" />
      {value}
    </span>
  )
}
function Resource<T>({ value, children }: { value: Result<T>; children: (data: T) => ReactNode }) {
  if (value.state === "loading")
    return (
      <div className="loading" role="status" aria-label="Loading">
        <span />
        <span />
        <span />
      </div>
    )
  if (value.state === "error")
    return (
      <div className="request-error" role="alert">
        <strong>Couldn’t load this view.</strong> {value.message}{" "}
        <button type="button" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    )
  return <>{children(value.data)}</>
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}
function Shell({
  project,
  definitions,
  children,
}: {
  project: string
  definitions: Result<Definitions>
  children: ReactNode
}) {
  const selected = activeRoute(location.pathname)
  const searchRef = useRef<HTMLInputElement>(null)
  const [collapsed, setCollapsed] = useState(() => stored("clankwerk.sidebar", "open") === "closed")
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({ [selected]: true }))
  const setSidebar = (next: boolean) => {
    setCollapsed(next)
    try {
      localStorage.setItem("clankwerk.sidebar", next ? "closed" : "open")
    } catch {
      /* Optional storage. */
    }
  }
  const quickSearch = () => {
    if (collapsed) setSidebar(false)
    requestAnimationFrame(() => searchRef.current?.focus())
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === "k") {
        event.preventDefault()
        quickSearch()
      }
      if (
        key === "b" &&
        matchMedia("(min-width: 741px)").matches &&
        !(event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]"))
      ) {
        event.preventDefault()
        setSidebar(!collapsed)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [collapsed])
  const currentQuery = new URLSearchParams(location.search).get("q") ?? ""
  return (
    <div className={`shell${collapsed ? " shell--collapsed" : ""}`}>
      <aside className="sidebar">
        <a href="/" className="brand" aria-label="Clankwerk overview" title="Clankwerk overview">
          <span className="brand-mark" aria-hidden="true">
            <Cog size={26} strokeWidth={1.9} />
            <span className="brand-center" />
          </span>
          <span className="brand-word">
            clankwerk<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="project-name" title={project}>
          {project}
        </div>
        <form className="sidebar-search" role="search" action="/" method="get">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            name="q"
            type="search"
            aria-label="Quick search"
            placeholder="Quick search…"
            defaultValue={currentQuery}
          />
          <kbd aria-hidden="true">⌘K</kbd>
        </form>
        <button
          type="button"
          className="sidebar-search-compact"
          onClick={quickSearch}
          aria-label="Quick search"
          title="Quick search (⌘K)"
        >
          <Search size={18} aria-hidden="true" />
        </button>
        <nav id="project-navigation" aria-label="Project navigation" className="nav">
          {nav.map(({ href, label: text, icon: Icon }) => {
            const group = href === "/agents" || href === "/workflows" || href === "/triggers"
            const entries =
              definitions.state === "ready"
                ? href === "/agents"
                  ? definitions.data.agents
                  : href === "/workflows"
                    ? definitions.data.workflows
                    : definitions.data.triggers
                : []
            const open = expanded[href] ?? false
            const link = (
              <a
                className={
                  selected === href
                    ? `nav-link ${location.pathname === href ? "nav-link--current" : "nav-link--section"}`
                    : "nav-link"
                }
                href={href}
                aria-label={text}
                title={text}
                aria-current={location.pathname === href ? "page" : undefined}
              >
                <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
                <span className="nav-text">{text}</span>
              </a>
            )
            return group ? (
              <div className="nav-group" key={href}>
                <div className="nav-group-row">
                  {link}
                  <button
                    type="button"
                    className="nav-group-toggle"
                    aria-label={`${open ? "Hide" : "Show"} ${text.toLowerCase()}`}
                    aria-expanded={open}
                    aria-controls={`nav-items-${text.toLowerCase()}`}
                    onClick={() => setExpanded((old) => ({ ...old, [href]: !old[href] }))}
                    title={`${open ? "Hide" : "Show"} ${text.toLowerCase()}`}
                  >
                    <ChevronDown size={15} aria-hidden="true" />
                  </button>
                </div>
                <ul className="nav-submenu" id={`nav-items-${text.toLowerCase()}`} hidden={!open}>
                  {entries.map((item) => (
                    <li key={item}>
                      <a
                        className={
                          location.pathname === `${href}/${item}`
                            ? "nav-sub-link nav-sub-link--current"
                            : "nav-sub-link"
                        }
                        href={`${href}/${item}`}
                        aria-current={location.pathname === `${href}/${item}` ? "page" : undefined}
                        title={item}
                      >
                        {item}
                      </a>
                    </li>
                  ))}
                  {definitions.state === "loading" && <li className="nav-sub-note">Loading…</li>}
                  {definitions.state === "error" && <li className="nav-sub-note">Items unavailable</li>}
                  {definitions.state === "ready" && entries.length === 0 && <li className="nav-sub-note">None yet</li>}
                </ul>
              </div>
            ) : (
              <div className="nav-item" key={href}>
                {link}
              </div>
            )
          })}
        </nav>
        <div className="sidebar-settings">
          <a
            href="/settings"
            className={selected === "/settings" ? "nav-link nav-link--current" : "nav-link"}
            aria-label="Settings"
            title="Settings"
            aria-current={selected === "/settings" ? "page" : undefined}
          >
            <Settings2 size={17} strokeWidth={1.8} aria-hidden="true" />
            <span className="nav-text">Settings</span>
          </a>
        </div>
        <div className="sidebar-collapse">
          <button
            className="collapse-toggle"
            type="button"
            onClick={() => setSidebar(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls="project-navigation"
            title={`${collapsed ? "Expand" : "Collapse"} sidebar (⌘B)`}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={18} aria-hidden="true" />
            )}
          </button>
        </div>
      </aside>
      <main id="main" className="content">
        {children}
      </main>
    </div>
  )
}
function Heading({
  title,
  detail,
  parent,
}: {
  title: string
  detail?: string
  parent?: { href: string; label: string }
}) {
  return (
    <header className="heading">
      {parent && (
        <a className="parent-link" href={parent.href}>
          <ArrowLeft size={15} aria-hidden="true" />
          {parent.label}
        </a>
      )}
      <h1>{title}</h1>
      {detail && <p>{detail}</p>}
    </header>
  )
}
function EntityList({
  title,
  href,
  items,
  kind,
  empty,
}: {
  title: string
  href: string
  items: string[]
  kind: "agent" | "workflow" | "trigger"
  empty: string
}) {
  const Icon = kind === "agent" ? Bot : kind === "workflow" ? GitBranch : Webhook
  return (
    <section className="entity-group">
      <div className="group-heading">
        <h2>{title}</h2>
        <span>{items.length}</span>
      </div>
      {items.length ? (
        <ul className="entity-list">
          {items.slice(0, 6).map((item) => (
            <li key={item}>
              <a href={`${href}/${item}`}>
                <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
                <span>{item}</span>
                <ArrowRight size={14} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{empty}</Empty>
      )}
      {items.length > 6 && (
        <a className="more-link" href={href}>
          See all {title.toLowerCase()}
        </a>
      )}
    </section>
  )
}
function RunTable({ runs, workflowColumn = true }: { runs: RunRow[]; workflowColumn?: boolean }) {
  if (!runs.length) return <Empty>No runs yet.</Empty>
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Run</th>
            {workflowColumn && <th scope="col">Workflow</th>}
            <th scope="col">Status</th>
            <th scope="col" className="run-start-desktop">
              Started
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <a className="run-link mono" href={`/runs/${run.id}`} title={run.id}>
                  {short(run.id)}
                </a>
                <time className="run-start-mobile muted" dateTime={new Date(run.started_at).toISOString()}>
                  {date(run.started_at)}
                </time>
              </td>
              {workflowColumn && (
                <td>
                  <a href={`/workflows/${run.workflow_id}`}>{run.workflow_id}</a>
                </td>
              )}
              <td>
                <Status value={run.status} />
              </td>
              <td className="muted run-start-desktop">
                <time dateTime={new Date(run.started_at).toISOString()}>{date(run.started_at)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
function Home({ definitions, runs }: { definitions: Result<Definitions>; runs: Result<RunRow[]> }) {
  const query = new URLSearchParams(location.search).get("q") ?? ""
  const term = query.trim().toLowerCase()
  const data = definitions.state === "ready" ? definitions.data : null
  const recent = runs.state === "ready" ? runs.data : []
  const matches =
    term && data
      ? [
          ...data.agents
            .filter((name) => name.toLowerCase().includes(term))
            .map((name) => ({ name, type: "Agent", href: `/agents/${name}` })),
          ...data.workflows
            .filter((name) => name.toLowerCase().includes(term))
            .map((name) => ({ name, type: "Workflow", href: `/workflows/${name}` })),
          ...data.triggers
            .filter((name) => name.toLowerCase().includes(term))
            .map((name) => ({ name, type: "Trigger", href: `/triggers/${name}` })),
          ...recent
            .filter((run) => run.id.toLowerCase().includes(term) || run.workflow_id.toLowerCase().includes(term))
            .map((run) => ({ name: short(run.id), type: `Run · ${run.workflow_id}`, href: `/runs/${run.id}` })),
        ]
      : []
  return (
    <>
      <div className="home-intro">
        <h1>What are you working on?</h1>
        <p>Find an agent, follow a workflow, or pick up a recent run.</p>
      </div>
      {term ? (
        <section className="search-results" aria-live="polite">
          <div className="section-heading">
            <h2>Results for “{query.trim()}”</h2>
            <a href="/">Clear search</a>
          </div>
          {definitions.state === "error" ? (
            <Resource value={definitions}>{() => null}</Resource>
          ) : definitions.state === "loading" ? (
            <Resource value={definitions}>{() => null}</Resource>
          ) : matches.length ? (
            <ul className="entity-list">
              {matches.map((item) => (
                <li key={`${item.type}:${item.href}`}>
                  <a href={item.href}>
                    <span>{item.name}</span>
                    <small>{item.type}</small>
                    <ArrowRight size={14} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No matches in the available records.</Empty>
          )}
          {runs.state === "loading" && (
            <p className="scope-note" role="status">
              Loading recent runs…
            </p>
          )}
          {runs.state === "error" && <p className="scope-note">Recent runs could not be searched. Try reloading.</p>}
          <p className="scope-note">Search covers this project’s definitions and its latest 50 indexed runs.</p>
        </section>
      ) : (
        <>
          <div className="home-groups">
            <Resource value={definitions}>
              {(d) => (
                <>
                  <EntityList title="Agents" href="/agents" kind="agent" items={d.agents} empty="No agents yet" />
                  <EntityList
                    title="Workflows"
                    href="/workflows"
                    kind="workflow"
                    items={d.workflows}
                    empty="No workflows yet"
                  />
                  <EntityList
                    title="Triggers"
                    href="/triggers"
                    kind="trigger"
                    items={d.triggers}
                    empty="No triggers configured"
                  />
                </>
              )}
            </Resource>
          </div>
          <section className="recent">
            <div className="section-heading">
              <h2>Recent runs</h2>
              <a href="/workflows">
                View workflows <ArrowRight size={14} aria-hidden="true" />
              </a>
            </div>
            <Resource value={runs}>{(rows) => <RunTable runs={rows.slice(0, 6)} />}</Resource>
          </section>
        </>
      )}
    </>
  )
}
function Agents({ definitions, id }: { definitions: Result<Definitions>; id?: string }) {
  if (id) return <AgentDetail definitions={definitions} id={id} />
  return (
    <>
      <Heading title="Agents" detail="Agents in this project." />
      <Resource value={definitions}>
        {(d) =>
          d.agents.length ? (
            <ul className="entity-list entity-list--full">
              {d.agents.map((name) => (
                <li key={name}>
                  <a href={`/agents/${name}`}>
                    <Bot size={18} aria-hidden="true" />
                    <span>{name}</span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No agents in this project.</Empty>
          )
        }
      </Resource>
    </>
  )
}
function AgentDetail({ definitions, id }: { definitions: Result<Definitions>; id: string }) {
  const calls = useApi<AgentCallRow[]>(`/api/agents/${id}/calls`)
  return (
    <>
      <Heading title={id} parent={{ href: "/agents", label: "Agents" }} />
      <Resource value={definitions}>
        {(d) =>
          d.agents.includes(id) ? (
            <>
              {d.connections?.includes("codex") && d.modelConfigurableAgents?.includes(id) && (
                <section className="plain-section">
                  <CodexModelPicker agentId={id} />
                </section>
              )}
              <section className="plain-section">
                <div className="section-heading">
                  <h2>Workflow calls</h2>
                  <span className="muted">Latest 50</span>
                </div>
                <Resource value={calls}>
                  {(rows) =>
                    rows.length ? (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th scope="col">Run</th>
                              <th scope="col">Workflow</th>
                              <th scope="col">Instance</th>
                              <th scope="col">Step</th>
                              <th scope="col">Call</th>
                              <th scope="col">Started</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((call) => (
                              <tr key={call.id}>
                                <td>
                                  <a className="run-link mono" href={`/runs/${call.run_id}`} title={call.run_id}>
                                    {short(call.run_id)}
                                  </a>
                                </td>
                                <td>
                                  <a href={`/workflows/${call.workflow_id}`}>{call.workflow_id}</a>
                                </td>
                                <td>{call.instance_name}</td>
                                <td>{label(call.step_id)}</td>
                                <td>
                                  <Status value={call.status} />
                                </td>
                                <td className="muted">
                                  <time dateTime={new Date(call.started_at).toISOString()}>
                                    {date(call.started_at)}
                                  </time>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty>No workflow-mediated calls to this agent have been recorded yet.</Empty>
                    )
                  }
                </Resource>
                <p className="scope-note">
                  Only calls made through workflow execution since this index was introduced appear here. Direct agent
                  sessions are not included.
                </p>
              </section>
            </>
          ) : (
            <Empty>This agent isn’t in the current project.</Empty>
          )
        }
      </Resource>
    </>
  )
}
function graphLayout(manifest: Manifest) {
  const vertices = [
    ...manifest.triggers.map((trigger) => ({
      id: trigger.id,
      title: label(trigger.id),
      subtitle: `${trigger.kind} trigger`,
      trigger: true,
    })),
    ...manifest.tasks.map((task) => ({
      id: task.stepId,
      title: task.description && !task.description.startsWith("clankwerk://") ? task.description : label(task.id),
      subtitle: "Step",
      trigger: false,
    })),
  ]
  const ids = new Set(vertices.map((v) => v.id))
  const edges = manifest.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
  const depth = new Map(vertices.map((vertex) => [vertex.id, 0]))
  for (let i = 0; i < vertices.length; i++) {
    let changed = false
    for (const edge of edges) {
      const next = Math.min(vertices.length, (depth.get(edge.from) ?? 0) + 1)
      if (next > (depth.get(edge.to) ?? 0)) {
        depth.set(edge.to, next)
        changed = true
      }
    }
    if (!changed) break
  }
  // A malformed cyclic definition must not grow the diagram indefinitely.
  const placed = vertices.map((vertex) => ({ ...vertex, col: depth.get(vertex.id) ?? 0, row: 0 }))
  const counts = new Map<number, number>()
  for (const vertex of placed) {
    vertex.row = counts.get(vertex.col) ?? 0
    counts.set(vertex.col, vertex.row + 1)
  }
  const coords = new Map(placed.map((v) => [v.id, { x: v.col * 254, y: v.row * 106 }]))
  const width = Math.max(200, Math.max(0, ...placed.map((v) => v.col)) * 254 + 200)
  const height = Math.max(76, Math.max(...placed.map((v) => v.row), 0) * 106 + 76)
  return { vertices: placed, edges, coords, width, height }
}
type FlowNode = Node<{ title: string; subtitle: string; trigger: boolean }, "workflow">
function WorkflowNode({ data }: NodeProps<FlowNode>) {
  return (
    <div className={`graph-node${data.trigger ? " graph-node--trigger" : ""}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <strong title={data.title}>{data.title}</strong>
      <span>{data.subtitle}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}
const graphNodeTypes = { workflow: WorkflowNode }
function WorkflowGraph({ manifest }: { manifest: Manifest }) {
  const { vertices, edges, coords } = useMemo(() => graphLayout(manifest), [manifest])
  const nodes: FlowNode[] = vertices.map((vertex) => ({
    id: vertex.id,
    type: "workflow",
    position: coords.get(vertex.id)!,
    data: { title: vertex.title, subtitle: vertex.subtitle, trigger: vertex.trigger },
    draggable: false,
    ariaLabel: `${vertex.title}, ${vertex.subtitle}`,
  }))
  const connections: Edge[] = edges.map((edge, index) => ({
    id: `${edge.from}:${edge.to}:${index}`,
    source: edge.from,
    target: edge.to,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    className: edge.kind === "trigger" ? "graph-edge--trigger" : undefined,
  }))
  return (
    <section className="plain-section">
      <div className="section-heading">
        <h2>Workflow graph</h2>
        <span className="muted">{plural(manifest.tasks.length, "step")}</span>
      </div>
      {vertices.length ? (
        <div
          className="graph-canvas"
          role="region"
          aria-label="Workflow graph. Drag to pan; use the controls to zoom or fit."
          tabIndex={0}
        >
          <ReactFlow
            nodes={nodes}
            edges={connections}
            nodeTypes={graphNodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={true}
            zoomOnScroll={false}
            panOnScroll
            panOnDrag
            minZoom={0.4}
            maxZoom={1.8}
            defaultViewport={{ x: 26, y: 112, zoom: 0.85 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1} />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        </div>
      ) : (
        <Empty>This workflow has no steps.</Empty>
      )}
      <p className="scope-note">
        Current deployed definition; older runs may have used another version.
        {manifest.triggers.length > 0 && " Graph triggers are source-declared; check Triggers for active entrypoints."}
      </p>
      {edges.length < manifest.edges.length && (
        <p className="scope-note">Some connections in this definition do not map to visible steps.</p>
      )}
      {edges.length > 0 && (
        <ul className="sr-only">
          {edges.map((edge, i) => (
            <li key={i}>
              {label(edge.from)} leads to {label(edge.to)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
function Workflows({
  definitions,
  runs,
  id,
}: {
  definitions: Result<Definitions>
  runs: Result<RunRow[]>
  id?: string
}) {
  if (id) return <WorkflowDetail definitions={definitions} id={id} />
  return (
    <>
      <Heading title="Workflows" detail="Definitions and their recent runs." />
      <Resource value={definitions}>
        {(d) =>
          d.workflows.length ? (
            <ul className="entity-list entity-list--full">
              {d.workflows.map((name) => (
                <li key={name}>
                  <a href={`/workflows/${name}`}>
                    <GitBranch size={18} aria-hidden="true" />
                    <span>{name}</span>
                    <small>
                      {runs.state === "ready"
                        ? plural(runs.data.filter((r) => r.workflow_id === name).length, "run") + " in latest 50"
                        : "Workflow"}
                    </small>
                    <ArrowRight size={16} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No workflows in this project.</Empty>
          )
        }
      </Resource>
    </>
  )
}
function WorkflowDetail({ definitions, id }: { definitions: Result<Definitions>; id: string }) {
  const cursor = new URLSearchParams(location.search).get("cursor")
  const invocationsTab = new URLSearchParams(location.search).get("tab") === "invocations"
  const manifest = useApi<Manifest>(invocationsTab ? null : `/api/workflows/${id}/manifest`)
  const metrics = useApi<WorkflowMetrics>(invocationsTab ? null : `/api/workflows/${id}/metrics`)
  const invocations = useApi<InvocationPage>(
    invocationsTab ? `/api/workflows/${id}/invocations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}` : null,
  )
  return (
    <>
      <Heading title={id} parent={{ href: "/workflows", label: "Workflows" }} />
      <Resource value={definitions}>
        {(d) =>
          d.workflows.includes(id) ? (
            <>
              <nav className="workflow-tabs" aria-label="Workflow views">
                <a href={`/workflows/${id}`} aria-current={!invocationsTab ? "page" : undefined}>
                  Overview
                </a>
                <a href={`/workflows/${id}?tab=invocations`} aria-current={invocationsTab ? "page" : undefined}>
                  Invocations
                </a>
              </nav>
              {invocationsTab ? (
                <section className="plain-section">
                  <div className="section-heading">
                    <h2>Invocations</h2>
                    <span className="muted">25 per page · newest first</span>
                  </div>
                  <Resource value={invocations}>
                    {(page) => (
                      <>
                        <RunTable runs={page.items} workflowColumn={false} />
                        <nav className="invocation-pagination" aria-label="Invocation pages">
                          {cursor && <a href={`/workflows/${id}?tab=invocations`}>Back to newest</a>}
                          {page.nextCursor && (
                            <a href={`/workflows/${id}?tab=invocations&cursor=${encodeURIComponent(page.nextCursor)}`}>
                              Older invocations <ArrowRight size={14} aria-hidden="true" />
                            </a>
                          )}
                        </nav>
                      </>
                    )}
                  </Resource>
                </section>
              ) : (
                <>
                  <Resource value={manifest}>{(m) => <WorkflowGraph manifest={m} />}</Resource>
                  <section className="plain-section">
                    <div className="section-heading">
                      <h2>Activity</h2>
                      <span className="muted">Last 24 hours · indexed workflow starts</span>
                    </div>
                    <Resource value={metrics}>
                      {(m) => (
                        <>
                          <div className="workflow-metrics" aria-label="Workflow activity in the last 24 hours">
                            <div>
                              <strong>{m.total}</strong>
                              <span>Invocations</span>
                            </div>
                            <div>
                              <strong>{m.completed}</strong>
                              <span>Completed</span>
                            </div>
                            <div>
                              <strong>{m.failed}</strong>
                              <span>Failed</span>
                            </div>
                            <div>
                              <strong>{m.running}</strong>
                              <span>In progress</span>
                            </div>
                          </div>
                          {m.total > 0 ? (
                            <div
                              className="workflow-activity"
                              role="img"
                              aria-label={`${m.total} indexed workflow starts over the last 24 hours`}
                            >
                              {m.hourly.map(({ hour, count }) => (
                                <div
                                  key={hour}
                                  title={`${count} starts · ${date(hour)}`}
                                  style={{
                                    height: count
                                      ? `${Math.max(6, Math.round((count / Math.max(...m.hourly.map((item) => item.count))) * 52))}px`
                                      : "0px",
                                  }}
                                />
                              ))}
                            </div>
                          ) : (
                            <Empty>No invocations indexed in the last 24 hours.</Empty>
                          )}
                        </>
                      )}
                    </Resource>
                    <a className="more-link" href={`/workflows/${id}?tab=invocations`}>
                      Browse invocations <ArrowRight size={14} aria-hidden="true" />
                    </a>
                  </section>
                </>
              )}
            </>
          ) : (
            <Empty>This workflow isn’t in the current project.</Empty>
          )
        }
      </Resource>
    </>
  )
}
function eventName(type: string) {
  return type.replaceAll(".", " ")
}
function duration(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}
function RunDetail({ id }: { id: string }) {
  const value = useApi<Run>(`/api/runs/${id}`)
  return (
    <Resource value={value}>
      {(run) => {
        const started = run.events[0]?.at
        const ended = run.status === "completed" || run.status === "failed" ? run.events.at(-1)?.at : undefined
        return (
          <>
            <Heading
              title={`Run ${short(run.id)}`}
              parent={{ href: `/workflows/${run.workflowId}`, label: run.workflowId }}
            />
            <div className="run-context">
              <Status value={run.status} />
              {started !== undefined && (
                <span>
                  Started <time dateTime={new Date(started).toISOString()}>{date(started)}</time>
                </span>
              )}
              {started !== undefined && ended !== undefined && (
                <span>Elapsed {duration(Math.max(0, ended - started))}</span>
              )}
              {run.origin ? (
                <span>
                  Started via{" "}
                  <a className="inline-link" href={`/triggers/${run.origin.triggerId}`}>
                    {run.origin.triggerId}
                  </a>
                </span>
              ) : (
                <span>Origin not recorded</span>
              )}
            </div>
            <p className="full-id mono" title="Run ID">
              {run.id}
            </p>
            <div className="run-layout">
              <section className="plain-section">
                <div className="section-heading">
                  <h2>Steps</h2>
                  <span className="muted">{run.steps.length}</span>
                </div>
                {run.steps.length ? (
                  <div className="steps">
                    {run.steps.map((step) => {
                      const begin = run.events.find((e) => e.type === "step.started" && e.stepId === step.id)
                      const finish = run.events
                        .filter(
                          (e) => (e.type === "step.completed" || e.type === "step.failed") && e.stepId === step.id,
                        )
                        .at(-1)
                      return (
                        <article className="step" key={step.id}>
                          <div className="step-header">
                            <div>
                              <h3>{label(step.id)}</h3>
                              <span className="muted">
                                {plural(step.attempts, "attempt")}
                                {begin && finish ? ` · ${duration(Math.max(0, finish.at - begin.at))}` : ""}
                              </span>
                            </div>
                            <Status value={step.status} />
                          </div>
                          {step.error && <p className="step-error">{step.error}</p>}
                          {step.output !== undefined && (
                            <div className="output">
                              <span>Output</span>
                              <pre>{JSON.stringify(step.output, null, 2)}</pre>
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>
                ) : (
                  <Empty>No steps recorded.</Empty>
                )}
              </section>
              <section className="plain-section">
                <div className="section-heading">
                  <h2>Events</h2>
                  <span className="muted">{run.events.length}</span>
                </div>
                {run.events.length ? (
                  <ol className="events">
                    {run.events.map((event, i) => (
                      <li key={`${event.at}:${i}`}>
                        <div>
                          <strong>{eventName(event.type)}</strong>
                          {event.stepId && (
                            <span>
                              {label(event.stepId)}
                              {event.agentId ? ` · ${event.agentId}` : ""}
                            </span>
                          )}
                        </div>
                        <time dateTime={new Date(event.at).toISOString()} title={date(event.at)}>
                          {eventTime(event.at)}
                        </time>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <Empty>No events recorded for this run.</Empty>
                )}
                <p className="scope-note">These are recorded run and agent-call events, not OpenTelemetry spans.</p>
              </section>
            </div>
            <section className="plain-section run-agents">
              <div className="section-heading">
                <h2>Agent calls</h2>
                <span className="muted">{run.agentCalls?.length ?? 0}</span>
              </div>
              {run.agentCalls?.length ? (
                <ul className="call-list">
                  {run.agentCalls.map((call) => (
                    <li key={call.id}>
                      <a href={`/agents/${call.agentId}`}>{call.agentId}</a>
                      <span className="muted">
                        {call.instanceName} · {label(call.stepId)}
                      </span>
                      <Status value={call.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No agent calls recorded for this run.</Empty>
              )}
            </section>
          </>
        )
      }}
    </Resource>
  )
}
function Triggers({ id }: { id?: string }) {
  const value = useApi<TriggerDef[]>("/api/triggers")
  if (id) return <TriggerDetail id={id} definitions={value} />
  return (
    <>
      <Heading title="Triggers" detail="Entrypoints into your workflows." />
      <Resource value={value}>
        {(rows) =>
          rows.length ? (
            <ul className="entity-list entity-list--full">
              {rows.map((trigger) => (
                <li key={trigger.id}>
                  <a href={`/triggers/${trigger.id}`}>
                    <Webhook size={18} aria-hidden="true" />
                    <span>{trigger.id}</span>
                    <small>Access-protected API · {trigger.workflowId}</small>
                    <ArrowRight size={16} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No triggers configured.</Empty>
          )
        }
      </Resource>
      <p className="scope-note">
        The public trigger hostname has no enabled routes. Only accepted starts from configured entrypoints appear in
        history.
      </p>
    </>
  )
}
function TriggerDetail({ id, definitions }: { id: string; definitions: Result<TriggerDef[]> }) {
  const history = useApi<TriggerExecution[]>(`/api/triggers/${id}/executions`)
  return (
    <>
      <Heading title={id} parent={{ href: "/triggers", label: "Triggers" }} />
      <Resource value={definitions}>
        {(items) => {
          const trigger = items.find((item) => item.id === id)
          return trigger ? (
            <>
              <div className="trigger-summary">
                <span>Access-protected API</span>
                <span>
                  <a className="inline-link" href={`/workflows/${trigger.workflowId}`}>
                    {trigger.workflowId}
                  </a>
                </span>
                <code>POST {trigger.path}</code>
              </div>
              <section className="plain-section">
                <div className="section-heading">
                  <h2>Accepted starts</h2>
                  <span className="muted">Latest 50</span>
                </div>
                <Resource value={history}>
                  {(rows) =>
                    rows.length ? (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th scope="col">Run</th>
                              <th scope="col">Run status</th>
                              <th scope="col">Accepted</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((row) => (
                              <tr key={row.run_id}>
                                <td>
                                  <a className="run-link mono" href={`/runs/${row.run_id}`} title={row.run_id}>
                                    {short(row.run_id)}
                                  </a>
                                </td>
                                <td>
                                  <Status value={row.run_status} />
                                </td>
                                <td className="muted">
                                  <time dateTime={new Date(row.accepted_at).toISOString()}>
                                    {date(row.accepted_at)}
                                  </time>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty>No starts recorded for this entrypoint yet.</Empty>
                    )
                  }
                </Resource>
              </section>
              <p className="scope-note">
                History starts with this release and includes accepted requests only. Rejected requests and public
                webhooks are not recorded here.
              </p>
            </>
          ) : (
            <Empty>This entrypoint isn’t configured in this project.</Empty>
          )
        }}
      </Resource>
    </>
  )
}
function ConnectorsPage({ definitions }: { definitions: Result<Definitions> }) {
  return (
    <>
      <Heading title="Connectors" detail="Choose the services this project can use." />
      <Resource value={definitions}>
        {(d) => (
          <>
            {d.connections?.includes("codex") && (
              <section className="plain-section connector-section">
                <div className="section-heading">
                  <h2>ChatGPT / Codex</h2>
                  <span className="muted">Model provider</span>
                </div>
                <p>Connect your ChatGPT plan and choose an available model in Settings.</p>
                <a href="/settings" className="run-link">
                  Manage ChatGPT connection <ArrowRight size={15} aria-hidden="true" />
                </a>
              </section>
            )}
            {d.connections?.includes("github") && <GitHubConnectionSettings />}
            {!d.connections?.length && <Empty>No connectors are enabled for this project.</Empty>}
          </>
        )}
      </Resource>
    </>
  )
}
function SettingsPage({
  definitions,
  theme,
  setTheme,
}: {
  definitions: Result<Definitions>
  theme: Theme
  setTheme: (value: Theme) => void
}) {
  return (
    <>
      <Heading title="Settings" detail="Preferences for this dashboard and project connection." />
      <section className="settings-section">
        <h2>Appearance</h2>
        <p>Choose how this dashboard looks in this browser.</p>
        <fieldset className="theme-options">
          <legend>Theme</legend>
          {(["light", "dark", "auto"] as const).map((option) => (
            <label key={option} className={theme === option ? "theme-option theme-option--selected" : "theme-option"}>
              <input
                type="radio"
                name="theme"
                value={option}
                checked={theme === option}
                onChange={() => setTheme(option)}
              />
              <span>
                <strong>{option === "auto" ? "Auto" : option === "light" ? "Light" : "Dark"}</strong>
                {option === "auto" && <small>Follow system</small>}
              </span>
            </label>
          ))}
        </fieldset>
      </section>
      {definitions.state === "ready" && definitions.data.connections?.includes("codex") && <CodexConnectionSettings />}
      <section className="settings-section">
        <h2>Project</h2>
        <p>
          Project configuration is defined in your source and deployed with <code>cf deploy</code>.
        </p>
        <Resource value={definitions}>
          {(d) => (
            <dl className="settings-facts">
              <div>
                <dt>Project</dt>
                <dd>{d.project}</dd>
              </div>
              <div>
                <dt>Dashboard</dt>
                <dd>{d.adminHostname}</dd>
              </div>
              <div>
                <dt>Public trigger hostname</dt>
                <dd>
                  {d.triggerHostname} <span className="muted">· no routes enabled</span>
                </dd>
              </div>
            </dl>
          )}
        </Resource>
      </section>
    </>
  )
}
function Audit({ audit }: { audit: Result<AuditRow[]> }) {
  const [query, setQuery] = useState("")
  return (
    <>
      <Heading title="Audit log" detail="Recorded workflow activity." />
      <p className="scope-note scope-note--intro">
        Recorded run, step and workflow-mediated agent-call events only. Access, deployments and rejected requests
        aren’t in this log.
      </p>
      <section className="plain-section">
        <div className="section-heading">
          <h2>Events</h2>
          <label className="filter">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Filter events</span>
            <input type="search" placeholder="Filter events" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>
        <Resource value={audit}>
          {(rows) => {
            const filtered = rows.filter((r) =>
              `${r.type} ${r.run_id} ${r.step_id ?? ""}`.toLowerCase().includes(query.toLowerCase()),
            )
            return filtered.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Event</th>
                      <th scope="col">Run</th>
                      <th scope="col">Step</th>
                      <th scope="col">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.id}>
                        <td>{eventName(r.type)}</td>
                        <td>
                          <a className="run-link mono" href={`/runs/${r.run_id}`} title={r.run_id}>
                            {short(r.run_id)}
                          </a>
                        </td>
                        <td className="muted">{r.step_id ? label(r.step_id) : "—"}</td>
                        <td className="muted">
                          <time dateTime={new Date(r.at).toISOString()}>{date(r.at)}</time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>{query ? "No events match that filter." : "No events recorded yet."}</Empty>
            )
          }}
        </Resource>
      </section>
      <p className="scope-note">Showing up to 100 recent indexed events. The index may lag an individual run.</p>
    </>
  )
}
function App() {
  const path = location.pathname
  const [theme, setTheme] = useState<Theme>(() => {
    const value = stored("clankwerk.theme", "auto")
    return value === "light" || value === "dark" ? value : "auto"
  })
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const resolved = theme === "auto" ? (media.matches ? "dark" : "light") : theme
      document.documentElement.dataset.theme = resolved
      document.documentElement.style.colorScheme = resolved
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", resolved === "dark" ? "#121a22" : "#ffffff")
    }
    apply()
    try {
      localStorage.setItem("clankwerk.theme", theme)
    } catch {
      /* Ephemeral preference. */
    }
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [theme])
  const definitions = useApi<Definitions>("/api/definitions")
  const runs = useApi<RunRow[]>(path === "/" || path.startsWith("/workflows") ? "/api/runs" : null)
  const audit = useApi<AuditRow[]>(path === "/observability/audit" ? "/api/audit" : null)
  const project = definitions.state === "ready" ? definitions.data.project : "Project"
  const runId = /^\/runs\/([0-9a-f-]+)$/.exec(path)?.[1]
  const agentId = /^\/agents\/([a-z][a-z0-9-]*)$/.exec(path)?.[1]
  const workflowId = /^\/workflows\/([a-z][a-z0-9-]*)$/.exec(path)?.[1]
  const triggerId = /^\/triggers\/([a-z][a-z0-9-]*)$/.exec(path)?.[1]
  return (
    <Shell project={project} definitions={definitions}>
      {runId ? (
        <RunDetail id={runId} />
      ) : path === "/agents" || agentId ? (
        <Agents definitions={definitions} id={agentId} />
      ) : path === "/workflows" || workflowId ? (
        <Workflows definitions={definitions} runs={runs} id={workflowId} />
      ) : path === "/triggers" || triggerId ? (
        <Triggers id={triggerId} />
      ) : path === "/settings" ? (
        <SettingsPage definitions={definitions} theme={theme} setTheme={setTheme} />
      ) : path === "/connectors" ? (
        <ConnectorsPage definitions={definitions} />
      ) : path === "/observability/audit" ? (
        <Audit audit={audit} />
      ) : (
        <Home definitions={definitions} runs={runs} />
      )}
    </Shell>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
