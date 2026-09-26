import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Schema } from "effect";
import { useEffect, useState } from "react";
const Run = Schema.Struct({ id: Schema.String, status: Schema.String, createdAt: Schema.Number });
const Workflow = Schema.Struct({
    workflowId: Schema.String,
    definitionHash: Schema.String,
    triggers: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.optional(Schema.String) })),
});
/** React operational dashboard. It only reads and operates on existing runs. */
export const Dashboard = ({ apiBase = "/api" }) => {
    const [runs, setRuns] = useState([]);
    const [workflows, setWorkflows] = useState([]);
    const [input, setInput] = useState('{"url":"https://example.com"}');
    const triggerRun = async (triggerId) => {
        await fetch(`${apiBase}/triggers/${encodeURIComponent(triggerId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: input,
        });
        setInput("{}");
    };
    useEffect(() => {
        const load = async () => {
            const value = await fetch(`${apiBase}/runs`).then((response) => response.json());
            setRuns(await Schema.decodeUnknownPromise(Schema.Array(Run))(value));
            const workflowValue = await fetch(`${apiBase}/workflows`).then((response) => response.json());
            setWorkflows(await Schema.decodeUnknownPromise(Schema.Array(Workflow))(workflowValue));
        };
        void load();
        const timer = setInterval(load, 5000);
        return () => clearInterval(timer);
    }, [apiBase]);
    const latestWorkflows = [...workflows]
        .reverse()
        .filter((workflow, index, all) => index === all.findIndex((item) => item.workflowId === workflow.workflowId));
    return (_jsxs("main", { children: [_jsxs("header", { children: [_jsx("h1", { children: "LibClank" }), _jsx("p", { children: "Workflow operations" })] }), _jsxs("section", { children: [_jsx("h2", { children: "Registered workflows" }), latestWorkflows.map((workflow) => (_jsxs("article", { children: [_jsx("strong", { children: workflow.workflowId }), workflow.triggers.map((triggerDef) => (_jsx("button", { onClick: () => triggerRun(triggerDef.id), children: "Start" }, triggerDef.id)))] }, `${workflow.workflowId}:${workflow.definitionHash}`))), _jsx("textarea", { value: input, onChange: (event) => setInput(event.target.value), "aria-label": "Trigger input" })] }), _jsxs("section", { children: [_jsx("h2", { children: "Runs" }), runs.length === 0 ? (_jsx("p", { children: "No runs yet." })) : (_jsx("ul", { children: runs.map((run) => (_jsxs("li", { children: [_jsx("strong", { children: run.status }), " ", _jsx("a", { href: `#/runs/${encodeURIComponent(run.id)}`, children: _jsx("code", { children: run.id }) }), _jsx("time", { children: new Date(run.createdAt).toLocaleString() })] }, run.id))) }))] })] }));
};