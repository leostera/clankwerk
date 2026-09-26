import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Schema } from "effect";
import { useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
const Run = Schema.Struct({ id: Schema.String, workflowDefinitionHash: Schema.String, status: Schema.String });
const Task = Schema.Struct({
    id: Schema.String,
    stepId: Schema.optional(Schema.String),
    description: Schema.String,
    dependencies: Schema.Array(Schema.String),
});
const Trigger = Schema.Struct({ id: Schema.String, kind: Schema.String, path: Schema.optional(Schema.String) });
const Edge = Schema.Struct({ from: Schema.String, to: Schema.String, kind: Schema.String });
const Manifest = Schema.Struct({
    workflowId: Schema.String,
    definitionHash: Schema.String,
    triggers: Schema.Array(Trigger),
    tasks: Schema.Array(Task),
    edges: Schema.optional(Schema.Array(Edge)),
});
const Instance = Schema.Struct({ nodeId: Schema.String, status: Schema.String, attempt: Schema.Number });
const Event = Schema.Struct({
    type: Schema.String,
    nodeId: Schema.optional(Schema.String),
    attempt: Schema.optional(Schema.Number),
    error: Schema.optional(Schema.Unknown),
    output: Schema.optional(Schema.Unknown),
});
/** React Flow execution graph. It is read-only and reflects persisted node state. */
export const RunGraph = ({ runId, apiBase = "/api" }) => {
    const [run, setRun] = useState();
    const [manifest, setManifest] = useState();
    const [instances, setInstances] = useState([]);
    const [events, setEvents] = useState([]);
    useEffect(() => {
        const load = async () => {
            const [runValue, nodesValue, eventsValue, workflowsValue] = await Promise.all([
                fetch(`${apiBase}/runs/${encodeURIComponent(runId)}`).then((response) => response.json()),
                fetch(`${apiBase}/runs/${encodeURIComponent(runId)}/nodes`).then((response) => response.json()),
                fetch(`${apiBase}/runs/${encodeURIComponent(runId)}/events`).then((response) => response.json()),
                fetch(`${apiBase}/workflows`).then((response) => response.json()),
            ]);
            const nextRun = await Schema.decodeUnknownPromise(Run)(runValue);
            const nextInstances = await Schema.decodeUnknownPromise(Schema.Array(Instance))(nodesValue);
            const nextEvents = await Schema.decodeUnknownPromise(Schema.Array(Event))(eventsValue);
            const workflows = await Schema.decodeUnknownPromise(Schema.Array(Manifest))(workflowsValue);
            setRun(nextRun);
            setInstances(nextInstances);
            setEvents(nextEvents);
            setManifest(workflows.find((item) => item.definitionHash === nextRun.workflowDefinitionHash));
        };
        void load();
        const timer = setInterval(load, 2000);
        return () => clearInterval(timer);
    }, [apiBase, runId]);
    const nodes = useMemo(() => {
        if (!manifest)
            return [];
        const triggerNodes = manifest.triggers.map((trigger) => ({
            id: `trigger:${trigger.id}`,
            data: { label: `⚡ ${trigger.kind}\n${trigger.path ?? trigger.id}` },
            style: { borderColor: "#7c3aed", whiteSpace: "pre-line" },
        }));
        const taskNodes = manifest.tasks.map((task) => {
            const instance = instances.find((item) => item.nodeId === task.id || item.nodeId === task.stepId);
            return {
                id: task.stepId ?? task.id,
                data: { label: `${task.description}\n${instance?.status ?? "pending"} · attempt ${instance?.attempt ?? 0}` },
                style: { whiteSpace: "pre-line", borderColor: color(instance?.status) },
            };
        });
        const all = [...triggerNodes, ...taskNodes];
        const manifestEdges = manifest.edges ?? [];
        const levels = new Map();
        const levelOf = (id, visiting = new Set()) => {
            if (levels.has(id))
                return levels.get(id);
            if (visiting.has(id))
                return 0;
            visiting.add(id);
            const parents = manifestEdges.filter((edge) => (edge.kind === "trigger" ? `trigger:${edge.from}` : edge.from) !== id && edge.to === id);
            const level = parents.length === 0
                ? 0
                : Math.max(...parents.map((edge) => levelOf(edge.kind === "trigger" ? `trigger:${edge.from}` : edge.from, visiting) + 1));
            levels.set(id, level);
            return level;
        };
        for (const node of all)
            levelOf(node.id);
        const rows = new Map();
        for (const node of all) {
            const level = levels.get(node.id) ?? 0;
            rows.set(level, (rows.get(level) ?? 0) + 1);
        }
        const offsets = new Map();
        return all.map((node) => {
            const level = levels.get(node.id) ?? 0;
            const row = offsets.get(level) ?? 0;
            offsets.set(level, row + 1);
            const count = rows.get(level) ?? 1;
            return { ...node, position: { x: (row - (count - 1) / 2) * 320, y: level * 170 } };
        });
    }, [instances, manifest]);
    const edges = useMemo(() => (manifest?.edges ?? []).map((edge) => ({
        id: `${edge.from}->${edge.to}`,
        source: edge.kind === "trigger" ? `trigger:${edge.from}` : edge.from,
        target: manifest?.tasks.find((task) => task.id === edge.to)?.stepId ?? edge.to,
        animated: instances.find((item) => item.nodeId === edge.to)?.status === "running",
    })), [instances, manifest]);
    if (!run || !manifest)
        return _jsx("p", { children: "Loading run graph\u2026" });
    return (_jsxs("section", { children: [_jsxs("h2", { children: ["Run ", run.id] }), _jsxs("p", { children: ["Status: ", run.status] }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 16, height: 600 }, children: [_jsxs(ReactFlow, { nodes: nodes, edges: edges, fitView: true, children: [_jsx(Background, {}), _jsx(Controls, {})] }), _jsxs("aside", { style: { overflow: "auto", borderLeft: "1px solid #ddd", paddingLeft: 16 }, children: [_jsx("h3", { children: "Run logs" }), events.length === 0 ? (_jsx("p", { children: "No events yet." })) : (events.map((event, index) => (_jsxs("article", { style: { marginBottom: 12 }, children: [_jsx("strong", { children: event.type }), event.nodeId && (_jsx("div", { children: _jsx("code", { children: event.nodeId }) })), event.error !== undefined && _jsx("pre", { children: JSON.stringify(event.error, null, 2) }), event.output !== undefined && _jsx("pre", { children: JSON.stringify(event.output, null, 2) })] }, `${event.type}:${index}`))))] })] })] }));
};
function color(status) {
    return status === "completed"
        ? "#16a34a"
        : status === "failed"
            ? "#dc2626"
            : status === "running"
                ? "#2563eb"
                : "#9ca3af";
}