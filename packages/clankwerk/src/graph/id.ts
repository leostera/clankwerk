declare const opaque: unique symbol
export type Opaque<T, Brand extends string> = T & { readonly [opaque]: Brand }
export type NodeId = Opaque<string, "NodeId">
export type TriggerId = Opaque<string, "TriggerId">
export type RunId = Opaque<string, "RunId">
export type WorkflowId = Opaque<string, "WorkflowId">
export type AgentId = Opaque<string, "AgentId">
export type DefinitionId = NodeId | TriggerId | WorkflowId | AgentId
export type DefinitionKind = "node" | "trigger" | "workflow" | "agent"

export const Id = {
  node: (value: string): NodeId => definition("node", value) as NodeId,
  trigger: (value: string): TriggerId => definition("trigger", value) as TriggerId,
  workflow: (value: string): WorkflowId => definition("workflow", value) as WorkflowId,
  agent: (value: string): AgentId => definition("agent", value) as AgentId,
  nodeFromTrigger: (trigger: TriggerId): NodeId => definition("node", Id.name(trigger)) as NodeId,
  childNode: (parent: NodeId, child: string): NodeId => definition("node", `${Id.name(parent)}/${child}`) as NodeId,
  name: (value: DefinitionId): string => parse(value).name,
  run: (): RunId => crypto.randomUUID() as RunId,
}

function definition(kind: DefinitionKind, value: string): DefinitionId {
  if (value.startsWith("clankwerk://")) {
    const parsed = parse(value)
    if (parsed.kind !== kind) throw new Error(`Expected a clankwerk ${kind} ID, received ${parsed.kind}`)
    return value as DefinitionId
  }
  const name = normalize(value)
  return `clankwerk://${kind}/${name.split("/").map(encodeURIComponent).join("/")}` as DefinitionId
}

function parse(value: string): { kind: DefinitionKind; name: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid Clankwerk ID: ${value}`)
  }
  if (
    url.protocol !== "clankwerk:" ||
    !["node", "trigger", "workflow", "agent"].includes(url.hostname) ||
    url.search ||
    url.hash
  )
    throw new Error(`Invalid Clankwerk ID: ${value}`)
  let name: string
  try {
    name = normalize(url.pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/"))
  } catch {
    throw new Error(`Invalid Clankwerk ID: ${value}`)
  }
  return { kind: url.hostname as DefinitionKind, name }
}

function normalize(value: string): string {
  const segments = value.split("/").filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".."))
    throw new Error(`Invalid Clankwerk name: ${value}`)
  return segments.join("/")
}
